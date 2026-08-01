/**
 * mixer.js — Monitor Mixer (browser mic, faders, meters, auto-duck) and the
 * browser-mic streaming loop for the STUDIO 23 / FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C3 of the player/analyzer/mixer
 * refactor). Owns the mic capture graph, the monitor/duck state, the three
 * level meters and the chunked mic upload loop.
 *
 * DEAD IN PHASE 1. Every control this module binds to (#monitor-mixer and the
 * whole mm-* family) ships inside a PHASE 2 HTML comment, so all of the DOM
 * refs below resolve to null, none of the listeners bind, and startMic — the
 * only door into the mic graph, the meters and the auto-duck envelope — is
 * never called. The module is extracted AS-IS with that behaviour intact; the
 * absence pins in playerMixerAnalyzerUI.test.js are its coverage. Do not
 * "fix" a null guard here to make something reachable.
 *
 * OWNED STATE (all of it moved; nothing foreign was declared in this region):
 *   micStreaming, micStream, micRecorder, micAudioCtx, micSourceNode,
 *   micGainNode, micAnalyser, micMonitorNode, micMonitorActive, micActive,
 *   monitorMusicGain, mmMasterGain, mmMeterRAF, duckEnabled, duckAmountDb,
 *   duckMultiplier, duckSpeed, duckSpeeds, duckThreshold, duckActive, and the
 *   mm-* DOM refs.
 *
 * monitorMusicGain and mmMasterGain are read by FRAnalyzer.setPlayerMuted,
 * which drives the analyzer gain node from them, so they are exposed as live
 * getters (getMonitorMusicGain / getMasterGain) and that call site re-sources
 * through them rather than the module handing out a copy.
 *
 * DOM refs are resolved ONCE in init(), not at call time — app.js resolved them
 * at module scope and cached the result, so a Phase 1 boot caches null forever.
 * Resolving at call time would silently change behaviour if the Phase 2 markup
 * were ever uncommented at runtime, so the caching is preserved deliberately.
 *
 * Cross-slice work is injected rather than reached for: the analyzer graph
 * (getGainNode/getAudioCtx/getMainAnalyser) that the faders and the auto-duck
 * envelope drive, ensureAnalyzer for startMic's `if (!azInited) azInit()` hop
 * (same callback shape player.js uses), getStudioPlayer for the muted checks,
 * getBroadcastState for the streaming state machine, and authFetch/log/showError.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/mixer.js"> (attaches its public API to window.FRMixer) AND
 * required by the vitest suite via module.exports (CJS). It deliberately uses NO
 * top-level `export`/`import` so a browser <script> can load it without a
 * SyntaxError.
 */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.FRMixer = api;
  }
})(function () {
  'use strict';

  // Injected host services (set by init). Defaults keep a pre-init call inert.
  var deps = {
    log: function () {},
    showError: function () {},
    authFetch: function () { return Promise.reject(new Error('FRMixer not initialised')); },
    getStudioPlayer: function () { return null; },
    getBroadcastState: function () { return null; },
    getAudioCtx: function () { return null; },
    getGainNode: function () { return null; },
    getMainAnalyser: function () { return null; },
    ensureAnalyzer: function () {},
  };

  // Helpers that resolve injected services at call time.
  function log(msg) { return deps.log(msg); }
  function showError(msg) { return deps.showError(msg); }
  function authFetch(url, opts) { return deps.authFetch(url, opts); }
  function getStudioPlayer() { return deps.getStudioPlayer(); }
  function getBroadcastState() { return deps.getBroadcastState(); }
  function getAudioCtx() { return deps.getAudioCtx(); }
  function getGainNode() { return deps.getGainNode(); }
  function getMainAnalyser() { return deps.getMainAnalyser(); }
  function ensureAnalyzer() { return deps.ensureAnalyzer(); }

  // -------------------------------------------------------------------------
  // Module-owned state (moved from the app.js closure).
  // -------------------------------------------------------------------------
  var micStreaming = false;
  var micStream = null;
  var micRecorder = null;
  var micAudioCtx = null;
  var micSourceNode = null;
  var micGainNode = null;
  var micAnalyser = null;
  var micMonitorNode = null;
  var micMonitorActive = false;
  var micActive = false;

  // Monitor mixer state
  var monitorMusicGain = 1.0;   // Music fader (0-1), default 100%
  var mmMasterGain = 1.0;       // Master fader (0-1)
  var mmMeterRAF = null;
  var duckEnabled = false;
  var duckAmountDb = 12;
  var duckMultiplier = Math.pow(10, -12 / 20); // ~0.25
  var duckSpeed = 'medium';
  var duckSpeeds = {
    fast:   { attack: 0.02,  release: 0.15 },
    medium: { attack: 0.05,  release: 0.30 },
    slow:   { attack: 0.10,  release: 0.60 }
  };
  var duckThreshold = 0.05;     // RMS threshold for duck trigger
  var duckActive = false;       // Current state (music ducked or not)

  // DOM refs — Monitor Mixer, Faders, Meter canvases. Assigned once by
  // resolveDom() from init(), mirroring app.js's module-scope resolution.
  var mmPanel = null;
  var mmStatusBadge = null;
  var mmMicBtn = null;
  var mmMonBtn = null;
  var mmDuckBtn = null;
  var micInputSelect = null;
  var micOutputSelect = null;

  // Faders
  var mmMicFader = null;
  var mmMicVal = null;
  var mmMusicFader = null;
  var mmMusicVal = null;
  var mmMasterFader = null;
  var mmMasterVal = null;
  var mmDuckAmount = null;
  var mmDuckVal = null;
  var mmDuckSpeedSel = null;

  // Meter canvases
  var mmMicMeterCanvas = null;
  var mmMicMeterCtx = null;
  var mmMusicMeterCanvas = null;
  var mmMusicMeterCtx = null;
  var mmMasterMeterCanvas = null;
  var mmMasterMeterCtx = null;

  function resolveDom() {
    mmPanel = document.getElementById('monitor-mixer');
    mmStatusBadge = document.getElementById('mm-status-badge');
    mmMicBtn = document.getElementById('mm-mic-btn');
    mmMonBtn = document.getElementById('mm-mon-btn');
    mmDuckBtn = document.getElementById('mm-duck-btn');
    micInputSelect = document.getElementById('mic-input-select');
    micOutputSelect = document.getElementById('mic-output-select');

    // Faders
    mmMicFader = document.getElementById('mm-mic-fader');
    mmMicVal = document.getElementById('mm-mic-val');
    mmMusicFader = document.getElementById('mm-music-fader');
    mmMusicVal = document.getElementById('mm-music-val');
    mmMasterFader = document.getElementById('mm-master-fader');
    mmMasterVal = document.getElementById('mm-master-val');
    mmDuckAmount = document.getElementById('mm-duck-amount');
    mmDuckVal = document.getElementById('mm-duck-val');
    mmDuckSpeedSel = document.getElementById('mm-duck-speed');

    // Meter canvases
    mmMicMeterCanvas = document.getElementById('mm-mic-meter');
    mmMicMeterCtx = mmMicMeterCanvas ? mmMicMeterCanvas.getContext('2d') : null;
    mmMusicMeterCanvas = document.getElementById('mm-music-meter');
    mmMusicMeterCtx = mmMusicMeterCanvas ? mmMusicMeterCanvas.getContext('2d') : null;
    mmMasterMeterCanvas = document.getElementById('mm-master-meter');
    mmMasterMeterCtx = mmMasterMeterCanvas ? mmMasterMeterCanvas.getContext('2d') : null;
  }

  // Enumerate audio devices
  function enumerateMicDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function(devices) {
      var inputs = devices.filter(function(d) { return d.kind === 'audioinput'; });
      var outputs = devices.filter(function(d) { return d.kind === 'audiooutput'; });

      if (micInputSelect) {
        var curInput = micInputSelect.value;
        micInputSelect.innerHTML = '<option value="">Default</option>';
        inputs.forEach(function(d) {
          var opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || ('Mic ' + d.deviceId.slice(0, 6));
          micInputSelect.appendChild(opt);
        });
        if (curInput) micInputSelect.value = curInput;
      }

      if (micOutputSelect) {
        var curOutput = micOutputSelect.value;
        micOutputSelect.innerHTML = '<option value="">Default</option>';
        outputs.forEach(function(d) {
          var opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || ('Out ' + d.deviceId.slice(0, 6));
          micOutputSelect.appendChild(opt);
        });
        if (curOutput) micOutputSelect.value = curOutput;
      }
    });
  }

  // Enable microphone
  function startMic() {
    if (micActive) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('Mic unavailable (requires HTTPS)');
      return;
    }

    // Ensure azAudioCtx + azGainNode for music meter
    ensureAnalyzer();

    var constraints = { audio: true };
    var selectedInput = micInputSelect ? micInputSelect.value : '';
    if (selectedInput) {
      constraints.audio = { deviceId: { exact: selectedInput } };
    }

    navigator.mediaDevices.getUserMedia(constraints).then(function(stream) {
      micStream = stream;
      micActive = true;

      // AudioContext for monitoring and metering
      micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      micSourceNode = micAudioCtx.createMediaStreamSource(stream);
      micGainNode = micAudioCtx.createGain();
      micAnalyser = micAudioCtx.createAnalyser();
      micAnalyser.fftSize = 256;
      micAnalyser.smoothingTimeConstant = 0.8;

      // source -> gain -> analyser
      micSourceNode.connect(micGainNode);
      micGainNode.connect(micAnalyser);

      // Apply current gain from mic fader
      var gainVal = mmMicFader ? parseInt(mmMicFader.value) / 100 : 1;
      micGainNode.gain.value = gainVal;

      // Monitor node (muted by default — enabled via MON button)
      micMonitorNode = micAudioCtx.createGain();
      micMonitorNode.gain.value = micMonitorActive ? mmMasterGain : 0;
      micAnalyser.connect(micMonitorNode);
      micMonitorNode.connect(micAudioCtx.destination);

      // Output device
      applyMonitorOutput();

      // UI
      updateMonitorUI();
      startMonitorMeters();
      enumerateMicDevices(); // Refresh list (now with labels)

      log('monitor: mic started (input: ' + (selectedInput || 'default') + ')');
    }).catch(function(e) {
      showError('Mic access denied: ' + e.message);
      log('monitor: mic error — ' + e.message);
    });
  }

  // Disable microphone
  function stopMic() {
    micActive = false;
    micMonitorActive = false;

    // Stop streaming if active
    if (micStreaming) stopMicStreaming();

    if (mmMeterRAF) {
      cancelAnimationFrame(mmMeterRAF);
      mmMeterRAF = null;
    }
    if (micMonitorNode) { try { micMonitorNode.disconnect(); } catch(e) {} micMonitorNode = null; }
    if (micAnalyser) { try { micAnalyser.disconnect(); } catch(e) {} micAnalyser = null; }
    if (micGainNode) { try { micGainNode.disconnect(); } catch(e) {} micGainNode = null; }
    if (micSourceNode) { try { micSourceNode.disconnect(); } catch(e) {} micSourceNode = null; }
    if (micAudioCtx) { micAudioCtx.close().catch(function(){}); micAudioCtx = null; }
    if (micStream) { micStream.getTracks().forEach(function(t) { t.stop(); }); micStream = null; }

    // Release duck if active
    if (duckActive && getGainNode() && getAudioCtx() && !getStudioPlayer().muted) {
      getGainNode().gain.setTargetAtTime(monitorMusicGain * mmMasterGain, getAudioCtx().currentTime, 0.05);
      duckActive = false;
    }

    // Clear all meter canvases
    clearMeterCanvas(mmMicMeterCtx, mmMicMeterCanvas);
    clearMeterCanvas(mmMusicMeterCtx, mmMusicMeterCanvas);
    clearMeterCanvas(mmMasterMeterCtx, mmMasterMeterCanvas);

    updateMonitorUI();
    log('monitor: mic stopped');
  }

  function clearMeterCanvas(ctx, canvas) {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // MON — mic monitoring in headphones
  function toggleMicMonitor() {
    if (!micActive || !micMonitorNode) return;
    micMonitorActive = !micMonitorActive;
    micMonitorNode.gain.value = micMonitorActive ? mmMasterGain : 0;
    updateMonitorUI();
    log('monitor: mic listen ' + (micMonitorActive ? 'ON' : 'OFF'));
  }

  // Apply output device to both AudioContexts
  function applyMonitorOutput() {
    var outputId = micOutputSelect ? micOutputSelect.value : '';
    if (!outputId) return;
    // Mic AudioContext
    if (micAudioCtx && micAudioCtx.destination && micAudioCtx.destination.setSinkId) {
      micAudioCtx.destination.setSinkId(outputId).catch(function(e) {
        log('monitor: mic output error — ' + e.message);
      });
    }
    // Music AudioContext (analyzer)
    if (getAudioCtx() && getAudioCtx().setSinkId) {
      getAudioCtx().setSinkId(outputId).catch(function(e) {
        log('monitor: music output error — ' + e.message);
      });
    }
  }

  // Draw a single meter on canvas (reusable)
  function drawMeter(ctx, canvas, rms, peak) {
    if (!ctx || !canvas) return;
    var w = canvas.width;
    var h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, 0, w, h);
    // RMS bar
    var rmsW = rms * w;
    var grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#22c55e');
    grad.addColorStop(0.6, '#eab308');
    grad.addColorStop(0.85, '#ef4444');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, rmsW, h);
    // Peak indicator
    if (peak > 0.01) {
      var peakX = Math.min(peak * w, w - 2);
      ctx.fillStyle = peak > 0.85 ? '#ef4444' : '#fff';
      ctx.fillRect(peakX, 0, 2, h);
    }
  }

  // Compute RMS and peak from analyser data
  function computeLevels(analyser, dataArr) {
    if (!analyser) return { rms: 0, peak: 0 };
    analyser.getByteFrequencyData(dataArr);
    var sum = 0, peak = 0;
    for (var i = 0; i < dataArr.length; i++) {
      sum += dataArr[i] * dataArr[i];
      if (dataArr[i] > peak) peak = dataArr[i];
    }
    return {
      rms: Math.sqrt(sum / dataArr.length) / 255,
      peak: peak / 255
    };
  }

  // Combined meter loop + auto-duck
  function startMonitorMeters() {
    if (mmMeterRAF) cancelAnimationFrame(mmMeterRAF);
    var micData = micAnalyser ? new Uint8Array(micAnalyser.frequencyBinCount) : null;
    var musicData = getMainAnalyser() ? new Uint8Array(getMainAnalyser().frequencyBinCount) : null;

    function draw() {
      if (!micActive) return;
      mmMeterRAF = requestAnimationFrame(draw);

      var micLevel = { rms: 0, peak: 0 };
      var musicLevel = { rms: 0, peak: 0 };

      // MIC meter
      if (micAnalyser && micData) {
        micLevel = computeLevels(micAnalyser, micData);
        drawMeter(mmMicMeterCtx, mmMicMeterCanvas, micLevel.rms, micLevel.peak);
      }

      // MUSIC meter — read from azMain (main stream analyzer)
      if (getMainAnalyser() && musicData && !getStudioPlayer().muted) {
        musicLevel = computeLevels(getMainAnalyser(), musicData);
        var scaledRms = musicLevel.rms * monitorMusicGain;
        var scaledPeak = musicLevel.peak * monitorMusicGain;
        drawMeter(mmMusicMeterCtx, mmMusicMeterCanvas, scaledRms, scaledPeak);
      } else if (mmMusicMeterCtx && mmMusicMeterCanvas) {
        mmMusicMeterCtx.clearRect(0, 0, mmMusicMeterCanvas.width, mmMusicMeterCanvas.height);
        mmMusicMeterCtx.fillStyle = 'rgba(0,0,0,0.3)';
        mmMusicMeterCtx.fillRect(0, 0, mmMusicMeterCanvas.width, mmMusicMeterCanvas.height);
      }

      // MASTER meter — approximate sum (mic and music in separate contexts)
      var masterRms = Math.min(1, micLevel.rms + musicLevel.rms * monitorMusicGain * 0.7);
      var masterPeak = Math.min(1, Math.max(micLevel.peak, musicLevel.peak * monitorMusicGain));
      masterRms *= mmMasterGain;
      masterPeak *= mmMasterGain;
      drawMeter(mmMasterMeterCtx, mmMasterMeterCanvas, masterRms, masterPeak);

      // AUTO-DUCK — envelope follower via setTargetAtTime
      if (duckEnabled && micActive && getGainNode() && getAudioCtx() && !getStudioPlayer().muted) {
        var speeds = duckSpeeds[duckSpeed] || duckSpeeds.medium;
        if (micLevel.rms > duckThreshold) {
          // Voice detected — duck music
          if (!duckActive) {
            var duckedGain = monitorMusicGain * mmMasterGain * duckMultiplier;
            getGainNode().gain.setTargetAtTime(duckedGain, getAudioCtx().currentTime, speeds.attack);
            duckActive = true;
          }
        } else {
          // Voice gone — restore
          if (duckActive) {
            var normalGain = monitorMusicGain * mmMasterGain;
            getGainNode().gain.setTargetAtTime(normalGain, getAudioCtx().currentTime, speeds.release);
            duckActive = false;
          }
        }
      }
    }
    draw();
  }

  // Update Monitor Mixer UI elements
  function updateMonitorUI() {
    if (mmMicBtn) {
      mmMicBtn.textContent = micActive ? 'MIC OFF' : 'MIC ON';
      mmMicBtn.classList.toggle('active', micActive);
    }
    if (mmMonBtn) {
      mmMonBtn.classList.toggle('active', micMonitorActive);
      mmMonBtn.textContent = micMonitorActive ? 'MON ON' : 'MON';
    }
    if (mmStatusBadge) {
      if (micActive && micStreaming) {
        mmStatusBadge.textContent = 'ON AIR';
        mmStatusBadge.className = 'mm-status-badge on';
      } else if (micActive && micMonitorActive) {
        mmStatusBadge.textContent = 'MONITOR';
        mmStatusBadge.className = 'mm-status-badge monitoring';
      } else if (micActive) {
        mmStatusBadge.textContent = 'READY';
        mmStatusBadge.className = 'mm-status-badge monitoring';
      } else {
        mmStatusBadge.textContent = 'OFF';
        mmStatusBadge.className = 'mm-status-badge';
      }
    }
    if (mmPanel) {
      mmPanel.classList.toggle('mm-active', micActive);
    }
    if (mmDuckBtn) {
      mmDuckBtn.classList.toggle('active', duckEnabled);
      mmDuckBtn.textContent = duckEnabled ? 'DUCK ON' : 'DUCK';
    }
  }

  // -------------------------------------------------------------------------
  // Browser mic streaming (function declarations; hoisted in app.js too).
  // -------------------------------------------------------------------------
  // BROWSER MIC STREAMING — continuous chunks for Talk Over and Live/AFK
  // ============================================================

  function startMicStreaming() {
    if (micStreaming) return;
    if (!micStream) {
      log('mic streaming: no active mic stream');
      return;
    }
    micStreaming = true;

    var mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';
    }

    function startChunk() {
      if (!micStreaming || !micStream) return;
      micRecorder = new MediaRecorder(micStream, mimeType ? { mimeType: mimeType } : {});
      var chunks = [];
      micRecorder.ondataavailable = function(e) {
        if (e.data.size > 0) chunks.push(e.data);
      };
      micRecorder.onstop = function() {
        if (chunks.length === 0 || !micStreaming) return;
        var blob = new Blob(chunks, { type: micRecorder.mimeType || 'audio/webm' });
        var formData = new FormData();
        formData.append('audio', blob, 'mic_chunk.webm');
        authFetch('/api/voice/send', { method: 'POST', body: formData }).catch(function() {});
        if (micStreaming) startChunk();
      };
      micRecorder.start();
      setTimeout(function() {
        if (micRecorder && micRecorder.state === 'recording') {
          micRecorder.stop();
        }
      }, 5000);
    }

    startChunk();
    updateMonitorUI();
    log('mic: streaming started');
  }

  function stopMicStreaming() {
    micStreaming = false;
    if (micRecorder && micRecorder.state === 'recording') {
      micRecorder.stop();
    }
    micRecorder = null;
    updateMonitorUI();
    log('mic: streaming stopped');
  }

  // Auto-start/stop streaming: when mic ON + stream is on air
  function checkMicStreaming() {
    var isTalkover = getBroadcastState().uiMode === 'talkover';
    var isLiveBrowserMic = getBroadcastState().visualMode === 'live' &&
                           getBroadcastState().liveMode.source === 'browser-mic';
    var isOnAir = getBroadcastState().streamMode === 'live' || getBroadcastState().streamMode === 'armed';

    // Stream if: (talkover + mic on + on air) OR (live/browser-mic + on air)
    var shouldStream = (isTalkover && micActive && isOnAir) ||
                       (isLiveBrowserMic && isOnAir && micActive);

    if (shouldStream && !micStreaming) {
      startMicStreaming();
    } else if (!shouldStream && micStreaming) {
      stopMicStreaming();
    }
  }

  /**
   * Store injected dependencies, then run the boot side-effects in the exact
   * order they ran as module-scope statements in app.js: resolve the DOM refs,
   * bind the control listeners under their original `if (element)` guards,
   * enumerate devices, then start the 2s mic-streaming check.
   */
  function init(injected) {
    injected = injected || {};
    for (var k in deps) {
      if (Object.prototype.hasOwnProperty.call(injected, k)) {
        deps[k] = injected[k];
      }
    }
    resolveDom();
    bindControls();
    // Check mic streaming state periodically
    setInterval(checkMicStreaming, 2000);
  }

  function bindControls() {
    // Event handlers — Monitor Mixer
    if (mmMicBtn) {
      mmMicBtn.addEventListener('click', function() {
        if (micActive) { stopMic(); } else { startMic(); }
      });
    }

    if (mmMonBtn) {
      mmMonBtn.addEventListener('click', function() {
        toggleMicMonitor();
      });
    }

    if (mmDuckBtn) {
      mmDuckBtn.addEventListener('click', function() {
        duckEnabled = !duckEnabled;
        // Release duck if disabling
        if (!duckEnabled && duckActive && getGainNode() && getAudioCtx() && !getStudioPlayer().muted) {
          getGainNode().gain.setTargetAtTime(monitorMusicGain * mmMasterGain, getAudioCtx().currentTime, 0.05);
          duckActive = false;
        }
        updateMonitorUI();
        log('monitor: duck ' + (duckEnabled ? 'ON (-' + duckAmountDb + 'dB)' : 'OFF'));
      });
    }

    // Mic fader → micGainNode
    if (mmMicFader) {
      mmMicFader.addEventListener('input', function() {
        var val = parseInt(mmMicFader.value);
        if (mmMicVal) mmMicVal.textContent = val + '%';
        if (micGainNode) micGainNode.gain.value = val / 100;
      });
    }

    // Music fader → azGainNode
    if (mmMusicFader) {
      mmMusicFader.addEventListener('input', function() {
        monitorMusicGain = parseInt(mmMusicFader.value) / 100;
        if (mmMusicVal) mmMusicVal.textContent = parseInt(mmMusicFader.value) + '%';
        if (getGainNode() && getAudioCtx() && !getStudioPlayer().muted) {
          getGainNode().gain.setValueAtTime(monitorMusicGain * mmMasterGain, getAudioCtx().currentTime);
        }
      });
    }

    // Master fader → update music and mic monitor gain
    if (mmMasterFader) {
      mmMasterFader.addEventListener('input', function() {
        mmMasterGain = parseInt(mmMasterFader.value) / 100;
        if (mmMasterVal) mmMasterVal.textContent = parseInt(mmMasterFader.value) + '%';
        // Update music gain
        if (getGainNode() && getAudioCtx() && !getStudioPlayer().muted) {
          getGainNode().gain.setValueAtTime(monitorMusicGain * mmMasterGain, getAudioCtx().currentTime);
        }
        // Update mic monitor gain
        if (micMonitorNode && micMonitorActive) {
          micMonitorNode.gain.value = mmMasterGain;
        }
      });
    }

    // Duck amount slider
    if (mmDuckAmount) {
      mmDuckAmount.addEventListener('input', function() {
        duckAmountDb = parseInt(mmDuckAmount.value);
        duckMultiplier = Math.pow(10, -duckAmountDb / 20);
        if (mmDuckVal) mmDuckVal.textContent = '-' + duckAmountDb + 'dB';
      });
    }

    // Duck speed select
    if (mmDuckSpeedSel) {
      mmDuckSpeedSel.addEventListener('change', function() {
        duckSpeed = mmDuckSpeedSel.value;
        log('monitor: duck speed = ' + duckSpeed);
      });
    }

    if (micInputSelect) {
      micInputSelect.addEventListener('change', function() {
        if (micActive) {
          stopMic();
          setTimeout(startMic, 100);
        }
      });
    }

    if (micOutputSelect) {
      micOutputSelect.addEventListener('change', function() {
        applyMonitorOutput();
      });
    }

    // Initialize devices
    enumerateMicDevices();
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', enumerateMicDevices);
    }
  }

  return {
    init: init,
    enumerateMicDevices: enumerateMicDevices,
    startMic: startMic,
    stopMic: stopMic,
    toggleMicMonitor: toggleMicMonitor,
    applyMonitorOutput: applyMonitorOutput,
    startMonitorMeters: startMonitorMeters,
    updateMonitorUI: updateMonitorUI,
    startMicStreaming: startMicStreaming,
    stopMicStreaming: stopMicStreaming,
    checkMicStreaming: checkMicStreaming,
    // Live gain getters — FRAnalyzer.setPlayerMuted reads both.
    getMonitorMusicGain: function () { return monitorMusicGain; },
    getMasterGain: function () { return mmMasterGain; },
    isMicActive: function () { return micActive; },
  };
});
