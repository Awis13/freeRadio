/**
 * ptt.js — Push-to-Talk (PTT) UI for the STUDIO 23 / FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js PTT refactor). Owns
 * the push-to-talk recorder cluster: the status FSM (pttSetStatus), reset /
 * waveform helpers, live mic capture (getUserMedia / MediaRecorder / AudioContext),
 * the preview send (POST /api/voice/send) and the duck/gain config load + save
 * (GET / POST /api/voice/config). All PTT module-scope state and DOM refs that
 * formerly lived in the app.js closure now live here.
 *
 * Dependency injection: `init(deps)` receives the host services (authFetch, log,
 * showError). pttFormatTime is taken from window.FRUtils (loaded before this
 * file). All PTT DOM nodes are resolved via document.getElementById inside init()
 * (post-deps), each null-guarded, and the former module-scope event bindings
 * (rec button hold/tap, play/discard/send buttons, settings toggle, duck/gain
 * sliders) are wired there too — so they run at boot exactly as the old closure
 * bindings did.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/ptt.js"> (attaches its public API to window.FRPtt) AND required
 * by the vitest suite via module.exports (CJS). It deliberately uses NO top-level
 * `export`/`import` so a browser <script> can load it without a SyntaxError.
 */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.FRPtt = api;
  }
})(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Module-owned state (moved out of app.js). The capture/recorder state plus
  // the settings-slider debounce handle.
  // -------------------------------------------------------------------------
  var pttStatus = 'idle'; // idle | recording | preview | sending | sent
  var pttMediaRecorder = null;
  var pttAudioChunks = [];
  var pttBlob = null;
  var pttBlobUrl = null;
  var pttStream = null;
  var pttAudioCtx = null;
  var pttAnalyser = null;
  var pttTimerInterval = null;
  var pttStartTime = 0;
  var pttAnimFrame = null;
  var pttHoldTimer = null;
  var pttIsHold = false;
  var pttPreviewAudio = null;
  var pttConfigDebounce = null;

  // -------------------------------------------------------------------------
  // PTT DOM refs (resolved in init via getElementById, each null-guarded).
  // -------------------------------------------------------------------------
  var pttBar = null;
  var pttLabel = null;
  var pttTimer = null;
  var pttWaveform = null;
  var pttRecBtn = null;
  var pttRecWrap = null;
  var pttPreview = null;
  var pttPlayBtn = null;
  var pttDiscardBtn = null;
  var pttSendBtn = null;
  var pttSettingsBtn = null;
  var pttConfig = null;
  var pttDuckSlider = null;
  var pttDuckValue = null;
  var pttGainSlider = null;
  var pttGainValue = null;

  // Injected host services (set by init).
  var deps = {
    authFetch: function () { return Promise.reject(new Error('FRPtt not initialised')); },
    log: function () {},
    showError: function () {},
  };

  // -------------------------------------------------------------------------
  // Helpers that resolve injected services at call time.
  // -------------------------------------------------------------------------
  function authFetch(url, opts) { return deps.authFetch(url, opts); }
  function log(msg) { return deps.log(msg); }
  function showError(msg) { return deps.showError(msg); }

  function pttFormatTime(ms) {
    return window.FRUtils.pttFormatTime(ms);
  }

  // -------------------------------------------------------------------------
  // Push-to-Talk (behaviour-identical to the former app.js functions).
  // -------------------------------------------------------------------------
  function pttSetStatus(status) {
    pttStatus = status;
    pttBar.className = 'ptt-bar' + (status !== 'idle' ? ' ' + status : '');

    if (status === 'idle') {
      pttLabel.textContent = 'Push to Talk';
      pttTimer.style.display = 'none';
    } else if (status === 'recording') {
      pttLabel.textContent = 'REC';
      pttTimer.style.display = 'inline';
    } else if (status === 'preview') {
      pttLabel.textContent = 'Preview';
      pttTimer.style.display = 'inline';
    } else if (status === 'sending') {
      pttLabel.textContent = 'Sending...';
    } else if (status === 'sent') {
      pttLabel.textContent = 'Sent';
      setTimeout(function() {
        if (pttStatus === 'sent') pttReset();
      }, 2000);
    }
  }

  function pttReset() {
    pttSetStatus('idle');
    pttAudioChunks = [];
    if (pttBlobUrl) { URL.revokeObjectURL(pttBlobUrl); pttBlobUrl = null; }
    pttBlob = null;
    if (pttStream) {
      pttStream.getTracks().forEach(function(t) { t.stop(); });
      pttStream = null;
    }
    if (pttAudioCtx) {
      pttAudioCtx.close().catch(function() {});
      pttAudioCtx = null;
      pttAnalyser = null;
    }
    if (pttTimerInterval) { clearInterval(pttTimerInterval); pttTimerInterval = null; }
    if (pttAnimFrame) { cancelAnimationFrame(pttAnimFrame); pttAnimFrame = null; }
    if (pttPreviewAudio) { pttPreviewAudio.pause(); pttPreviewAudio = null; }
    pttClearWaveform();
  }

  function pttClearWaveform() {
    var ctx = pttWaveform.getContext('2d');
    ctx.clearRect(0, 0, pttWaveform.width, pttWaveform.height);
  }

  function pttDrawWaveform() {
    if (pttStatus !== 'recording' || !pttAnalyser) return;
    var ctx = pttWaveform.getContext('2d');
    var w = pttWaveform.width;
    var h = pttWaveform.height;
    var bufLen = pttAnalyser.fftSize;
    var data = new Uint8Array(bufLen);
    pttAnalyser.getByteTimeDomainData(data);

    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c4ffcb';
    ctx.lineWidth = 1.5;

    var step = bufLen / w;
    for (var i = 0; i < w; i++) {
      var idx = Math.floor(i * step);
      var v = data[idx] / 128.0;
      var y = (v * h) / 2;
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.stroke();
    pttAnimFrame = requestAnimationFrame(pttDrawWaveform);
  }

  function pttDrawStaticWaveform(audioBuffer) {
    var ctx = pttWaveform.getContext('2d');
    var w = pttWaveform.width;
    var h = pttWaveform.height;
    var data = audioBuffer.getChannelData(0);

    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--text2').trim() || '#9fb6cc';
    ctx.lineWidth = 1.5;

    var step = data.length / w;
    for (var i = 0; i < w; i++) {
      var idx = Math.floor(i * step);
      var v = data[idx];
      var y = ((v + 1) * h) / 2;
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.stroke();
  }

  function pttStartRecording() {
    if (pttStatus === 'recording') return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('Microphone requires HTTPS. Open chrome://flags → "Insecure origins treated as secure" → add this URL');
      log('PTT: navigator.mediaDevices unavailable (insecure context)');
      return;
    }

    navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
      pttStream = stream;
      pttAudioChunks = [];

      // Setup analyser for waveform
      pttAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var source = pttAudioCtx.createMediaStreamSource(stream);
      pttAnalyser = pttAudioCtx.createAnalyser();
      pttAnalyser.fftSize = 256;
      source.connect(pttAnalyser);

      // Setup MediaRecorder
      var mimeType = 'audio/webm;codecs=opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/webm';
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';
      }
      var opts = mimeType ? { mimeType: mimeType } : {};
      pttMediaRecorder = new MediaRecorder(stream, opts);

      pttMediaRecorder.ondataavailable = function(e) {
        if (e.data.size > 0) pttAudioChunks.push(e.data);
      };

      pttMediaRecorder.onstop = function() {
        pttBlob = new Blob(pttAudioChunks, { type: pttMediaRecorder.mimeType || 'audio/webm' });
        pttBlobUrl = URL.createObjectURL(pttBlob);
        if (pttAnimFrame) { cancelAnimationFrame(pttAnimFrame); pttAnimFrame = null; }
        if (pttTimerInterval) { clearInterval(pttTimerInterval); pttTimerInterval = null; }

        // Draw static waveform from recorded audio
        var decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
        var reader = new FileReader();
        reader.onload = function() {
          decodeCtx.decodeAudioData(reader.result).then(function(buf) {
            pttDrawStaticWaveform(buf);
            decodeCtx.close();
          }).catch(function() { decodeCtx.close(); });
        };
        reader.readAsArrayBuffer(pttBlob);

        log('PTT: recorded ' + pttFormatTime(Date.now() - pttStartTime));
        pttSetStatus('preview');
      };

      pttMediaRecorder.start(100); // collect chunks every 100ms
      pttStartTime = Date.now();
      pttSetStatus('recording');
      log('PTT: recording started');

      // Timer
      pttTimerInterval = setInterval(function() {
        pttTimer.textContent = pttFormatTime(Date.now() - pttStartTime);
      }, 100);

      // Waveform animation
      pttDrawWaveform();

    }).catch(function(e) {
      showError('Microphone access denied');
      log('PTT: mic error — ' + e.message);
    });
  }

  function pttStopRecording() {
    if (pttStatus !== 'recording' || !pttMediaRecorder) return;
    pttMediaRecorder.stop();
    if (pttStream) {
      pttStream.getTracks().forEach(function(t) { t.stop(); });
      pttStream = null;
    }
  }

  function pttSend() {
    if (!pttBlob) return;
    pttSetStatus('sending');
    log('PTT: uploading...');

    var formData = new FormData();
    formData.append('audio', pttBlob, 'recording.webm');

    authFetch('/api/voice/send', { method: 'POST', body: formData })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          log('PTT: sent to air — ' + data.filename);
          pttSetStatus('sent');
        } else {
          showError('Voice send failed: ' + (data.error || 'unknown'));
          pttSetStatus('preview');
        }
      })
      .catch(function(e) {
        showError('Voice upload failed');
        log('PTT: upload error — ' + e.message);
        pttSetStatus('preview');
      });
  }

  // --- PTT button: hold-to-record + tap-to-toggle ---
  function pttDown(e) {
    e.preventDefault();
    if (pttStatus === 'idle') {
      pttIsHold = false;
      pttHoldTimer = setTimeout(function() { pttIsHold = true; }, 400);
      pttStartRecording();
    }
  }

  function pttUp(e) {
    e.preventDefault();
    if (pttHoldTimer) { clearTimeout(pttHoldTimer); pttHoldTimer = null; }
    if (pttStatus === 'recording') {
      if (pttIsHold) {
        // Hold mode: release stops recording
        pttStopRecording();
      }
      // Tap mode: first tap started, second tap will stop (handled by pttDown check)
    }
    pttIsHold = false;
  }

  function pttLoadConfig() {
    authFetch('/api/voice/config')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.duck !== undefined) {
          var duckPct = Math.round(data.duck * 100);
          pttDuckSlider.value = duckPct;
          pttDuckValue.textContent = duckPct + '%';
        }
        if (data.gain !== undefined) {
          var gainPct = Math.round(data.gain * 10);
          pttGainSlider.value = gainPct;
          pttGainValue.textContent = data.gain.toFixed(1) + 'x';
        }
      })
      .catch(function() {});
  }

  function pttSaveConfig() {
    var duck = parseInt(pttDuckSlider.value) / 100;
    var gain = parseInt(pttGainSlider.value) / 10;
    authFetch('/api/voice/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duck: duck, gain: gain })
    }).then(function(r) { return r.json(); }).then(function(data) {
      log('PTT: config updated — duck=' + (data.duck * 100).toFixed(0) + '% gain=' + data.gain.toFixed(1) + 'x');
    }).catch(function() {});
  }

  /**
   * Store injected dependencies, resolve the PTT DOM refs and wire the former
   * module-scope event bindings (rec button, play/discard/send, settings toggle,
   * duck/gain sliders). Each bind is null-guarded for a missing element. Safe to
   * call more than once (the vitest harness re-inits per test with its own deps).
   */
  function init(injected) {
    injected = injected || {};
    window.FRUtils.mergeDeps(deps, injected, 'FRPtt');

    // Resolve DOM refs (formerly module-scope getElementById in app.js).
    pttBar = document.getElementById('ptt-bar');
    pttLabel = document.getElementById('ptt-label');
    pttTimer = document.getElementById('ptt-timer');
    pttWaveform = document.getElementById('ptt-waveform');
    pttRecBtn = document.getElementById('ptt-rec-btn');
    pttRecWrap = document.getElementById('ptt-rec-wrap');
    pttPreview = document.getElementById('ptt-preview');
    pttPlayBtn = document.getElementById('ptt-play-btn');
    pttDiscardBtn = document.getElementById('ptt-discard-btn');
    pttSendBtn = document.getElementById('ptt-send-btn');
    pttSettingsBtn = document.getElementById('ptt-settings-btn');
    pttConfig = document.getElementById('ptt-config');
    pttDuckSlider = document.getElementById('ptt-duck-slider');
    pttDuckValue = document.getElementById('ptt-duck-value');
    pttGainSlider = document.getElementById('ptt-gain-slider');
    pttGainValue = document.getElementById('ptt-gain-value');

    // Bindings (relocated verbatim from the former app.js module-scope code).
    if (pttRecBtn) {
      // Desktop
      pttRecBtn.addEventListener('mousedown', pttDown);
      pttRecBtn.addEventListener('mouseup', pttUp);
      pttRecBtn.addEventListener('mouseleave', function(e) {
        if (pttStatus === 'recording' && pttIsHold) {
          pttUp(e);
        }
      });

      // Mobile
      pttRecBtn.addEventListener('touchstart', pttDown, { passive: false });
      pttRecBtn.addEventListener('touchend', pttUp, { passive: false });

      // Tap-to-toggle: if in recording state and it was a tap (not hold), stop on next click
      pttRecBtn.addEventListener('click', function(e) {
        if (pttStatus === 'recording' && !pttIsHold) {
          e.preventDefault();
          pttStopRecording();
        }
      });
    }

    // Preview: play
    if (pttPlayBtn) {
      pttPlayBtn.onclick = function() {
        if (!pttBlobUrl) return;
        if (pttPreviewAudio) { pttPreviewAudio.pause(); }
        pttPreviewAudio = new Audio(pttBlobUrl);
        pttPreviewAudio.play().catch(function() {});
      };
    }

    // Preview: discard
    if (pttDiscardBtn) {
      pttDiscardBtn.onclick = function() {
        log('PTT: discarded');
        pttReset();
      };
    }

    // Preview: send to air
    if (pttSendBtn) {
      pttSendBtn.onclick = function() {
        pttSend();
      };
    }

    // --- PTT Settings ---
    if (pttSettingsBtn) {
      pttSettingsBtn.onclick = function() {
        var visible = pttConfig.style.display !== 'none';
        pttConfig.style.display = visible ? 'none' : 'flex';
        pttSettingsBtn.classList.toggle('active', !visible);
        if (!visible) pttLoadConfig();
      };
    }

    if (pttDuckSlider) {
      pttDuckSlider.oninput = function() {
        pttDuckValue.textContent = pttDuckSlider.value + '%';
        clearTimeout(pttConfigDebounce);
        pttConfigDebounce = setTimeout(pttSaveConfig, 300);
      };
    }

    if (pttGainSlider) {
      pttGainSlider.oninput = function() {
        var gain = (parseInt(pttGainSlider.value) / 10).toFixed(1);
        pttGainValue.textContent = gain + 'x';
        clearTimeout(pttConfigDebounce);
        pttConfigDebounce = setTimeout(pttSaveConfig, 300);
      };
    }
  }

  return {
    init: init,
    pttSetStatus: pttSetStatus,
    pttReset: pttReset,
    pttClearWaveform: pttClearWaveform,
    pttDrawWaveform: pttDrawWaveform,
    pttDrawStaticWaveform: pttDrawStaticWaveform,
    pttStartRecording: pttStartRecording,
    pttStopRecording: pttStopRecording,
    pttSend: pttSend,
    pttDown: pttDown,
    pttUp: pttUp,
    pttLoadConfig: pttLoadConfig,
    pttSaveConfig: pttSaveConfig,
    getStatus: function () { return pttStatus; },
    setStatus: function (v) { pttStatus = v; },
    getBlob: function () { return pttBlob; },
    setBlob: function (v) { pttBlob = v; },
    getBlobUrl: function () { return pttBlobUrl; },
    setBlobUrl: function (v) { pttBlobUrl = v; },
    getIsHold: function () { return pttIsHold; },
    setIsHold: function (v) { pttIsHold = v; },
  };
});
