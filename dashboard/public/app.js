(function () {
  'use strict';

  // --- Shared utilities (from utils.js, loaded as window.FRUtils before this script) ---
  // These 7 helpers are byte-identical to their inline predecessors and are now
  // sourced from FRUtils so there is a single source of truth. The names are kept
  // identical so every existing call site is untouched.
  // REQUIRES utils.js to be loaded before this script (index.html loads /utils.js first); FRU is undefined otherwise.
  var FRU = window.FRUtils;
  var pad = FRU.pad, fmtSize = FRU.fmtSize, cleanTrackName = FRU.cleanTrackName,
      escapeHtml = FRU.escapeHtml, timeAgo = FRU.timeAgo, formatTime = FRU.formatTime,
      pttFormatTime = FRU.pttFormatTime;

  // Test-only hook: lets the jsdom smoke assert the aliases resolved to FRUtils.
  // Guarded by window.__APP_TEST__ — completely inert in production (flag unset).
  if (typeof window !== 'undefined' && window.__APP_TEST__) {
    window.__appHelpers = {
      pad: pad, fmtSize: fmtSize, cleanTrackName: cleanTrackName,
      escapeHtml: escapeHtml, timeAgo: timeAgo, formatTime: formatTime,
      pttFormatTime: pttFormatTime
    };
  }

  // --- DOM refs ---
  var studioPlayer = document.getElementById('studio-player');
  var modeTag = document.getElementById('mode-tag');
  var uptimeEl = document.getElementById('uptime');
  var qualitySelect = document.getElementById('quality-select');
  var errorBanner = document.getElementById('error-banner');
  var statListeners = document.getElementById('stat-listeners');
  var statAudioBr = document.getElementById('stat-audio-br');
  var statFps = document.getElementById('stat-fps');
  var statSpeed = document.getElementById('stat-speed');
  var statVideoBr = document.getElementById('stat-video-br');
  var statTime = document.getElementById('stat-time');
  // music-list / music-count / visuals-list / visuals-count refs moved into
  // filemgmt.js (window.FRFileMgmt), which resolves them via getElementById.
  var logEl = document.getElementById('log');
  var dbgClear = document.getElementById('dbg-clear');
  var dbgPause = document.getElementById('dbg-pause');

  // --- Studio DOM refs ---
  var studioAudioTrack = document.getElementById('studio-audio-track');
  var studioBpm = document.getElementById('studio-bpm');
  var transportElapsed = document.getElementById('transport-elapsed');
  var transportDuration = document.getElementById('transport-duration');
  var transportBarFill = document.getElementById('transport-bar-fill');
  var transportCue = document.getElementById('transport-cue');
  var trackStartedAt = 0;
  var trackDuration = 0;
  var trackMixDur = 0;
  var lastAudioMsg = null; // cached last audio message (for replay after ARM→PLAY)
  var queueList = document.getElementById('queue-list');
  var skipBtn = document.getElementById('skip-btn');
  var clearQueueBtn = document.getElementById('clear-queue-btn');
  var trackSelector = document.getElementById('track-selector');
  var queueSearch = document.getElementById('queue-search');
  var queuePanelTitle = document.getElementById('queue-panel-title');
  var queueSelectorTitle = document.getElementById('queue-selector-title');

  // --- PTT DOM refs ---
  var pttBar = document.getElementById('ptt-bar');
  var pttLabel = document.getElementById('ptt-label');
  var pttTimer = document.getElementById('ptt-timer');
  var pttWaveform = document.getElementById('ptt-waveform');
  var pttRecBtn = document.getElementById('ptt-rec-btn');
  var pttRecWrap = document.getElementById('ptt-rec-wrap');
  var pttPreview = document.getElementById('ptt-preview');
  var pttPlayBtn = document.getElementById('ptt-play-btn');
  var pttDiscardBtn = document.getElementById('ptt-discard-btn');
  var pttSendBtn = document.getElementById('ptt-send-btn');
  var pttSettingsBtn = document.getElementById('ptt-settings-btn');
  var pttConfig = document.getElementById('ptt-config');
  var pttDuckSlider = document.getElementById('ptt-duck-slider');
  var pttDuckValue = document.getElementById('ptt-duck-value');
  var pttGainSlider = document.getElementById('ptt-gain-slider');
  var pttGainValue = document.getElementById('ptt-gain-value');

  // --- Mixing Mode DOM refs ---
  var mixModeContainer = document.getElementById('transport-mix-mode');
  var mixPills = mixModeContainer ? mixModeContainer.querySelectorAll('.mix-pill') : [];
  var currentMixMode = 'smart';

  // --- State ---
  var bpmMap = {};
  var logsPaused = false;
  var logs = [];
  var startTime = Date.now();
  // musicFiles / visualFiles moved into filemgmt.js (window.FRFileMgmt); read via
  // FRFileMgmt.getMusicFiles() / getVisualFiles().
  var processedVisualFiles = [];
  var activeTab = 'studio';
  var listenerHistory = [];
  var peakListeners = 0;

  // --- Auth ---
  var authToken = localStorage.getItem('s23_token') || '';

  function authFetch(url, opts) {
    opts = opts || {};
    if (!opts.headers) {
      opts.headers = {};
    } else if (opts.headers instanceof Headers) {
      // convert Headers to plain object for easy merge
      var h = {};
      opts.headers.forEach(function(v, k) { h[k] = v; });
      opts.headers = h;
    }
    if (authToken) {
      opts.headers['Authorization'] = 'Bearer ' + authToken;
    }
    return fetch(url, opts).then(function(resp) {
      if (resp.status === 401) {
        showLoginOverlay();
        return Promise.reject(new Error('Unauthorized'));
      }
      return resp;
    });
  }

  // --- Login Overlay ---
  var loginOverlay = document.createElement('div');
  loginOverlay.id = 'login-overlay';
  loginOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:#0a0a0a;z-index:99999;display:flex;align-items:center;justify-content:center;';
  loginOverlay.innerHTML =
    '<div style="text-align:center;max-width:340px;width:100%;padding:20px;">' +
      '<div style="font-family:monospace;font-size:28px;color:#00ff41;margin-bottom:8px;letter-spacing:2px;">STUDIO 23</div>' +
      '<div style="font-family:monospace;font-size:12px;color:#555;margin-bottom:32px;">dashboard access</div>' +
      '<input id="login-token" type="password" placeholder="token" ' +
        'style="width:100%;box-sizing:border-box;padding:12px;background:#111;border:1px solid #333;color:#00ff41;font-family:monospace;font-size:14px;outline:none;margin-bottom:12px;border-radius:2px;" />' +
      '<button id="login-btn" ' +
        'style="width:100%;padding:12px;background:#00ff41;color:#0a0a0a;border:none;font-family:monospace;font-size:14px;font-weight:bold;cursor:pointer;border-radius:2px;">ENTER</button>' +
      '<div id="login-error" style="font-family:monospace;font-size:12px;color:#ff4141;margin-top:12px;min-height:16px;"></div>' +
    '</div>';
  document.body.appendChild(loginOverlay);

  var loginTokenInput = document.getElementById('login-token');
  var loginBtn = document.getElementById('login-btn');
  var loginError = document.getElementById('login-error');

  function showLoginOverlay() {
    authToken = '';
    localStorage.removeItem('s23_token');
    loginOverlay.style.display = 'flex';
    loginError.textContent = '';
    loginTokenInput.value = '';
    loginTokenInput.focus();
  }

  function hideLoginOverlay() {
    loginOverlay.style.display = 'none';
  }

  function doLogin() {
    var val = loginTokenInput.value.trim();
    if (!val) { loginError.textContent = 'enter token'; return; }
    loginBtn.disabled = true;
    loginError.textContent = '';
    fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: val })
    }).then(function(r) {
      if (r.ok) return r.json();
      throw new Error('bad token');
    }).then(function() {
      authToken = val;
      localStorage.setItem('s23_token', val);
      loginBtn.disabled = false;
      hideLoginOverlay();
      // Reconnect WebSocket with token
      if (ws) { try { ws.close(); } catch(e) {} }
      connectWs();
      // Reload data
      FRFileMgmt.loadFileList('music');
      FRFileMgmt.loadFileList('visuals');
      loadBroadcastState();
    }).catch(function() {
      loginError.textContent = 'invalid token';
      loginBtn.disabled = false;
    });
  }

  loginBtn.addEventListener('click', doLogin);
  loginTokenInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') doLogin();
  });

  // Initial auth check
  (function checkAuth() {
    if (!authToken) { showLoginOverlay(); return; }
    fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken })
    }).then(function(r) {
      if (r.ok) { hideLoginOverlay(); return; }
      showLoginOverlay();
    }).catch(function() {
      // Server unreachable — hide overlay (no auth configured or offline)
      hideLoginOverlay();
    });
  })();

  // --- Tab Switching ---
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var tab = btn.dataset.tab;
      activeTab = tab;
      document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
      document.getElementById('tab-' + tab).classList.add('active');
      if (tab === 'playlists') FRPlaylists.loadPlaylists();
      if (tab === 'schedule') { loadSchedule(); loadPlaylistsForSelect(); }
      if (tab === 'visuals') { FRVisualProfiles.loadVisualProfiles(); loadVideoPlaylists(); loadOverlays(); loadOverlayAssets(); }
      if (tab === 'analytics') FRAnalytics.loadAnalytics();
    });
  });

  // --- Collapsible panels ---
  document.querySelectorAll('.panel-toggle').forEach(function(head) {
    head.addEventListener('click', function(e) {
      if (e.target.closest('.dbg-actions')) return;
      var panel = head.closest('.panel-collapsible');
      panel.classList.toggle('collapsed');
    });
  });

  // --- Keyboard shortcuts ---
  document.addEventListener('keydown', function(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space' && activeTab === 'studio') {
      e.preventDefault();
      skipBtn.click();
    }
  });

  // --- Logging ---
  function log(msg) {
    var ts = new Date().toISOString().slice(11, 23);
    console.log('[S23 ' + ts + '] ' + msg);
    logs.push('[' + ts + '] ' + msg);
    if (logs.length > 500) logs.shift();
    if (!logsPaused) {
      logEl.textContent = logs.join('\n');
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  dbgClear.onclick = function () { logs.length = 0; logEl.textContent = ''; };
  dbgPause.onclick = function () {
    logsPaused = !logsPaused;
    dbgPause.textContent = logsPaused ? 'Resume' : 'Pause';
    if (!logsPaused) {
      logEl.textContent = logs.join('\n');
      logEl.scrollTop = logEl.scrollHeight;
    }
  };

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.classList.add('visible');
    log('ERROR: ' + msg);
    setTimeout(function() { errorBanner.classList.remove('visible'); }, 5000);
  }

  // --- Uptime ---
  setInterval(function () {
    var s = Math.floor((Date.now() - startTime) / 1000);
    var h = Math.floor(s / 3600); s %= 3600;
    var m = Math.floor(s / 60); s %= 60;
    uptimeEl.textContent = pad(h) + ':' + pad(m) + ':' + pad(s);
  }, 1000);

  // --- HLS Player (live-only, no scrubbing) ---
  var hlsInstance = null;
  var playerMuteBtn = document.getElementById('player-mute-btn');
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent) || isIOS;

  // Safari/iOS: hide analyzer (WebKit bug 180696)
  if (isSafari) {
    var _aw = document.getElementById('analyzer-wrap');
    if (_aw) _aw.style.display = 'none';
  }

  // --- Overlay state machine ---
  // showLoading(text, source, lockMs) — show overlay.
  //   lockMs: minimum display time. During lock, only 'manifest' and 'safety' can hide.
  //           timeupdate/canplay from old stream are blocked until lock expires.
  // hideLoading(source) — hide overlay (respects lock for auto-sources).
  var aliveTimer = null;    // 4s no-timeupdate → show "Loading stream..."
  var safetyTimer = null;   // 20s max overlay duration
  var hlsRetryTimer = null;
  var overlayLockedUntil = 0;  // timestamp — auto-hide blocked until this time
  var pendingModeSwitch = false;  // hard block: overlay stays until mode actually applies

  function showLoading(text, source, lockMs) {
    var overlay = document.getElementById('player-overlay');
    var overlayText = document.getElementById('player-overlay-text');
    if (text) overlayText.textContent = text;
    overlay.classList.add('visible');
    if (lockMs) overlayLockedUntil = Date.now() + lockMs;
    log('OVR SHOW "' + text + '" src=' + (source || '?') + (lockMs ? ' lock=' + lockMs + 'ms' : ''));
    // Safety net: never stuck > 20s
    if (safetyTimer) clearTimeout(safetyTimer);
    safetyTimer = setTimeout(function() {
      safetyTimer = null;
      log('OVR safety 20s expired');
      overlayLockedUntil = 0;
      hideLoading('safety');
    }, 20000);
  }

  function hideLoading(source) {
    // pendingModeSwitch: hard block — only mode-applied and safety can hide
    if (pendingModeSwitch && source !== 'mode-applied' && source !== 'safety') return;
    // Timestamp lock: block auto-sources (timeupdate, canplay) for brief overlays
    if ((source === 'timeupdate' || source === 'canplay') && Date.now() < overlayLockedUntil) return;
    var overlay = document.getElementById('player-overlay');
    var wasVisible = overlay.classList.contains('visible');
    overlay.classList.remove('visible');
    overlayLockedUntil = 0;
    if (wasVisible) log('OVR HIDE src=' + (source || '?'));
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
  }

  function clearAllTimers(source) {
    if (aliveTimer) { clearTimeout(aliveTimer); aliveTimer = null; }
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
    if (hlsRetryTimer) { clearTimeout(hlsRetryTimer); hlsRetryTimer = null; }
    if (playRetryTimer) { clearTimeout(playRetryTimer); playRetryTimer = null; }
  }

  // timeupdate = video is receiving frames → stream alive → hide overlay (if not locked)
  studioPlayer.addEventListener('timeupdate', function() {
    if (noiseActive) return;
    if (broadcastState && broadcastState.arming) return;
    if (aliveTimer) { clearTimeout(aliveTimer); aliveTimer = null; }
    hideLoading('timeupdate');
    aliveTimer = setTimeout(function() {
      aliveTimer = null;
      if (noiseActive) return;
      // Don't show buffering overlay when armed (poster loops normally)
      if (broadcastState && broadcastState.streamMode === 'armed') return;
      showLoading('Buffering...', 'alive-timeout');
    }, 4000);
  });

  studioPlayer.addEventListener('canplay', function() {
    hideLoading('canplay');
  });

  // No seeking handler needed — controls are disabled (pointer-events: none)
  // Previously had a snap-to-live handler here, but it fought with HLS.js
  // gap recovery (bufferSeekOverHole), creating an infinite loop every 100ms.

  // iOS/Safari: recover from stalls — video element fires 'stalled' when buffering stops
  var stallCount = 0;
  var stallResetTimer = null;
  studioPlayer.addEventListener('stalled', function() {
    if (noiseActive) return;
    if (broadcastState && (broadcastState.streamMode === 'armed' || broadcastState.arming)) return;
    stallCount++;
    log('PLR stalled (#' + stallCount + ')');
    if (!stallResetTimer) {
      stallResetTimer = setTimeout(function() {
        if (stallCount >= 3) {
          log('PLR too many stalls (' + stallCount + '), restarting');
          restartPlayer('stall-recovery');
        }
        stallCount = 0;
        stallResetTimer = null;
      }, 8000);
    }
  });

  // Native HLS (old iOS): recover from errors
  studioPlayer.addEventListener('error', function() {
    if (!useNativeHls) return;
    var err = studioPlayer.error;
    log('PLR native error: ' + (err ? err.code + ' ' + err.message : 'unknown'));
    if (broadcastState && (broadcastState.streamMode === 'armed' || broadcastState.arming)) return;
    showLoading('Reconnecting...', 'native-error');
    setTimeout(function() { restartPlayer('native-error'); }, 2000);
  });

  // Mute/unmute (integrated with CRT Analyzer GainNode)
  playerMuteBtn.onclick = function() {
    userInteracted = true;
    if (!azInited) azInit();
    var muted = !studioPlayer.muted;
    setPlayerMuted(muted);
    playerMuteBtn.innerHTML = muted ? '&#128263;' : '&#128266;';
    playerMuteBtn.title = muted ? 'Unmute' : 'Mute';
    if (!muted) playerMuteBtn.classList.add('unmuted');
    else playerMuteBtn.classList.remove('unmuted');
  };

  // --- Standby Overlay (solid black div) ---
  var standbyOverlay = document.getElementById('standby-overlay');
  var noiseActive = false;
  var playTransitionLock = false; // prevents loadBroadcastState from interfering during PLAY
  var userInteracted = false; // blocks unmuting until user clicks ARM/PLAY/mute

  function startStaticNoise() {
    noiseActive = true;
    standbyOverlay.classList.add('active');
    log('STANDBY overlay on');
  }

  function stopStaticNoise() {
    noiseActive = false;
    standbyOverlay.classList.remove('active');
    log('STANDBY overlay off');
  }

  function flashTransition() {
    var channelFlash = document.getElementById('channel-flash');
    channelFlash.style.display = 'block';
    channelFlash.style.opacity = '0.8';
    var start = performance.now();
    function fade(now) {
      var elapsed = now - start;
      if (elapsed >= 300) {
        channelFlash.style.display = 'none';
        return;
      }
      channelFlash.style.opacity = (0.8 * (1 - elapsed / 300)).toFixed(3);
      requestAnimationFrame(fade);
    }
    requestAnimationFrame(fade);
  }

  var hlsSrc = '/hls/stream.m3u8';
  var useNativeHls = false;

  function initPlayer() {
    studioPlayer.muted = true; // force muted — Safari may persist unmuted state across reloads
    log('PLR init src=' + hlsSrc);

    if (isSafari || typeof Hls === 'undefined' || !Hls.isSupported()) {
      // iOS: native HLS (reliable). Desktop fallback when no MSE.
      // createMediaElementSource doesn't work on Safari (HLS or MMS) — WebKit bug 180696.
      // Also fallback for very old browsers without MSE.
      log('PLR mode=native-hls' + (isSafari ? ' (Safari)' : ' (no MSE)'));
      useNativeHls = true;
      studioPlayer.src = hlsSrc;
      tryPlay('native-init');
      return;
    }
    // hls.js works on Chrome, Firefox, Safari desktop 17.1+ (via ManagedMediaSource)
    log('PLR mode=hls.js v' + (Hls.version || '?'));
    startHls('init');
  }

  var playRetryTimer = null;
  function tryPlay(source) {
    if (playRetryTimer) { clearTimeout(playRetryTimer); playRetryTimer = null; }
    var attempt = 0;
    var maxAttempts = isIOS ? 8 : 3;
    function go() {
      studioPlayer.play().then(function() {
        log('PLR play() ok src=' + source + ' attempt=' + attempt);
      }).catch(function(e) {
        attempt++;
        if (attempt < maxAttempts) {
          var delay = Math.min(500 * attempt, 3000);
          log('PLR play() rejected (#' + attempt + '): ' + e + ', retry in ' + delay + 'ms');
          playRetryTimer = setTimeout(go, delay);
        } else {
          log('PLR play() gave up after ' + attempt + ' attempts');
        }
      });
    }
    go();
  }

  function startHls(source, configOverride) {
    log('HLS startHls src=' + (source || '?'));
    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }

    // Reset stale video element buffers after HLS destroy
    // Without this, readyState/videoWidth/currentTime retain old values
    studioPlayer.removeAttribute("src");
    studioPlayer.load();

    var hlsConfig = {
      lowLatencyMode: false,
      backBufferLength: 0,
      enableWorker: true,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 6,
      liveDurationInfinity: true,
      maxBufferLength: 4,
      maxMaxBufferLength: 8,
      maxLiveSyncPlaybackRate: 1.5
    };
    if (configOverride) {
      for (var k in configOverride) hlsConfig[k] = configOverride[k];
    }
    hlsInstance = new Hls(hlsConfig);

    var errorCount = 0;
    var errorResetTimer = null;

    hlsInstance.on(Hls.Events.ERROR, function (_, data) {
      if (data.fatal) {
        // ARM/ARMED: pipeline restarting (flush stale mbuffer), HLS segments updating.
        // Instead of ignoring — recover with delay to wait for fresh segments.
        if (broadcastState && (broadcastState.streamMode === 'armed' || broadcastState.arming)) {
          log('HLS FATAL during ARM/ARMED: ' + data.details + ' (recovering in 2s)');
          hlsInstance.destroy();
          hlsInstance = null;
          if (hlsRetryTimer) clearTimeout(hlsRetryTimer);
          hlsRetryTimer = setTimeout(function() {
            hlsRetryTimer = null;
            startHls('arm-recovery');
          }, 2000);
          return;
        }
        log('HLS FATAL ' + data.details);
        showLoading('Reconnecting...', 'hls-fatal');
        hlsInstance.destroy();
        hlsInstance = null;
        if (hlsRetryTimer) clearTimeout(hlsRetryTimer);
        hlsRetryTimer = setTimeout(function() {
          hlsRetryTimer = null;
          startHls('retry');
        }, 1500);
        return;
      }
      // Non-fatal errors: if too many in a short window, force restart
      errorCount++;
      if (!errorResetTimer) {
        errorResetTimer = setTimeout(function() {
          errorResetTimer = null;
          // Don't restart during ARM/ARMED
          if (broadcastState && (broadcastState.streamMode === 'armed' || broadcastState.arming)) {
            errorCount = 0;
            return;
          }
          if (errorCount > 15) {
            log('HLS too many errors (' + errorCount + '), restarting');
            restartPlayer('error-flood');
          }
          errorCount = 0;
        }, 3000);
      }
    });

    hlsInstance.on(Hls.Events.MANIFEST_PARSED, function () {
      // Don't hide overlay during ARM — checkReady will hide it when video actually appears
      if (broadcastState && broadcastState.arming) { log('HLS MANIFEST_PARSED (arming, keep overlay)'); tryPlay('manifest'); return; }
      hideLoading('manifest');
      log('HLS MANIFEST_PARSED → play()');
      tryPlay('manifest');
    });

    hlsInstance.loadSource(hlsSrc);
    hlsInstance.attachMedia(studioPlayer);
  }

  // restartPlayer: clean restart — clears ALL timers, shows overlay during reconnect
  function restartPlayer(source, hlsConfigOverride) {
    log('PLR restart src=' + (source || '?'));
    clearAllTimers('restart-' + (source || '?'));
    // Show overlay during reconnection — locked so stale timeupdate can't hide it.
    // 'manifest' source (MANIFEST_PARSED) always bypasses the lock.
    showLoading('Loading stream...', 'restart', 3000);
    // Restart Safari stream decode so analyzer re-syncs with new HLS session
    if (azStreamAbort) {
      azStreamAbort.abort();
      azStreamAbort = null;
      azStartStreamDecode();
    }
    if (useNativeHls) {
      studioPlayer.src = hlsSrc;
      tryPlay('native-restart');
    } else {
      startHls('restart-' + (source || '?'), hlsConfigOverride);
    }
  }

  initPlayer();

  // --- Page lifecycle: iOS suspends pages aggressively ---
  // On return from background/tab-switch, HLS stalls and WS dies.
  // Detect resume and restart both.
  var lastVisibleTime = Date.now();

  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      lastVisibleTime = Date.now();
      log('PAGE hidden');
      return;
    }
    var away = Date.now() - lastVisibleTime;
    log('PAGE visible (away ' + Math.round(away / 1000) + 's)');

    // Skip recovery during standby/arming
    if (broadcastState && (broadcastState.streamMode === 'standby' || broadcastState.arming)) return;

    // If away > 3s, the HLS stream is likely stale — restart player
    if (away > 3000) {
      log('PAGE resume: restarting player after ' + Math.round(away / 1000) + 's away');
      restartPlayer('page-resume');
    } else {
      // Short absence — just try play() in case iOS paused the element
      tryPlay('page-resume-short');
    }

    // Reconnect WebSocket if dead
    if (!ws || ws.readyState > 1) {
      log('PAGE resume: WS dead, reconnecting');
      wsReconnectDelay = 1000;
      connectWs();
    }
  });

  // bfcache: iOS Safari may restore page from bfcache on back/forward navigation
  window.addEventListener('pageshow', function(e) {
    if (e.persisted) {
      log('PAGE restored from bfcache');
      restartPlayer('bfcache');
      if (!ws || ws.readyState > 1) {
        wsReconnectDelay = 1000;
        connectWs();
      }
    }
  });

  // Wire the file-management UI module (filemgmt.js / window.FRFileMgmt) BEFORE the
  // initial loads below. It owns musicFiles/visualFiles; app.js injects the host
  // services plus live getters for the WS-owned bpmMap and the mutable auth token
  // (both read at call time, never cached). renderTrackSelector / loadOverlayAssets
  // are app.js functions (hoisted declarations) called back into after a music load
  // / overlay-asset upload.
  FRFileMgmt.init({
    authFetch: authFetch, log: log, showError: showError,
    showLoginOverlay: showLoginOverlay,
    renderTrackSelector: renderTrackSelector,
    loadOverlayAssets: loadOverlayAssets,
    getBpmMap: function () { return bpmMap; },
    getAuthToken: function () { return authToken; }
  });

  // Load file lists immediately
  FRFileMgmt.loadFileList('music');
  FRFileMgmt.loadFileList('visuals');

  // --- WebSocket ---
  var ws = null;
  var wsReconnectDelay = 1000;
  var wsReconnectTimer = null;

  function connectWs() {
    // Cancel any pending reconnect to avoid stacking (iOS resume can fire multiple times)
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    // Close stale socket if still lingering
    if (ws) {
      try { ws.onclose = null; ws.close(); } catch(e) {}
      ws = null;
    }
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = proto + '//' + location.host;
    ws = new WebSocket(wsUrl);

    ws.onopen = function () {
      log('ws: connected');
      wsReconnectDelay = 1000;
      // Send auth token as first message
      if (authToken) {
        ws.send(JSON.stringify({type: 'auth', token: authToken}));
      }
      // Subscribe to server-side FFT if Safari analyzer is active
      if (azServerFFT) {
        ws.send(JSON.stringify({type: 'fft-subscribe'}));
      }
    };

    ws.onclose = function () {
      log('ws: disconnected, reconnecting in ' + (wsReconnectDelay / 1000) + 's');
      wsReconnectTimer = setTimeout(connectWs, wsReconnectDelay);
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, 10000);
    };

    ws.onerror = function () {
      log('ws: error');
    };

    ws.binaryType = 'arraybuffer';
    ws.onmessage = function (evt) {
      if (typeof evt.data !== 'string') {
        // Binary FFT frame from server
        handleFftFrame(new Uint8Array(evt.data));
        return;
      }
      try {
        var msg = JSON.parse(evt.data);
        handleMessage(msg);
      } catch (e) {
        log('ws: parse error ' + e);
      }
    };
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'init':
        bpmMap = msg.data.bpm || {};
        // Set broadcast state BEFORE updateAudio (race condition fix)
        if (msg.data.streamControl) {
          broadcastState.streaming = msg.data.streamControl.streaming;
          broadcastState.broadcast = !!msg.data.streamControl.broadcast;
        }
        if (msg.data.streamMode) {
          broadcastState.streamMode = msg.data.streamMode.mode || 'standby';
          broadcastState.standbyVisual = msg.data.streamMode.standbyVisual;
        }
        if (msg.data.visualMode) {
          broadcastState.visualMode = msg.data.visualMode.mode || 'visual-radio';
        }
        if (msg.data.liveMode) broadcastState.liveMode = msg.data.liveMode;
        deriveUiMode();
        updateBroadcastUI();
        updateMode(msg.data.outputMode);
        lastAudioMsg = msg.data.audio;
        updateAudio(msg.data.audio);
        updateIcecast(msg.data.icecast);
        updateFfmpeg(msg.data.ffmpeg);
        if (msg.data.rtmpHealth) updateRestreamStatus(msg.data.rtmpHealth);
        FRFileMgmt.loadFileList('music');
        FRFileMgmt.loadFileList('visuals');
        break;
      case 'audio':
        lastAudioMsg = msg.data;
        updateAudio(msg.data);
        break;
      case 'video':
        if (pendingModeSwitch) {
          // New clip started in feed_fifo, but HLS player still has ~2s of buffered
          // old content (hls_time=1 × liveSyncDurationCount=1 + segment pipeline).
          // Wait for buffer to flush before hiding overlay.
          log('MODE new clip detected: ' + (msg.data && msg.data.filename || '?') + ', waiting for HLS buffer...');
          setTimeout(function() {
            pendingModeSwitch = false;
            hideLoading('mode-applied');
            log('MODE switch applied');
          }, 2500);
        }
        break;
      case 'icecast':
        updateIcecast(msg.data);
        break;
      case 'ffmpeg':
        updateFfmpeg(msg.data);
        break;
      case 'bpm':
        bpmMap = msg.data || {};
        FRFileMgmt.refreshBpmInList();
        break;
      case 'rtmp-health':
        updateRestreamStatus(msg.data);
        break;
      case 'voice-status':
        if (msg.data && msg.data.status === 'on-air') {
          log('PTT: voice message on air');
        }
        break;
      case 'mixing-config':
        if (msg.data && msg.data.mode) {
          currentMixMode = msg.data.mode;
          updateMixModeUI();
          var wsB = studioBpm.textContent ? parseInt(studioBpm.textContent) : 0;
          trackMixDur = computeMixDur(wsB);
          positionCueMarker();
        }
        break;
      case 'live-mode':
        if (msg.data) {
          broadcastState.liveMode = msg.data;
          updateLiveModeUI();
          updateModeUI();
          log('live: ' + msg.data.obsStatus);
        }
        break;
    }
  }

  function updateMode(mode) {
    modeTag.textContent = (mode || 'hls').toUpperCase();
    if (mode === 'rtmp') {
      modeTag.classList.add('rtmp');
    }
  }

  // Compute crossfade duration matching Liquidsoap logic.
  // Delegates to FRUtils (single source of truth), passing the current mix mode.
  function computeMixDur(bpm) {
    return FRU.computeMixDur(bpm, currentMixMode);
  }

  function positionCueMarker() {
    if (!trackDuration || !trackMixDur || trackMixDur >= trackDuration) {
      transportCue.style.display = 'none';
      return;
    }
    var cuePct = ((trackDuration - trackMixDur) / trackDuration) * 100;
    transportCue.style.left = cuePct + '%';
    transportCue.style.display = 'block';
    transportCue.classList.remove('active');
  }

  function updateAudio(data) {
    if (!data) return;
    if (broadcastState.streamMode === 'standby' || broadcastState.streamMode === 'armed' || broadcastState.arming) return;
    var name = data.title || cleanTrackName(data.filename) || '--';
    studioAudioTrack.textContent = name;

    var filename = (data.filename || '').split('/').pop();
    // BPM lookup: try both original filename and extensionless match
    var bpm = bpmMap[filename];
    if (!bpm) {
      var stem = filename.replace(/\.[^.]+$/, '');
      for (var k in bpmMap) {
        if (k.replace(/\.[^.]+$/, '') === stem) { bpm = bpmMap[k]; break; }
      }
    }
    studioBpm.textContent = bpm ? Math.round(bpm) + ' BPM' : '';

    if (data.startedAt) trackStartedAt = data.startedAt;
    if (data.duration) trackDuration = data.duration;
    transportDuration.textContent = formatTime(trackDuration);

    trackMixDur = computeMixDur(bpm);
    positionCueMarker();
    updateTrackProgress();
  }

  function updateTrackProgress() {
    if (broadcastState.streamMode === 'standby' || broadcastState.streamMode === 'armed' || broadcastState.arming) return;
    if (!trackStartedAt || !trackDuration) {
      transportBarFill.style.width = '0%';
      transportElapsed.textContent = '0:00';
      return;
    }
    var elapsed = (Date.now() - trackStartedAt) / 1000;
    var pct = Math.min(100, (elapsed / trackDuration) * 100);
    transportBarFill.style.width = pct + '%';
    transportElapsed.textContent = formatTime(elapsed);

    // Blink cue marker when in transition zone
    if (trackMixDur > 0) {
      var transitionAt = trackDuration - trackMixDur;
      if (transitionAt > 0 && elapsed >= transitionAt) {
        transportCue.classList.add('active');
      } else {
        transportCue.classList.remove('active');
      }
    }
  }

  setInterval(updateTrackProgress, 1000);

  function updateIcecast(data) {
    if (!data) return;
    statListeners.textContent = data.listeners || '0';
    statAudioBr.textContent = data.bitrate ? data.bitrate + ' kbps' : '--';
    if (data.serverStart) {
      startTime = new Date(data.serverStart).getTime() || Date.now();
    }
    var count = parseInt(data.listeners) || 0;
    listenerHistory.push({ ts: Date.now(), count: count });
    if (listenerHistory.length > 720) listenerHistory.shift();
    if (count > peakListeners) peakListeners = count;
  }

  function updateFfmpeg(data) {
    if (!data) return;
    statFps.textContent = data.fps || '--';
    statSpeed.textContent = data.speed || '--';
    statVideoBr.textContent = data.bitrate || '--';
    statTime.textContent = data.time || '--';
  }

  connectWs();

  // --- File Management ---
  // The file-management UI (refreshBpmInList, loadFileList, renderFileList,
  // deleteFile, the drop-zone upload system) plus the musicFiles/visualFiles
  // state it owns were extracted into filemgmt.js (window.FRFileMgmt). app.js
  // calls FRFileMgmt.init({...}) at boot (further down) and reaches the state via
  // FRFileMgmt.getMusicFiles()/getVisualFiles(). bpmMap stays here (WS-owned) and
  // is injected as a getter.

  FRFileMgmt.initDropZones();

  setInterval(function () { FRFileMgmt.loadFileList('music'); }, 30000);
  setInterval(function () { FRFileMgmt.loadFileList('visuals'); }, 30000);

  // --- Queue Control ---
  function loadQueue() {
    authFetch('/api/queue')
      .then(function(r) { return r.json(); })
      .then(function(items) { renderQueue(items); })
      .catch(function() { renderQueue([]); });
  }

  function renderQueue(items) {
    queueList.innerHTML = '';
    if (!items || items.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'queue-empty';
      empty.textContent = 'Queue empty \u2014 random mode';
      queueList.appendChild(empty);
      return;
    }
    items.forEach(function(path, i) {
      var div = document.createElement('div');
      div.className = 'queue-item';
      var num = document.createElement('span');
      num.className = 'queue-num';
      num.textContent = (i + 1) + '.';
      div.appendChild(num);
      var name = document.createElement('span');
      name.className = 'queue-name';
      name.textContent = cleanTrackName(path);
      name.title = path;
      div.appendChild(name);
      queueList.appendChild(div);
    });
  }

  function addToQueue(filename) {
    authFetch('/api/queue/push', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: filename
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          log('queue: added ' + filename);
          loadQueue();
        } else {
          showError('Queue push failed: ' + (data.error || 'unknown'));
        }
      })
      .catch(function(e) { showError('Queue push failed: ' + e); });
  }

  skipBtn.onclick = function() {
    authFetch('/api/queue/skip', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          log('queue: skipped track');
          setTimeout(loadQueue, 1000);
          setTimeout(loadTrackHistory, 2000);
        }
      })
      .catch(function(e) { showError('Skip failed: ' + e); });
  };

  clearQueueBtn.onclick = function() {
    authFetch('/api/queue/clear', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          log('queue: cleared');
          loadQueue();
        }
      })
      .catch(function(e) { showError('Clear queue failed: ' + e); });
  };

  // --- Video Queue Control ---
  function loadVideoQueue() {
    authFetch('/api/video-queue')
      .then(function(r) { return r.json(); })
      .then(function(items) { renderQueue(items); })
      .catch(function() { renderQueue([]); });
  }

  function addToVideoQueue(filename) {
    authFetch('/api/video-queue/push', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: filename
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          log('video queue: added ' + filename);
          loadVideoQueue();
        }
      })
      .catch(function(e) { showError('Video queue push failed: ' + e); });
  }

  function skipVideo() {
    authFetch('/api/video-queue/skip', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          log('video: skipped');
          setTimeout(loadVideoQueue, 1000);
        }
      })
      .catch(function(e) { showError('Video skip failed: ' + e); });
  }

  function clearVideoQueue() {
    authFetch('/api/video-queue/clear', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          log('video queue: cleared');
          loadVideoQueue();
        }
      })
      .catch(function(e) { showError('Clear video queue failed: ' + e); });
  }

  function loadActiveQueue() {
    if (broadcastState.visualMode === 'video-playlist') loadVideoQueue();
    else loadQueue();
  }

  // --- Track Selector ---
  function renderTrackSelector(filter) {
    trackSelector.innerHTML = '';
    var isVideoMode = broadcastState.visualMode === 'video-playlist';
    var sourceFiles = isVideoMode ? processedVisualFiles : FRFileMgmt.getMusicFiles();
    var search = (filter || '').toLowerCase();
    var filtered = sourceFiles.filter(function(f) {
      return !search || f.name.toLowerCase().indexOf(search) !== -1;
    });
    filtered.forEach(function(f) {
      var div = document.createElement('div');
      div.className = 'selector-item';

      var name = document.createElement('span');
      name.className = 'selector-name';
      name.textContent = f.name;
      name.title = f.name;
      div.appendChild(name);

      if (!isVideoMode) {
        var bpm = bpmMap[f.name];
        if (bpm) {
          var bpmEl = document.createElement('span');
          bpmEl.className = 'selector-bpm';
          bpmEl.textContent = Math.round(bpm) + ' BPM';
          div.appendChild(bpmEl);
        }
      }

      var addBtn = document.createElement('button');
      addBtn.className = 'btn-add-queue';
      addBtn.textContent = '+';
      addBtn.title = isVideoMode ? 'Add to video queue' : 'Add to queue';
      addBtn.onclick = isVideoMode
        ? (function(n) { return function() { addToVideoQueue(n); }; })(f.name)
        : (function(n) { return function() { addToQueue(n); }; })(f.name);
      div.appendChild(addBtn);

      trackSelector.appendChild(div);
    });
  }

  queueSearch.oninput = function() {
    renderTrackSelector(queueSearch.value);
  };

  loadQueue();
  setInterval(loadActiveQueue, 5000);

  // ============================
  // TRACK HISTORY (Studio sidebar)
  // ============================
  function loadTrackHistory() {
    authFetch('/api/history?limit=10')
      .then(function(r) { return r.json(); })
      .then(function(entries) { renderTrackHistory(entries); })
      .catch(function() {});
  }

  function renderTrackHistory(entries) {
    var container = document.getElementById('track-history-list');
    container.innerHTML = '';

    if (!entries || entries.length === 0) {
      container.innerHTML = '<div class="empty-state">No history yet</div>';
      return;
    }

    // Show most recent first
    var reversed = entries.slice().reverse();
    reversed.forEach(function(entry, idx) {
      var div = document.createElement('div');
      div.className = 'track-history-item';

      var name = cleanTrackName(entry.track);
      var nameEl = document.createElement('span');
      nameEl.className = 'track-history-name';
      nameEl.textContent = name;
      nameEl.title = name;
      div.appendChild(nameEl);

      if (idx === 0) {
        var nowBadge = document.createElement('span');
        nowBadge.className = 'now-badge';
        nowBadge.textContent = 'NOW';
        div.appendChild(nowBadge);
      } else {
        var timeEl = document.createElement('span');
        timeEl.className = 'track-history-time';
        timeEl.textContent = timeAgo(entry.ts);
        div.appendChild(timeEl);
      }

      if (entry.bpm) {
        var bpmEl = document.createElement('span');
        bpmEl.className = 'track-history-bpm';
        bpmEl.textContent = Math.round(entry.bpm);
        div.appendChild(bpmEl);
      }

      container.appendChild(div);
    });
  }

  loadTrackHistory();
  setInterval(loadTrackHistory, 15000);

  // ============================
  // RESTREAM STATUS WIDGET
  // ============================
  var lastRtmpHealth = null;

  function updateRestreamStatus(healthData) {
    lastRtmpHealth = healthData;
    var container = document.getElementById('restream-status-list');
    container.innerHTML = '';

    var outputs = (healthData && healthData.outputs) ? healthData.outputs : {};
    var keys = Object.keys(outputs);

    if (keys.length === 0) {
      loadRestreamStatusFallback();
      return;
    }

    keys.forEach(function(name) {
      var info = outputs[name];
      var status = info.status || 'offline';
      var div = document.createElement('div');
      div.className = 'restream-status-item';

      var dotClass = 'restream-status-dot';
      var statusText = 'OFF';
      if (status === 'live') {
        dotClass += ' live';
        statusText = 'LIVE';
      } else if (status === 'error') {
        dotClass += ' error';
        statusText = 'ERROR';
      } else {
        dotClass += ' off';
        statusText = 'OFF';
      }

      var dot = document.createElement('span');
      dot.className = dotClass;
      div.appendChild(dot);

      var nameEl = document.createElement('span');
      nameEl.textContent = name;
      div.appendChild(nameEl);

      var statusEl = document.createElement('span');
      statusEl.className = 'restream-status-text ' + status;
      statusEl.textContent = statusText;
      div.appendChild(statusEl);

      if (status === 'error' && info.error) {
        div.title = info.error;
      }

      container.appendChild(div);
    });
  }

  function loadRestreamStatusFallback() {
    authFetch('/api/stream-keys')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var platforms = data.platforms || data;
        var container = document.getElementById('restream-status-list');
        container.innerHTML = '';
        Object.entries(platforms).forEach(function(entry) {
          var name = entry[0];
          var config = entry[1];
          var div = document.createElement('div');
          div.className = 'restream-status-item';
          div.innerHTML =
            '<span class="restream-status-dot ' + (config.enabled ? 'on' : 'off') + '"></span>' +
            '<span>' + escapeHtml(name) + '</span>' +
            '<span class="restream-status-text off">' + (config.enabled ? 'READY' : 'OFF') + '</span>';
          container.appendChild(div);
        });
        if (Object.keys(platforms).length === 0) {
          container.innerHTML = '<div class="empty-state">No platforms</div>';
        }
      })
      .catch(function() {});
  }

  loadRestreamStatusFallback();

  // ============================
  // PLAYLISTS
  // ============================
  // The music-playlists UI lives in playlists.js (window.FRPlaylists). Wire it
  // up with the host services + live getters for shared state. This binds the
  // create / delete / load-queue / import handlers to their DOM elements.
  // closeGenericModal is assigned to window further down the IIFE, so it is
  // wrapped to defer the lookup to call time.
  FRPlaylists.init({
    authFetch: authFetch, log: log, showError: showError,
    openGenericModal: openGenericModal,
    closeGenericModal: function () { return window.closeGenericModal(); },
    loadQueue: loadQueue,
    getMusicFiles: function () { return FRFileMgmt.getMusicFiles(); },
    getBpmMap: function () { return bpmMap; }
  });

  // Wire the visual-profiles UI module (visualprofiles.js /
  // window.FRVisualProfiles) with the host services. init() also binds the
  // create-visual-profile-btn. closeGenericModal is assigned to window further
  // down the IIFE, so it is wrapped to defer the lookup to call time.
  FRVisualProfiles.init({
    authFetch: authFetch, log: log, showError: showError,
    openGenericModal: openGenericModal,
    closeGenericModal: function () { return window.closeGenericModal(); }
  });

  // Wire the analytics UI module (analytics.js / window.FRAnalytics) with
  // authFetch plus live getters for the read-only listener state. The getters are
  // read at call time so the module always sees the latest listenerHistory /
  // peakListeners written by the WS updateIcecast handler.
  FRAnalytics.init({
    authFetch: authFetch,
    getListenerHistory: function () { return listenerHistory; },
    getPeakListeners: function () { return peakListeners; }
  });

  // ============================
  // SCHEDULE
  // ============================
  var scheduleData = { weekly: {}, events: {}, settings: {} };

  function loadSchedule() {
    authFetch('/api/schedule')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        scheduleData = data;
        renderScheduleGrid();
        renderEventsList();
        renderScheduleSettings();
        loadScheduleCurrent();
      })
      .catch(function(e) { log('schedule: error: ' + e); });
  }

  function loadScheduleCurrent() {
    authFetch('/api/schedule/current')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        document.getElementById('sched-active-slot').textContent = data.label || data.slotId || '--';
        document.getElementById('sched-active-playlist').textContent = data.playlistName || '--';
        var vplEl = document.getElementById('sched-active-video-playlist');
        if (vplEl) vplEl.textContent = data.videoPlaylistName || '--';
        document.getElementById('sw-now').textContent = data.label || 'No active slot';
        document.getElementById('sw-next').textContent = data.nextLabel || '--';
      })
      .catch(function() {
        document.getElementById('sw-now').textContent = 'Schedule off';
      });
  }

  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function renderScheduleGrid() {
    var grid = document.getElementById('schedule-grid');
    grid.innerHTML = '';

    var headerRow = document.createElement('div');
    headerRow.className = 'sched-header-row';
    headerRow.innerHTML = '<div class="sched-time-col"></div>';
    DAYS.forEach(function(d) {
      headerRow.innerHTML += '<div class="sched-day-col">' + d + '</div>';
    });
    grid.appendChild(headerRow);

    for (var h = 0; h < 24; h += 2) {
      var row = document.createElement('div');
      row.className = 'sched-row';

      var timeCell = document.createElement('div');
      timeCell.className = 'sched-time-col';
      timeCell.textContent = pad(h) + ':00';
      row.appendChild(timeCell);

      for (var d = 0; d < 7; d++) {
        var cell = document.createElement('div');
        cell.className = 'sched-cell';
        cell.dataset.day = d;
        cell.dataset.hour = h;

        var slots = Object.values(scheduleData.weekly || {}).filter(function(s) {
          if (s.day !== d) return false;
          var startH = parseInt(s.startTime.split(':')[0]);
          var endH = parseInt(s.endTime.split(':')[0]);
          if (endH <= startH) endH += 24;
          return h >= startH && h < endH || (h + 24 >= startH && h + 24 < endH);
        });

        if (slots.length > 0) {
          cell.className += ' sched-cell-filled';
          cell.textContent = slots[0].label || 'Slot';
          cell.title = slots[0].label + ' (' + slots[0].startTime + '-' + slots[0].endTime + ')';
          (function(slot) {
            cell.onclick = function() {
              if (confirm('Delete slot "' + (slot.label || slot.id) + '"?')) {
                deleteWeeklySlot(slot.id);
              }
            };
          })(slots[0]);
        }

        row.appendChild(cell);
      }
      grid.appendChild(row);
    }
  }

  function renderEventsList() {
    var container = document.getElementById('events-list');
    var events = Object.values(scheduleData.events || {});
    container.innerHTML = '';
    if (events.length === 0) {
      container.innerHTML = '<div class="empty-state">No events</div>';
      return;
    }
    events.sort(function(a, b) { return a.date < b.date ? -1 : 1; });
    events.forEach(function(ev) {
      var div = document.createElement('div');
      div.className = 'event-item';
      div.innerHTML =
        '<span class="event-date">' + escapeHtml(ev.date) + '</span>' +
        '<span class="event-time">' + escapeHtml(ev.startTime) + '-' + escapeHtml(ev.endTime) + '</span>' +
        '<span class="event-label">' + escapeHtml(ev.label || 'Event') + '</span>' +
        '<button class="file-del" title="Delete">x</button>';
      div.querySelector('button').onclick = function() {
        deleteEvent(ev.id);
      };
      container.appendChild(div);
    });
  }

  function renderScheduleSettings() {
    var s = scheduleData.settings || {};
    document.getElementById('schedule-timezone').value = s.timezone || 'Europe/Moscow';
    document.getElementById('schedule-enabled').checked = s.enabled !== false;
    loadPlaylistsForSelect();
    setTimeout(function() {
      var sel = document.getElementById('schedule-default-playlist');
      sel.value = s.defaultPlaylistId || '';
    }, 500);
  }

  function loadPlaylistsForSelect() {
    // Music playlist selects live in playlists.js (window.FRPlaylists).
    FRPlaylists.loadForSelect();

    // Load video playlists for video-playlist-select dropdowns
    authFetch('/api/video-playlists')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var selects = document.querySelectorAll('.video-playlist-select');
        selects.forEach(function(sel) {
          var current = sel.value;
          sel.innerHTML = '<option value="">-- None --</option>';
          data.forEach(function(pl) {
            sel.innerHTML += '<option value="' + escapeHtml(pl.id) + '">' + escapeHtml(pl.name) + ' (' + escapeHtml('' + (pl.trackCount || 0)) + ' videos)</option>';
          });
          sel.value = current;
        });
      })
      .catch(function() {});
  }

  document.getElementById('save-schedule-settings').onclick = function() {
    var settings = {
      timezone: document.getElementById('schedule-timezone').value,
      defaultPlaylistId: document.getElementById('schedule-default-playlist').value || null,
      enabled: document.getElementById('schedule-enabled').checked
    };
    authFetch('/api/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: settings })
    })
      .then(function() { log('schedule: settings saved'); })
      .catch(function(e) { showError('Save schedule settings failed: ' + e); });
  };

  document.getElementById('add-weekly-slot-btn').onclick = function() {
    openGenericModal('Add Weekly Slot',
      '<div class="form-group"><label>Day</label><select id="slot-day">' +
      DAYS.map(function(d, i) { return '<option value="' + i + '">' + d + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="form-group"><label>Start Time</label><input type="time" id="slot-start" value="22:00"></div>' +
      '<div class="form-group"><label>End Time</label><input type="time" id="slot-end" value="06:00"></div>' +
      '<div class="form-group"><label>Playlist</label><select id="slot-playlist" class="playlist-select"><option value="">-- None --</option></select></div>' +
      '<div class="form-group"><label>Video Playlist</label><select id="slot-video-playlist" class="video-playlist-select"><option value="">-- None --</option></select></div>' +
      '<div class="form-group"><label>Label</label><input type="text" id="slot-label" placeholder="Friday Night"></div>',
      function() {
        var slot = {
          day: parseInt(document.getElementById('slot-day').value),
          startTime: document.getElementById('slot-start').value,
          endTime: document.getElementById('slot-end').value,
          playlistId: document.getElementById('slot-playlist').value || null,
          videoPlaylistId: document.getElementById('slot-video-playlist').value || null,
          label: document.getElementById('slot-label').value.trim()
        };
        authFetch('/api/schedule/weekly', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(slot)
        })
          .then(function() { closeGenericModal(); loadSchedule(); })
          .catch(function(e) { showError('Add slot failed: ' + e); });
      }
    );
    loadPlaylistsForSelect();
  };

  function deleteWeeklySlot(id) {
    authFetch('/api/schedule/weekly/' + id, { method: 'DELETE' })
      .then(function() { loadSchedule(); })
      .catch(function(e) { showError('Delete slot failed: ' + e); });
  }

  document.getElementById('add-event-btn').onclick = function() {
    openGenericModal('Add Event',
      '<div class="form-group"><label>Date</label><input type="date" id="event-date"></div>' +
      '<div class="form-group"><label>Start Time</label><input type="time" id="event-start" value="20:00"></div>' +
      '<div class="form-group"><label>End Time</label><input type="time" id="event-end" value="23:00"></div>' +
      '<div class="form-group"><label>Playlist</label><select id="event-playlist" class="playlist-select"><option value="">-- None --</option></select></div>' +
      '<div class="form-group"><label>Video Playlist</label><select id="event-video-playlist" class="video-playlist-select"><option value="">-- None --</option></select></div>' +
      '<div class="form-group"><label>Label</label><input type="text" id="event-label" placeholder="Guest DJ"></div>',
      function() {
        var ev = {
          date: document.getElementById('event-date').value,
          startTime: document.getElementById('event-start').value,
          endTime: document.getElementById('event-end').value,
          playlistId: document.getElementById('event-playlist').value || null,
          videoPlaylistId: document.getElementById('event-video-playlist').value || null,
          label: document.getElementById('event-label').value.trim()
        };
        authFetch('/api/schedule/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ev)
        })
          .then(function() { closeGenericModal(); loadSchedule(); })
          .catch(function(e) { showError('Add event failed: ' + e); });
      }
    );
    loadPlaylistsForSelect();
  };

  function deleteEvent(id) {
    if (!confirm('Delete this event?')) return;
    authFetch('/api/schedule/events/' + id, { method: 'DELETE' })
      .then(function() { loadSchedule(); })
      .catch(function(e) { showError('Delete event failed: ' + e); });
  }

  setInterval(loadScheduleCurrent, 30000);

  // ============================
  // VISUAL PROFILES
  // ============================
  // The visual-profiles UI lives in visualprofiles.js (window.FRVisualProfiles),
  // wired up via FRVisualProfiles.init(...) above (which also binds the
  // create-visual-profile-btn). Callers use FRVisualProfiles.loadVisualProfiles().


  // ============================
  // VIDEO PLAYLISTS
  // ============================
  var selectedVideoPlaylistId = null;

  function loadVideoPlaylists() {
    authFetch('/api/video-playlists')
      .then(function(r) { return r.json(); })
      .then(function(data) { renderVideoPlaylistsList(data); })
      .catch(function(e) { log('video playlists: error: ' + e); });
  }

  function renderVideoPlaylistsList(data) {
    var container = document.getElementById('video-playlists-list');
    container.innerHTML = '';
    var playlists = data || [];
    if (playlists.length === 0) {
      container.innerHTML = '<div class="empty-state">No video playlists</div>';
      return;
    }
    playlists.forEach(function(pl) {
      var div = document.createElement('div');
      div.className = 'vp-item' + (selectedVideoPlaylistId === pl.id ? ' selected' : '');
      div.onclick = function() { selectVideoPlaylist(pl.id); };

      var nameEl = document.createElement('span');
      nameEl.className = 'vp-item-name';
      nameEl.textContent = pl.name;
      div.appendChild(nameEl);

      var typeBadge = document.createElement('span');
      typeBadge.className = 'vp-active-badge';
      typeBadge.textContent = pl.type === 'smart' ? 'SMART' : 'MANUAL';
      typeBadge.style.background = pl.type === 'smart' ? '#8b5cf6' : '#6b7280';
      div.appendChild(typeBadge);

      var count = document.createElement('span');
      count.className = 'vp-count';
      count.textContent = (pl.trackCount || 0) + ' videos';
      div.appendChild(count);

      container.appendChild(div);
    });
  }

  function selectVideoPlaylist(id) {
    selectedVideoPlaylistId = id;
    var detail = document.getElementById('video-playlist-detail');
    detail.style.display = 'block';

    authFetch('/api/video-playlists/' + id)
      .then(function(r) { return r.json(); })
      .then(function(pl) { renderVideoPlaylistDetail(pl); })
      .catch(function(e) { showError('Failed to load video playlist: ' + e); });
  }

  function renderVideoPlaylistDetail(playlist) {
    document.getElementById('vpl-detail-title').textContent = playlist.name;

    var indicator = document.getElementById('vpl-type-indicator');
    indicator.textContent = playlist.type === 'smart' ? 'Smart playlist \u2014 auto-resolves by rules' : 'Manual playlist \u2014 click to add/remove';
    indicator.style.cssText = 'padding:6px 10px;margin-bottom:8px;border-radius:4px;font-size:12px;background:#1a1a2e;color:#aaa';

    var smartRules = document.getElementById('vpl-smart-rules');
    if (playlist.type === 'smart') {
      smartRules.style.display = 'block';
      var rules = playlist.rules || {};
      document.getElementById('vpl-name-pattern').value = rules.namePattern || '';
      document.getElementById('vpl-tags').value = (rules.tags || []).join(', ');
      document.getElementById('vpl-tag-mode').value = rules.tagMode || 'any';
    } else {
      smartRules.style.display = 'none';
    }

    var grid = document.getElementById('vpl-video-grid');
    grid.innerHTML = '';

    if (playlist.type === 'manual') {
      authFetch('/api/visuals-processed')
        .then(function(r) { return r.json(); })
        .then(function(allVideos) {
          var selectedSet = new Set(playlist.tracks || []);
          var ordered = [];
          (playlist.tracks || []).forEach(function(t) {
            var found = allVideos.find(function(v) { return v.name === t; });
            if (found) ordered.push({ video: found, selected: true });
          });
          allVideos.forEach(function(v) {
            if (!selectedSet.has(v.name)) {
              ordered.push({ video: v, selected: false });
            }
          });

          ordered.forEach(function(item) {
            var div = document.createElement('div');
            div.className = 'video-tile' + (item.selected ? ' selected' : '');
            div.onclick = function() {
              div.classList.toggle('selected');
              saveVideoPlaylistVideos(playlist.id);
            };

            var nameEl = document.createElement('div');
            nameEl.className = 'video-tile-name';
            nameEl.textContent = item.video.name;
            div.appendChild(nameEl);

            var sizeEl = document.createElement('div');
            sizeEl.className = 'video-tile-size';
            sizeEl.textContent = fmtSize(item.video.size);
            div.appendChild(sizeEl);

            grid.appendChild(div);
          });
        });
    } else {
      var resolved = playlist.resolvedTracks || [];
      if (resolved.length === 0) {
        grid.innerHTML = '<div class="empty-state">No matching videos</div>';
      } else {
        resolved.forEach(function(name) {
          var div = document.createElement('div');
          div.className = 'video-tile selected';
          div.style.cursor = 'default';

          var nameEl = document.createElement('div');
          nameEl.className = 'video-tile-name';
          nameEl.textContent = name;
          div.appendChild(nameEl);

          grid.appendChild(div);
        });
      }
    }

    document.getElementById('vpl-load-queue-btn').onclick = function() {
      authFetch('/api/video-playlists/' + playlist.id + '/load-queue', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          log('video playlist: loaded ' + data.loaded + ' videos to queue');
        })
        .catch(function(e) { showError('Load to queue failed: ' + e); });
    };

    document.getElementById('vpl-activate-profile-btn').onclick = function() {
      authFetch('/api/video-playlists/' + playlist.id + '/activate-profile', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          log('video playlist: activated as shuffle profile (' + data.activated + ' videos)');
          FRVisualProfiles.loadVisualProfiles();
        })
        .catch(function(e) { showError('Activate profile failed: ' + e); });
    };

    document.getElementById('vpl-delete-btn').onclick = function() {
      if (!confirm('Delete video playlist "' + playlist.name + '"?')) return;
      authFetch('/api/video-playlists/' + playlist.id, { method: 'DELETE' })
        .then(function() {
          log('video playlist: deleted ' + playlist.name);
          document.getElementById('video-playlist-detail').style.display = 'none';
          selectedVideoPlaylistId = null;
          loadVideoPlaylists();
        })
        .catch(function(e) { showError('Delete failed: ' + e); });
    };
  }

  function saveVideoPlaylistVideos(playlistId) {
    var grid = document.getElementById('vpl-video-grid');
    var selected = [];
    grid.querySelectorAll('.video-tile.selected').forEach(function(tile) {
      selected.push(tile.querySelector('.video-tile-name').textContent);
    });
    authFetch('/api/video-playlists/' + playlistId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: selected })
    }).catch(function(e) { showError('Save video playlist failed: ' + e); });
  }

  document.getElementById('vpl-update-rules-btn').onclick = function() {
    if (!selectedVideoPlaylistId) return;
    var tagsRaw = document.getElementById('vpl-tags').value.trim();
    var rules = {
      namePattern: document.getElementById('vpl-name-pattern').value.trim(),
      tags: tagsRaw ? tagsRaw.split(',').map(function(t) { return t.trim(); }).filter(Boolean) : [],
      tagMode: document.getElementById('vpl-tag-mode').value
    };
    authFetch('/api/video-playlists/' + selectedVideoPlaylistId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: rules })
    })
      .then(function() {
        log('video playlist: rules updated');
        selectVideoPlaylist(selectedVideoPlaylistId);
        loadVideoPlaylists();
      })
      .catch(function(e) { showError('Update rules failed: ' + e); });
  };

  document.getElementById('create-video-playlist-btn').onclick = function() {
    openGenericModal('Create Video Playlist',
      '<div class="form-group"><label>Name</label><input type="text" id="new-vpl-name" placeholder="Cyberpunk Visuals"></div>' +
      '<div class="form-group"><label>Type</label><select id="new-vpl-type"><option value="manual">Manual</option><option value="smart">Smart</option></select></div>',
      function() {
        var name = document.getElementById('new-vpl-name').value.trim();
        var type = document.getElementById('new-vpl-type').value;
        if (!name) return;
        authFetch('/api/video-playlists', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, type: type })
        })
          .then(function(r) { return r.json(); })
          .then(function(pl) {
            log('video playlist: created ' + name);
            closeGenericModal();
            loadVideoPlaylists();
            selectVideoPlaylist(pl.id);
          })
          .catch(function(e) { showError('Create failed: ' + e); });
      }
    );
  };

  // ============================
  // OVERLAYS
  // ============================
  var overlayConfig = { enabled: false, layers: [] };

  function loadOverlays() {
    authFetch('/api/overlays')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        overlayConfig = data;
        document.getElementById('overlays-enabled-check').checked = data.enabled;
        renderOverlayLayers();
      })
      .catch(function(e) { log('overlays: error: ' + e); });
  }

  function renderOverlayLayers() {
    var container = document.getElementById('overlay-layers');
    container.innerHTML = '';
    (overlayConfig.layers || []).forEach(function(layer, idx) {
      var div = document.createElement('div');
      div.className = 'overlay-layer' + (layer.enabled ? '' : ' disabled');

      var header = document.createElement('div');
      header.className = 'overlay-layer-header';
      header.innerHTML =
        '<label class="checkbox-label"><input type="checkbox" ' + (layer.enabled ? 'checked' : '') + '> ' +
        '<span class="overlay-type-badge">' + escapeHtml(layer.type) + '</span></label>' +
        '<button class="file-del">x</button>';
      header.querySelector('input[type="checkbox"]').addEventListener('change', function() {
        window.toggleOverlayLayer(idx, this.checked);
      });
      header.querySelector('button.file-del').addEventListener('click', function() {
        window.removeOverlayLayer(idx);
      });
      div.appendChild(header);

      var body = document.createElement('div');
      body.className = 'overlay-layer-body';

      if (layer.type === 'now_playing' || layer.type === 'scrolling_now_playing' || layer.type === 'static_text' || layer.type === 'clock' || layer.type === 'scrolling_text') {
        var isScrolling = layer.type === 'scrolling_text' || layer.type === 'scrolling_now_playing';
        body.innerHTML =
          '<div class="overlay-props">' +
          (layer.type === 'static_text' || layer.type === 'scrolling_text' ? '<div class="form-group"><label>Text</label><input type="text" value="' + escapeHtml(layer.text || '') + '" data-layer="' + idx + '" data-prop="text"></div>' : '') +
          (layer.type === 'scrolling_now_playing' ? '<div class="form-group"><label>Source</label><span class="text-secondary">Current track (auto)</span></div>' : '') +
          (isScrolling ? '<div class="form-group"><label>Speed (px/sec)</label><input type="number" value="' + escapeHtml('' + (layer.speed || 100)) + '" data-layer="' + idx + '" data-prop="speed" data-parse="int"></div>' : '') +
          (layer.type === 'clock' ? '<div class="form-group"><label>Format</label><input type="text" value="' + escapeHtml(layer.format || '%H:%M') + '" data-layer="' + idx + '" data-prop="format"></div>' : '') +
          '<div class="overlay-pos-grid">' +
          '<div class="form-group"><label>Font Size</label><input type="number" value="' + escapeHtml('' + (layer.fontsize || 28)) + '" data-layer="' + idx + '" data-prop="fontsize" data-parse="int"></div>' +
          '<div class="form-group"><label>Color</label><input type="text" value="' + escapeHtml(layer.fontcolor || 'white') + '" data-layer="' + idx + '" data-prop="fontcolor"></div>' +
          '<div class="form-group"><label>X</label><input type="text" value="' + escapeHtml('' + (layer.x || '20')) + '" data-layer="' + idx + '" data-prop="x"></div>' +
          '<div class="form-group"><label>Y</label><input type="text" value="' + escapeHtml('' + (layer.y || '20')) + '" data-layer="' + idx + '" data-prop="y"></div>' +
          '</div>' +
          '<div class="form-group"><label>Box Color</label><input type="text" value="' + escapeHtml(layer.boxcolor || '') + '" placeholder="black@0.6" data-layer="' + idx + '" data-prop="boxcolor"></div>' +
          '</div>';
      } else if (layer.type === 'logo') {
        body.innerHTML =
          '<div class="overlay-props">' +
          '<div class="form-group"><label>Asset</label><input type="text" value="' + escapeHtml(layer.asset || '') + '" data-layer="' + idx + '" data-prop="asset" placeholder="logo.png"></div>' +
          '<div class="overlay-pos-grid">' +
          '<div class="form-group"><label>X</label><input type="text" value="' + escapeHtml('' + (layer.x || 'W-w-20')) + '" data-layer="' + idx + '" data-prop="x"></div>' +
          '<div class="form-group"><label>Y</label><input type="text" value="' + escapeHtml('' + (layer.y || '20')) + '" data-layer="' + idx + '" data-prop="y"></div>' +
          '</div>' +
          '</div>';
      }
      div.appendChild(body);
      container.appendChild(div);
    });

    // Event delegation: all input[data-layer] change events
    container.addEventListener('change', function(e) {
      var input = e.target;
      if (!input.dataset || input.dataset.layer === undefined) return;
      var layerIdx = parseInt(input.dataset.layer);
      var prop = input.dataset.prop;
      var value = input.dataset.parse === 'int' ? parseInt(input.value) : input.value;
      window.updateOverlayLayer(layerIdx, prop, value);
    });
  }

  document.getElementById('overlays-enabled-check').onchange = function() {
    overlayConfig.enabled = this.checked;
    saveOverlays();
  };

  window.toggleOverlayLayer = function(idx, enabled) {
    overlayConfig.layers[idx].enabled = enabled;
    saveOverlays();
  };

  window.updateOverlayLayer = function(idx, prop, value) {
    overlayConfig.layers[idx][prop] = value;
    saveOverlays();
  };

  window.removeOverlayLayer = function(idx) {
    overlayConfig.layers.splice(idx, 1);
    saveOverlays();
    renderOverlayLayers();
  };

  function saveOverlays() {
    authFetch('/api/overlays', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(overlayConfig)
    })
      .then(function() { log('overlays: saved'); })
      .catch(function(e) { showError('Save overlays failed: ' + e); });
  }

  document.getElementById('add-overlay-btn').onclick = function() {
    openGenericModal('Add Overlay Layer',
      '<div class="form-group"><label>Type</label><select id="new-overlay-type">' +
      '<option value="now_playing">Now Playing (static)</option>' +
      '<option value="scrolling_now_playing">Now Playing (scrolling)</option>' +
      '<option value="static_text">Static Text</option>' +
      '<option value="scrolling_text">Scrolling Text</option>' +
      '<option value="clock">Clock</option>' +
      '<option value="logo">Logo</option></select></div>',
      function() {
        var type = document.getElementById('new-overlay-type').value;
        var layer = {
          id: 'ol_' + Date.now(),
          type: type,
          enabled: true,
          x: '20',
          y: '20'
        };
        if (type === 'now_playing') {
          layer.fontsize = 28;
          layer.fontcolor = 'white';
          layer.y = 'H-60';
          layer.boxcolor = 'black@0.6';
        } else if (type === 'static_text') {
          layer.text = 'STUDIO 23';
          layer.fontsize = 18;
          layer.fontcolor = 'white';
        } else if (type === 'scrolling_text') {
          layer.text = 'STUDIO 23 RADIO - HARD TECHNO 24/7';
          layer.fontsize = 32;
          layer.fontcolor = 'white';
          layer.speed = 150;
          layer.y = 'H-80';
          layer.boxcolor = 'black@0.5';
        } else if (type === 'scrolling_now_playing') {
          layer.fontsize = 32;
          layer.fontcolor = 'white';
          layer.speed = 120;
          layer.y = 'H-80';
          layer.boxcolor = 'black@0.5';
        } else if (type === 'clock') {
          layer.format = '%H:%M';
          layer.fontsize = 24;
          layer.fontcolor = 'white';
          layer.x = 'W-120';
        } else if (type === 'logo') {
          layer.asset = 'logo.png';
          layer.x = 'W-w-20';
        }
        overlayConfig.layers.push(layer);
        saveOverlays();
        closeGenericModal();
        renderOverlayLayers();
      }
    );
  };

  // Overlay assets
  function loadOverlayAssets() {
    authFetch('/api/overlays/assets')
      .then(function(r) { return r.json(); })
      .then(function(assets) {
        var container = document.getElementById('overlay-assets-list');
        container.innerHTML = '';
        if (assets.length === 0) {
          container.innerHTML = '<div class="empty-state">No assets</div>';
          return;
        }
        assets.forEach(function(a) {
          var div = document.createElement('div');
          div.className = 'overlay-asset-item';
          div.innerHTML =
            '<span class="file-name">' + escapeHtml(a.name) + '</span>' +
            '<span class="file-size">' + fmtSize(a.size) + '</span>' +
            '<button class="file-del" title="Delete">x</button>';
          div.querySelector('button').onclick = function() {
            authFetch('/api/overlays/assets/' + encodeURIComponent(a.name), { method: 'DELETE' })
              .then(function() { loadOverlayAssets(); });
          };
          container.appendChild(div);
        });
      })
      .catch(function() {});
  }

  // ============================
  // ANALYTICS
  // ============================
  // Analytics UI (loadAnalytics / drawListenerChart / loadHistoryStats /
  // drawTopTracksChart) lives in analytics.js (window.FRAnalytics), wired up via
  // FRAnalytics.init near the FRPlaylists.init call. listenerHistory and
  // peakListeners stay here (fed by the WS updateIcecast handler) and are read by
  // the module live through the injected getters.

  // ============================
  // STREAM PLATFORMS (Studio sidebar)
  // ============================
  var PLATFORM_PRESETS = {
    youtube:  { name: 'YouTube',  rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2' },
    kick:     { name: 'Kick',     rtmpUrl: '' },
    twitch:   { name: 'Twitch',   rtmpUrl: 'rtmp://live.twitch.tv/app' },
    facebook: { name: 'Facebook', rtmpUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/' },
    custom:   { name: '',         rtmpUrl: '' }
  };

  var platformList = document.getElementById('platform-list');
  var addPlatformBtn = document.getElementById('add-platform-btn');
  var platformModal = document.getElementById('platform-modal');
  var platformNameInput = document.getElementById('platform-name-input');
  var streamKeyInput = document.getElementById('stream-key-input');
  var rtmpUrlInput = document.getElementById('rtmp-url-input');
  var rtmpHelp = document.getElementById('rtmp-help');
  var platformEnabled = document.getElementById('platform-enabled');
  var presetGroup = document.getElementById('preset-group');
  var presetSelect = document.getElementById('platform-preset-select');
  var restreamAutoStartCheckbox = document.getElementById('restream-autostart-checkbox');

  // Delegates to FRUtils (single source of truth), passing the current names.
  function uniquePlatformName(base) {
    return FRU.uniquePlatformName(base, currentPlatformNames);
  }

  function applyPreset(key) {
    var preset = PLATFORM_PRESETS[key];
    if (!preset) return;
    var isCustom = key === 'custom';
    var urlEditable = isCustom || !preset.rtmpUrl;
    platformNameInput.value = isCustom ? '' : uniquePlatformName(preset.name);
    rtmpUrlInput.value = preset.rtmpUrl;
    platformNameInput.readOnly = !isCustom;
    rtmpUrlInput.readOnly = !urlEditable;
    platformNameInput.style.opacity = isCustom ? '' : '.7';
    rtmpUrlInput.style.opacity = urlEditable ? '' : '.7';
    syncPlatformHints();
  }

  presetSelect.onchange = function() { applyPreset(presetSelect.value); };

  function syncPlatformHints() {
    var name = (platformNameInput.value || '').trim().toLowerCase();
    if (name === 'kick') {
      rtmpUrlInput.placeholder = 'rtmps://<ingest>.global-contribute.live-video.net/app';
      if (rtmpHelp) rtmpHelp.textContent = 'Kick: server URL from Creator Dashboard, stream key separately.';
      return;
    }
    rtmpUrlInput.placeholder = 'rtmp://... or rtmps://...';
    if (rtmpHelp) rtmpHelp.textContent = 'Use server URL; stream key is stored separately.';
  }

  var maxPlatforms = 3;
  var currentPlatformNames = [];

  function loadPlatforms() {
    authFetch('/api/stream-keys')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        maxPlatforms = data.maxPlatforms || 3;
        currentPlatformNames = Object.keys(data.platforms);
        renderPlatforms(data.platforms);
      })
      .catch(function(e) { log('platforms: error loading: ' + e); });
  }

  function renderPlatforms(platforms) {
    platformList.innerHTML = '';
    var entries = Object.entries(platforms);
    entries.forEach(function(entry) {
      var name = entry[0];
      var config = entry[1];
      var div = document.createElement('div');
      div.className = 'platform-item' + (config.enabled ? ' enabled' : '');

      var nameEl = document.createElement('span');
      nameEl.className = 'platform-name';
      nameEl.textContent = name;
      div.appendChild(nameEl);

      var statusEl = document.createElement('span');
      statusEl.className = 'platform-status';
      statusEl.textContent = config.enabled ? 'ON' : 'OFF';
      div.appendChild(statusEl);

      var toggleBtn = document.createElement('button');
      toggleBtn.className = 'platform-toggle' + (config.enabled ? ' on' : ' off');
      toggleBtn.textContent = config.enabled ? 'Disable' : 'Enable';
      toggleBtn.onclick = function() { togglePlatform(name, !config.enabled); };
      div.appendChild(toggleBtn);

      var delBtn = document.createElement('button');
      delBtn.className = 'platform-del';
      delBtn.textContent = '\u00d7';
      delBtn.onclick = function() { deletePlatform(name); };
      div.appendChild(delBtn);

      platformList.appendChild(div);
    });

    var atLimit = entries.length >= maxPlatforms;
    addPlatformBtn.disabled = atLimit;
    addPlatformBtn.title = atLimit ? 'Limit: max ' + maxPlatforms + ' platforms' : '';
  }

  function deletePlatform(name) {
    if (!confirm('Remove ' + name + '?')) return;
    authFetch('/api/stream-keys/' + encodeURIComponent(name), { method: 'DELETE' })
      .then(function() {
        log('platform removed: ' + name);
        loadPlatforms();
      })
      .catch(function(e) { showError('Remove failed: ' + e); });
  }

  function togglePlatform(name, enabled) {
    authFetch('/api/stream-keys/' + encodeURIComponent(name) + '/enabled', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.success) throw new Error(data.error || 'toggle failed');
        log('platform ' + name + ': ' + (enabled ? 'ENABLED' : 'DISABLED'));
        loadPlatforms();
      })
      .catch(function(e) { showError('Platform toggle failed: ' + e); });
  }

  addPlatformBtn.onclick = function() {
    streamKeyInput.value = '';
    platformEnabled.checked = true;
    presetGroup.style.display = '';
    presetSelect.value = 'youtube';
    applyPreset('youtube');
    platformModal.style.display = 'flex';
  };

  platformNameInput.oninput = syncPlatformHints;

  window.closePlatformModal = function() {
    platformModal.style.display = 'none';
  };

  window.savePlatform = function() {
    var name = platformNameInput.value.trim();
    var rtmpUrl = rtmpUrlInput.value.trim();
    var key = streamKeyInput.value.trim();
    var enabled = platformEnabled.checked;

    if (!name) { alert('Please enter platform name'); return; }
    if (!rtmpUrl) { alert('Please enter RTMP URL'); return; }
    if (!key) { alert('Please enter stream key'); return; }

    authFetch('/api/stream-keys/' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled, streamKey: key, rtmpUrl: rtmpUrl })
    })
      .then(function(r) {
        if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || 'save failed'); });
        log('platform saved: ' + name);
        closePlatformModal();
        loadPlatforms();
      })
      .catch(function(e) { showError('Save failed: ' + e.message); });
  };

  platformModal.onclick = function(e) {
    if (e.target === platformModal) closePlatformModal();
  };

  function loadRestreamSettings() {
    authFetch('/api/restream/settings')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        restreamAutoStartCheckbox.checked = !!data.autoStart;
      })
      .catch(function(e) { log('restream settings: error loading: ' + e); });
  }

  restreamAutoStartCheckbox.onchange = function() {
    authFetch('/api/restream/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoStart: restreamAutoStartCheckbox.checked })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.success) throw new Error(data.error || 'save failed');
        log('restream autostart: ' + (data.autoStart ? 'ON' : 'OFF'));
      })
      .catch(function(e) { showError('Restream autostart save failed: ' + e); });
  };

  loadPlatforms();
  loadRestreamSettings();
  setInterval(loadPlatforms, 30000);

  // --- Broadcast Control ---
  // States: idle → arming → armed → broadcasting → live
  //         idle → playing → live
  var broadcastModeTag = document.getElementById('broadcast-mode-tag');
  var btnBroadcast = document.getElementById('btn-broadcast');
  var btnPlay = document.getElementById('btn-play');
  var btnStop = document.getElementById('btn-stop');
  var liveModeSettings = document.getElementById('live-mode-bar');
  var liveStatusBadge = document.getElementById('live-status-badge');
  var liveIngestUrl = document.getElementById('live-ingest-url');
  var liveIngestKey = document.getElementById('live-ingest-key');
  var liveAfkFallback = document.getElementById('live-afk-fallback');
  var liveSourcePills = document.querySelectorAll('.live-source-pill');
  var playerOverlay = document.getElementById('player-overlay');
  var playerOverlayText = document.getElementById('player-overlay-text');
  var modeHint = document.getElementById('transport-mode-hint');
  // State: streaming=ffmpeg running, broadcast=RTMP active, streamMode=standby|armed|live
  // uiMode/uiSubMode — frontend mode (radio/talkover/takeover)
  var broadcastState = { streaming: false, broadcast: false, streamMode: 'standby', standbyVisual: null, visualMode: 'visual-radio', arming: false, liveMode: { source: 'obs', afkFallback: 'visual-radio', obsStatus: 'offline', ingestKey: '' }, uiMode: 'radio', uiSubMode: 'visual-radio' };
  var armAborted = false;

  // Derived phase from state.
  // Delegates to FRUtils (single source of truth), passing the broadcast state.
  function getBroadcastPhase() {
    return FRU.getBroadcastPhase(broadcastState);
  }

  var btnArm = document.getElementById('btn-arm');

  var MODE_HINTS = {
    idle: {
      'live': 'Stopped. OBS/mic stream with AFK fallback.',
      'visual-radio': 'Stopped. Press PLAY to start, or ARM to prepare.',
      'video-playlist': 'Stopped. Press PLAY to start, or ARM to prepare.'
    },
    arming: {
      'live': 'Arming: warming up pipeline...',
      'visual-radio': 'Arming: warming up DJ + video pipeline...',
      'video-playlist': 'Arming: warming up video pipeline...'
    },
    armed: {
      'live': 'Armed. Press PLAY to go live. OBS connects to RTMP ingest.',
      'visual-radio': 'Armed. Press PLAY to go live (~2s), or BROADCAST for RTMP first.',
      'video-playlist': 'Armed. Press PLAY to go live (~2s), or BROADCAST for RTMP first.'
    },
    playing: {
      'live': 'Preview: waiting for OBS or AFK fallback.',
      'visual-radio': 'Preview: DJ music + shuffled videos. Press BROADCAST to go live.',
      'video-playlist': 'Preview: videos with own audio. Press BROADCAST to go live.'
    },
    broadcasting: {
      'live': 'On air: waiting for OBS. AFK fallback active.',
      'visual-radio': 'On air: poster on RTMP. Press PLAY for content (~2s).',
      'video-playlist': 'On air: poster on RTMP. Press PLAY for content (~2s).'
    },
    live: {
      'live': 'Live: OBS streaming. AFK fallback on disconnect.',
      'visual-radio': 'Live: DJ music + shuffled videos, broadcasting to RTMP.',
      'video-playlist': 'Live: videos with own audio, broadcasting to RTMP.'
    }
  };

  function updateBroadcastUI() {
    var phase = getBroadcastPhase();
    var s = broadcastState;

    // Mode tag
    var tagText = { idle: 'OFF', arming: 'ARMING', armed: 'ARMED', playing: 'PREVIEW', broadcasting: 'ON AIR', live: 'LIVE' };
    var tagClass = { idle: 'off', arming: 'arming', armed: 'ready', playing: 'preview', broadcasting: 'broadcasting', live: 'live' };
    broadcastModeTag.textContent = tagText[phase] || 'OFF';
    broadcastModeTag.className = 'mode-tag ' + (tagClass[phase] || 'off');

    // Button states:
    // | idle | ARM:on  PLAY:on  STOP:off BROADCAST:off SKIP:off |
    // | arming       | ARM:off PLAY:off STOP:on  BROADCAST:off SKIP:off |
    // | armed        | ARM:off PLAY:on  STOP:on  BROADCAST:on  SKIP:off |
    // | playing      | ARM:off PLAY:off STOP:on  BROADCAST:on  SKIP:on  |
    // | broadcasting | ARM:off PLAY:on  STOP:on  BROADCAST:END SKIP:off |
    // | live         | ARM:off PLAY:off STOP:on  BROADCAST:END SKIP:on  |
    btnArm.disabled = phase !== 'idle';
    btnArm.style.display = (phase === 'idle' || phase === 'arming') ? '' : 'none';

    btnPlay.disabled = !(phase === 'armed' || phase === 'playing' || phase === 'broadcasting');

    btnStop.disabled = phase === 'idle';

    var canBroadcast = phase === 'armed' || phase === 'playing' || phase === 'broadcasting' || phase === 'live';
    btnBroadcast.disabled = !canBroadcast;
    btnBroadcast.textContent = (phase === 'broadcasting' || phase === 'live') ? 'END' : 'BROADCAST';

    skipBtn.disabled = !(phase === 'playing' || phase === 'live');

    // Update mode cards UI
    updateModeUI();

    // Mode-aware queue
    var isVideoMode = s.visualMode === 'video-playlist';
    queuePanelTitle.textContent = isVideoMode ? 'Video Queue' : 'Queue';
    queueSelectorTitle.textContent = isVideoMode ? 'Add Video' : 'Add to Queue';
    queueSearch.placeholder = isVideoMode ? 'Search videos...' : 'Search tracks...';
    skipBtn.onclick = isVideoMode ? skipVideo : function() {
      authFetch('/api/queue/skip', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok) {
            log('queue: skipped track');
            setTimeout(loadQueue, 1000);
            setTimeout(loadTrackHistory, 2000);
          }
        })
        .catch(function(e) { showError('Skip failed: ' + e); });
    };
    clearQueueBtn.onclick = isVideoMode ? clearVideoQueue : function() {
      authFetch('/api/queue/clear', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok) {
            log('queue: cleared');
            loadQueue();
          }
        })
        .catch(function(e) { showError('Clear queue failed: ' + e); });
    };

    // Mode hint
    var hints = MODE_HINTS[phase] || {};
    modeHint.textContent = hints[s.visualMode] || '';
  }

  // ============================
  // MODE CARD STATE MACHINE
  // ============================

  // Map UI → backend visual_mode
  function applyUiMode(mode, subMode) {
    var oldUi = broadcastState.uiMode;
    var oldSub = broadcastState.uiSubMode;
    broadcastState.uiMode = mode;
    broadcastState.uiSubMode = subMode;

    // Persist in localStorage for restore after reload
    try {
      localStorage.setItem('studio23_uiMode', mode);
      localStorage.setItem('studio23_uiSubMode', subMode);
    } catch(e) {}

    // Determine backend visual_mode
    var apiMode;
    switch (mode) {
      case 'radio':
        apiMode = subMode; // 'visual-radio' or 'video-playlist'
        break;
      case 'talkover':
        apiMode = 'visual-radio'; // Phase 1: music keeps playing
        break;
      case 'takeover':
        apiMode = 'live';
        break;
      default:
        apiMode = 'visual-radio';
    }

    log('UI MODE ' + oldUi + '/' + oldSub + ' → ' + mode + '/' + subMode + ' (api: ' + apiMode + ')');

    // Send if visual_mode changed
    if (apiMode !== broadcastState.visualMode) {
      broadcastState.visualMode = apiMode;

      if (broadcastState.streamMode === 'live') {
        pendingModeSwitch = true;
        showLoading('Switching mode...', 'pill', 30000);
      }

      authFetch('/api/visual-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: apiMode })
      }).then(function() {
        loadActiveQueue();
        if (queueSearch) renderTrackSelector(queueSearch.value);
      }).catch(function(e) {
        showError('Mode change failed: ' + e);
      });
    }

    updateModeUI();
    updateBroadcastUI();
  }

  // Reverse map: backend → UI mode (on load/WS).
  // Delegates to FRUtils for the derivation, then applies the AS-IS mutation of
  // broadcastState (FRUtils returns a value; app.js keeps mutating in place and
  // returns undefined, exactly as before).
  function deriveUiMode() {
    var d = FRU.deriveUiMode(broadcastState.visualMode);
    broadcastState.uiMode = d.uiMode;
    broadcastState.uiSubMode = d.uiSubMode;
  }

  // Update UI: card highlighting, CSS classes, locking
  function updateModeUI() {
    var mode = broadcastState.uiMode;
    var subMode = broadcastState.uiSubMode;
    var layout = document.querySelector('.studio-layout');
    if (!layout) return;

    // Remove all mode/submode classes
    layout.classList.remove('mode-radio', 'mode-talkover', 'mode-takeover');
    layout.classList.remove('submode-visual-radio', 'submode-video-playlist', 'submode-browser-mic', 'submode-obs');

    // Set current
    layout.classList.add('mode-' + mode);
    if (subMode) layout.classList.add('submode-' + subMode);

    // Highlight cards
    var cards = document.querySelectorAll('.mode-card');
    cards.forEach(function(card) {
      var isActive = card.dataset.mode === mode;
      card.classList.toggle('active', isActive);
    });

    // Highlight sub-pills in active card
    var activeCard = document.querySelector('.mode-card[data-mode="' + mode + '"]');
    if (activeCard) {
      var pills = activeCard.querySelectorAll('.mode-sub-pill');
      pills.forEach(function(pill) {
        pill.classList.toggle('active', pill.dataset.submode === subMode);
      });
    }

    // Lock cards while on air
    var locked = broadcastState.streamMode !== 'standby';
    cards.forEach(function(card) {
      card.classList.toggle('mode-locked', locked && !card.classList.contains('active'));
    });

    // Live Mode Bar: show in talkover/obs and takeover
    var showLive = (mode === 'talkover' && subMode === 'obs') || mode === 'takeover';
    if (liveModeSettings) liveModeSettings.style.display = showLive ? '' : 'none';
    if (showLive) updateLiveModeUI();

    // AFK fallback select in Takeover card — sync with liveMode
    var takeoverAfk = document.getElementById('takeover-afk-fallback');
    if (takeoverAfk && broadcastState.liveMode) {
      takeoverAfk.value = broadcastState.liveMode.afkFallback || 'visual-radio';
    }
  }

  // Mode card click handlers
  document.querySelectorAll('.mode-card').forEach(function(card) {
    card.addEventListener('click', function(e) {
      // Don't switch if clicked on sub-pill, select, or label
      if (e.target.closest('.mode-sub-pill') || e.target.closest('select') || e.target.closest('.mode-afk-label')) return;
      // Don't switch while on air
      if (broadcastState.streamMode !== 'standby') return;

      var mode = card.dataset.mode;
      if (mode === broadcastState.uiMode) return;

      // Default sub-mode for each card
      var defaults = { radio: 'visual-radio', talkover: 'browser-mic', takeover: 'obs' };
      applyUiMode(mode, defaults[mode]);
    });
  });

  // Sub-pill click handlers
  document.querySelectorAll('.mode-sub-pill').forEach(function(pill) {
    pill.addEventListener('click', function(e) {
      e.stopPropagation();
      var card = pill.closest('.mode-card');
      var mode = card.dataset.mode;
      var subMode = pill.dataset.submode;
      // Don't switch while on air (unless card is already active)
      if (broadcastState.streamMode !== 'standby' && mode !== broadcastState.uiMode) return;
      if (broadcastState.streamMode !== 'standby') return;
      applyUiMode(mode, subMode);
    });
  });

  // AFK fallback select in Takeover card
  var takeoverAfkSelect = document.getElementById('takeover-afk-fallback');
  if (takeoverAfkSelect) {
    takeoverAfkSelect.addEventListener('change', function(e) {
      e.stopPropagation();
      var fb = takeoverAfkSelect.value;
      broadcastState.liveMode.afkFallback = fb;
      authFetch('/api/live-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ afkFallback: fb })
      }).catch(function(e) { showError('AFK fallback change failed: ' + e); });
      log('takeover: afk fallback → ' + fb);
    });
  }

  // ========== ARM ==========
  // Pre-warm pipeline + player. ARM is only "ready" when player has frames.
  btnArm.onclick = function() {
    userInteracted = true;
    if (broadcastState.arming || broadcastState.streamMode === 'armed') return;
    // Init analyzer on user gesture (AudioContext needs it)
    if (!azInited) azInit();
    broadcastState.arming = true;
    updateBroadcastUI();
    log('ARM: starting...');

    // Stop noise, mute — player starts later (after API + cleanup)
    stopStaticNoise();
    setPlayerMuted(true);
    // Loading screen for entire ARMING duration — hide stuttery video
    showLoading('Arming...', 'arm', 20000);

    // ARM = video pipeline only. Audio starts on PLAY.

    // API calls: start FFmpeg + set armed mode
    authFetch('/api/stream/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streaming: true })
    })
      .then(function() {
        if (armAborted) throw new Error('aborted');
        return authFetch('/api/stream/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'armed', standbyVisual: null })
        });
      })
      .then(function() {
        if (armAborted) throw new Error('aborted');
        broadcastState.streaming = true;
        broadcastState.streamMode = 'armed';
        log('ARM: APIs done, waiting for server cleanup...');

        // 3s delay: let server pick up streaming:true,
        // flush stale HLS segments and start FFmpeg
        setTimeout(function() {
          if (armAborted) {
            broadcastState.arming = false;
            armAborted = false;
            updateBroadcastUI();
            return;
          }
          log('ARM: starting player (server had 3s to clean up)');
          restartPlayer('arm');

        // Detect real video (not black screen) via canvas pixel check
        var armCanvas = document.createElement('canvas');
        armCanvas.width = 16;
        armCanvas.height = 16;
        var armCtx = armCanvas.getContext('2d', { willReadFrequently: true });

        function isVideoBlack() {
          try {
            armCtx.drawImage(studioPlayer, 0, 0, 16, 16);
            var data = armCtx.getImageData(0, 0, 16, 16).data;
            var sum = 0;
            for (var i = 0; i < data.length; i += 4) {
              sum += data[i] + data[i+1] + data[i+2];
            }
            return (sum / (16 * 16 * 3)) < 10; // avg brightness < 10 = black
          } catch(e) { return true; }
        }

        var checkReady = function() {
          if (armAborted) {
            broadcastState.arming = false;
            armAborted = false;
            updateBroadcastUI();
            return;
          }
          if (studioPlayer.readyState >= 3 && studioPlayer.videoWidth > 0 && !isVideoBlack()) {
            broadcastState.arming = false;
            hideLoading('arm-ready');
            updateBroadcastUI();
            log('ARM: ready — video not black, content visible');
          } else {
            setTimeout(checkReady, 300);
          }
        };
        checkReady();
        // Safety: mark ready after 15s regardless
        setTimeout(function() {
          if (broadcastState.arming) {
            broadcastState.arming = false;
            hideLoading('arm-safety');
            updateBroadcastUI();
            log('ARM: ready (safety timeout — video may still be loading)');
          }
        }, 15000);
        }, 3000); // end of setTimeout player start delay
      })
      .catch(function(e) {
        if (e.message !== 'aborted') showError('Arm failed: ' + e);
        broadcastState.arming = false;
        armAborted = false;
        updateBroadcastUI();
      });
  };

  // ========== PLAY ==========
  btnPlay.onclick = function() {
    userInteracted = true;
    // Init analyzer on user gesture (AudioContext needs it)
    if (!azInited) azInit();

    // --- From PREVIEW (playing without broadcast): just open gate ---
    if (broadcastState.streamMode === 'live' && !broadcastState.broadcast) {
      authFetch('/api/dj/resume', { method: 'POST' }).catch(function(){});
      authFetch('/api/stream/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broadcast: true })
      }).catch(function(){});
      broadcastState.broadcast = true;
      setPlayerMuted(false);
      playerMuteBtn.innerHTML = '&#128266;';
      playerMuteBtn.title = 'Mute';
      playerMuteBtn.classList.add('unmuted');
      updateBroadcastUI();
      log('PLAY: gate opened from preview');
      return;
    }

    // --- From ARMED: open gate, wait for music to fill pipeline, seek to live edge ---
    if (broadcastState.streamMode === 'armed') {
      if (aliveTimer) { clearTimeout(aliveTimer); aliveTimer = null; }
      clearAllTimers('play-armed');
      pendingModeSwitch = false;
      overlayLockedUntil = 0;
      hideLoading('play-armed');
      btnPlay.disabled = true;
      playTransitionLock = true;

      // Cue track → wait for cross buffer → resume → mode live (sequential)
      authFetch('/api/dj/cue', { method: 'POST' })
        .then(function() {
          showLoading('Cueing track...', 'pill', 7000);
          return new Promise(function(resolve) { setTimeout(resolve, 5500); });
        })
        .then(function() { return authFetch('/api/dj/resume', { method: 'POST' }); })
        .then(function(r) {
          if (!r.ok) throw new Error('dj/resume HTTP ' + r.status);
          return authFetch('/api/stream/mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'live' })
          });
        })
        .then(function() {
          broadcastState.streamMode = 'live';
          updateBroadcastUI();
          flashTransition();
          hideLoading('play-armed-done');
          setPlayerMuted(false);
          playerMuteBtn.innerHTML = '&#128266;';
          playerMuteBtn.title = 'Mute';
          playerMuteBtn.classList.add('unmuted');
          log('PLAY: gate open, track from beginning');
          // Replay cached audio — updateAudio skipped it during armed
          if (lastAudioMsg) updateAudio(lastAudioMsg);
        })
        .catch(function(e) {
          log('PLAY: cue/resume FAILED: ' + e);
          showError('Audio start failed');
          hideLoading('play-armed-err');
          broadcastState.streamMode = 'armed';
          updateBroadcastUI();
        })
        .then(function() {
          playTransitionLock = false;
        });
      return;
    }

    // --- Cold start from IDLE (~4-5s) ---
    btnPlay.disabled = true;
    playTransitionLock = true;
    flashTransition();
    setPlayerMuted(true);
    log('PLAY: cold start');

    // Ensure streaming on + DJ resume + live mode
    authFetch('/api/stream/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streaming: true })
    })
      .then(function() { return authFetch('/api/dj/cue', { method: 'POST' }); })
      .then(function() {
        showLoading('Cueing track...', 'pill', 7000);
        return new Promise(function(resolve) { setTimeout(resolve, 5500); });
      })
      .then(function() { return authFetch('/api/dj/resume', { method: 'POST' }); })
      .then(function() {
        return authFetch('/api/stream/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'live', standbyVisual: null })
        });
      })
      .then(function() {
        broadcastState.streaming = true;
        broadcastState.streamMode = 'live';
        updateBroadcastUI();
        // Stop static noise immediately — video appears when HLS connects
        stopStaticNoise();
        log('PLAY: pipeline live, waiting for content...');
        // Replay cached audio — may have arrived while streamMode was standby
        if (lastAudioMsg) updateAudio(lastAudioMsg);
        // Give pipeline 3s: gate already open, Liquidsoap playing track from 0:00,
        // FFmpeg writing first HLS segments with music. After player restart
        // it picks up fresh segments and starts from track beginning.
        setTimeout(function() {
          restartPlayer('play');
          var unmuteDone = false;
          var doUnmute = function() {
            if (unmuteDone) return;
            unmuteDone = true;
            flashTransition();
            if (studioPlayer.seekable.length > 0) {
              var edge = studioPlayer.seekable.end(studioPlayer.seekable.length - 1) - 0.1;
              if (edge > 0) studioPlayer.currentTime = edge;
            }
            setPlayerMuted(false);
            playerMuteBtn.innerHTML = '&#128266;';
            playerMuteBtn.title = 'Mute';
            playerMuteBtn.classList.add('unmuted');
            playTransitionLock = false;
            btnPlay.disabled = false;
            log('PLAY: live');
          };
          studioPlayer.addEventListener('canplay', function onReady() {
            studioPlayer.removeEventListener('canplay', onReady);
            doUnmute();
          });
          // Safety: unmute after 4s regardless
          setTimeout(doUnmute, 4000);
        }, 3000);
      })
      .catch(function(e) {
        showError('Play failed: ' + e);
        hideLoading('play-cold-err');
        playTransitionLock = false;
        btnPlay.disabled = false;
      });
  };

  // ========== BROADCAST / END ==========
  btnBroadcast.onclick = function() {
    if (broadcastState.arming) return;
    var newBroadcast = !broadcastState.broadcast;
    btnBroadcast.disabled = true;
    showLoading(newBroadcast ? 'Starting broadcast...' : 'Ending broadcast...', 'broadcast', 4000);
    authFetch('/api/stream/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ broadcast: newBroadcast })
    })
      .then(function(r) { return r.json(); })
      .then(function() {
        broadcastState.broadcast = newBroadcast;
        updateBroadcastUI();
        log('BROADCAST: ' + (newBroadcast ? 'ON' : 'OFF') + ' (phase: ' + getBroadcastPhase() + ')');
      })
      .catch(function(e) {
        showError((newBroadcast ? 'Broadcast start' : 'Broadcast end') + ' failed: ' + e);
        btnBroadcast.disabled = false;
      });
  };

  // ========== STOP ==========
  btnStop.onclick = function() {
    if (broadcastState.arming) armAborted = true;
    broadcastState.arming = false;
    playTransitionLock = false;

    btnStop.disabled = true;
    startStaticNoise();
    flashTransition();
    setPlayerMuted(true);
    studioPlayer.pause();
    playerMuteBtn.innerHTML = '&#128263;';
    playerMuteBtn.title = 'Unmute';
    playerMuteBtn.classList.remove('unmuted');
    log('STOP');

    // Stop DJ + standby + end broadcast
    authFetch('/api/dj/stop', { method: 'POST' }).catch(function(){});
    Promise.all([
      authFetch('/api/stream/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'standby' })
      }),
      authFetch('/api/stream/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broadcast: false })
      })
    ])
      .then(function() {
        broadcastState.streamMode = 'standby';
        broadcastState.broadcast = false;
        lastAudioMsg = null;
        studioAudioTrack.textContent = '--';
        studioBpm.textContent = '';
        trackStartedAt = 0;
        trackDuration = 0;
        trackMixDur = 0;
        transportBarFill.style.width = '0%';
        transportElapsed.textContent = '0:00';
        transportDuration.textContent = '0:00';
        transportCue.style.display = 'none';
        updateBroadcastUI();
        log('STOP: idle');
      })
      .catch(function(e) {
        showError('Stop failed: ' + e);
        stopStaticNoise();
        btnStop.disabled = false;
      });
  };

  // --- Live Mode UI ---
  function updateLiveModeUI() {
    if (!liveAfkFallback) return; // Phase 1: Live Mode Bar hidden
    var lm = broadcastState.liveMode;
    // Source pills
    liveSourcePills.forEach(function(pill) {
      pill.classList.toggle('active', pill.dataset.source === lm.source);
    });
    // AFK fallback
    if (liveAfkFallback.value !== lm.afkFallback) {
      liveAfkFallback.value = lm.afkFallback;
    }
    // Status badge
    var statusText = { offline: 'OFFLINE', connected: 'LIVE', disconnected: 'AFK' };
    liveStatusBadge.textContent = statusText[lm.obsStatus] || 'OFFLINE';
    liveStatusBadge.className = 'live-status-badge ' + (lm.obsStatus || 'offline');
    // Ingest URL
    var host = window.location.hostname;
    liveIngestUrl.value = 'rtmp://' + host + ':1935/ingest/';
    // Key
    if (liveIngestKey.type === 'password') {
      liveIngestKey.value = lm.ingestKey || '';
    } else {
      liveIngestKey.value = lm.ingestKey || '';
    }
  }

  // Source pill clicks
  liveSourcePills.forEach(function(pill) {
    pill.addEventListener('click', function() {
      var src = pill.dataset.source;
      broadcastState.liveMode.source = src;
      authFetch('/api/live-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: src })
      }).catch(function(e) { showError('Live source change failed: ' + e); });
      updateLiveModeUI();
      log('live: source → ' + src);
    });
  });

  // AFK fallback change
  if (liveAfkFallback) liveAfkFallback.onchange = function() {
    var fb = liveAfkFallback.value;
    broadcastState.liveMode.afkFallback = fb;
    authFetch('/api/live-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ afkFallback: fb })
    }).catch(function(e) { showError('AFK fallback change failed: ' + e); });
    log('live: afk fallback → ' + fb);
  };

  // Copy URL button
  var liveCopyUrl = document.getElementById('live-copy-url');
  if (liveCopyUrl) liveCopyUrl.onclick = function() {
    navigator.clipboard.writeText(liveIngestUrl.value).then(function() {
      log('live: ingest URL copied');
    });
  };

  // Copy key button
  var liveCopyKey = document.getElementById('live-copy-key');
  if (liveCopyKey) liveCopyKey.onclick = function() {
    navigator.clipboard.writeText(broadcastState.liveMode.ingestKey || '').then(function() {
      log('live: stream key copied');
    });
  };

  // Show/hide key
  var liveShowKey = document.getElementById('live-show-key');
  if (liveShowKey) liveShowKey.onclick = function() {
    var btn = liveShowKey;
    if (liveIngestKey.type === 'password') {
      liveIngestKey.type = 'text';
      btn.textContent = 'Hide';
    } else {
      liveIngestKey.type = 'password';
      btn.textContent = 'Show';
    }
  };

  // Regenerate key
  var liveRegenKey = document.getElementById('live-regen-key');
  if (liveRegenKey) liveRegenKey.onclick = function() {
    if (!confirm('Regenerate ingest key? OBS will need to be updated.')) return;
    authFetch('/api/live-mode/generate-key', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        broadcastState.liveMode.ingestKey = data.ingestKey;
        updateLiveModeUI();
        log('live: key regenerated');
      })
      .catch(function(e) { showError('Key regeneration failed: ' + e); });
  };

  // Load processed visuals for video profiles
  function loadProcessedVisuals() {
    authFetch('/api/visuals-processed')
      .then(function(r) { return r.json(); })
      .then(function(files) {
        processedVisualFiles = files;
      })
      .catch(function(e) { log('visuals-processed: error: ' + e); });
  }

  // Batch-poll: 1 request instead of 4 (save connection pool for HLS)
  function loadBroadcastState() {
    authFetch('/api/status').then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.streamControl) {
          broadcastState.streaming = data.streamControl.streaming;
          broadcastState.broadcast = !!data.streamControl.broadcast;
        }
        if (data.streamMode) {
          broadcastState.streamMode = data.streamMode.mode || 'standby';
          broadcastState.standbyVisual = data.streamMode.standbyVisual;
        }
        if (data.visualMode) {
          broadcastState.visualMode = data.visualMode.mode || 'visual-radio';
        }
        if (data.liveMode) broadcastState.liveMode = data.liveMode;
        deriveUiMode();
        updateBroadcastUI();
        if (!playTransitionLock && !broadcastState.arming) {
          var phase = getBroadcastPhase();
          if (phase === 'idle' && !noiseActive) {
            startStaticNoise();
            setPlayerMuted(true);
          } else if ((phase === 'playing' || phase === 'live') && noiseActive) {
            stopStaticNoise();
            setPlayerMuted(!playerMuteBtn.classList.contains('unmuted'));
          }
        }
      })
      .catch(function(e) { log('broadcast state: error: ' + e); });
  }

  loadProcessedVisuals();
  loadBroadcastState();
  setInterval(loadBroadcastState, 15000);
  setInterval(loadProcessedVisuals, 30000);

  // --- Quality Settings ---
  function loadQuality() {
    authFetch('/api/quality')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.current && data.current.preset) {
          qualitySelect.value = data.current.preset;
          log('quality: current = ' + data.current.preset);
        }
      })
      .catch(function(e) { log('quality: error loading: ' + e); });
  }

  qualitySelect.onchange = function() {
    var preset = qualitySelect.value;
    authFetch('/api/quality', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: preset })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success) {
          log('quality: changed to ' + preset + ' (' + data.settings.name + ')');
        }
      })
      .catch(function(e) { showError('Quality change failed: ' + e); });
  };

  loadQuality();

  // --- Mixing Mode ---
  function loadMixingConfig() {
    authFetch('/api/mixing/config')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.mode) {
          currentMixMode = data.mode;
          updateMixModeUI();
          log('mixing: mode = ' + data.mode);
        }
      })
      .catch(function() {});
  }

  function setMixingMode(mode) {
    authFetch('/api/mixing/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok || data.mode) {
          currentMixMode = mode;
          updateMixModeUI();
          // Recalculate cue marker for new mode
          var filename = (studioAudioTrack.textContent || '').split('/').pop();
          var bpm = studioBpm.textContent ? parseInt(studioBpm.textContent) : 0;
          trackMixDur = computeMixDur(bpm);
          positionCueMarker();
          log('mixing: changed to ' + mode);
        }
      })
      .catch(function(e) { log('mixing: error: ' + e); });
  }

  function updateMixModeUI() {
    mixPills.forEach(function(pill) {
      if (pill.dataset.mixmode === currentMixMode) {
        pill.classList.add('active');
      } else {
        pill.classList.remove('active');
      }
    });
  }

  mixPills.forEach(function(pill) {
    pill.addEventListener('click', function() {
      var mode = pill.dataset.mixmode;
      if (mode && mode !== currentMixMode) {
        setMixingMode(mode);
      }
    });
  });

  loadMixingConfig();

  // --- Audio Enhancement Settings ---
  var audioEnhanceCheck = document.getElementById('audio-enhance');

  function loadAudioSettings() {
    authFetch('/api/audio')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (audioEnhanceCheck) {
          audioEnhanceCheck.checked = data.enhanced === true;
          log('audio: enhancement = ' + (data.enhanced ? 'ON' : 'OFF'));
        }
      })
      .catch(function(e) { log('audio: error loading settings: ' + e); });
  }

  if (audioEnhanceCheck) {
    audioEnhanceCheck.onchange = function() {
      var enabled = audioEnhanceCheck.checked;
      authFetch('/api/audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enhanced: enabled })
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success) {
            log('audio: enhancement ' + (enabled ? 'ENABLED' : 'DISABLED'));
          }
        })
        .catch(function(e) { showError('Audio settings change failed: ' + e); });
    };
  }

  loadAudioSettings();

  // --- Video Enhancement Settings ---
  var videoEnhanceCheck = document.getElementById('video-enhance');

  function loadVideoSettings() {
    authFetch('/api/video')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (videoEnhanceCheck) {
          videoEnhanceCheck.checked = data.enhanced === true;
          log('video: enhancement = ' + (data.enhanced ? 'ON' : 'OFF'));
        }
      })
      .catch(function(e) { log('video: error loading settings: ' + e); });
  }

  if (videoEnhanceCheck) {
    videoEnhanceCheck.onchange = function() {
      var enabled = videoEnhanceCheck.checked;
      authFetch('/api/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enhanced: enabled })
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success) {
            log('video: enhancement ' + (enabled ? 'ENABLED' : 'DISABLED'));
          }
        })
        .catch(function(e) { showError('Video settings change failed: ' + e); });
    };
  }

  loadVideoSettings();

  // ============================
  // CHANNEL STRIP
  // ============================
  var stripBypass = document.getElementById("strip-bypass");
  var stripPreset = document.getElementById("strip-preset");
  var stripBypassBadge = document.getElementById("strip-bypass-badge");
  var stripGateLed = document.getElementById("strip-gate-led");
  var stripCompGr = document.getElementById("strip-comp-gr");
  var stripDebounce = null;
  var stripMeteringInterval = null;
  var stripLoaded = false;

  // All channel strip sliders
  var STRIP_PARAMS = [
    { id: "strip-gate-threshold", key: "gate_threshold", unit: " dB" },
    { id: "strip-gate-attack", key: "gate_attack", unit: " ms" },
    { id: "strip-gate-release", key: "gate_release", unit: " ms" },
    { id: "strip-eq-low-freq", key: "eq_low_freq", unit: " Hz" },
    { id: "strip-eq-low-slope", key: "eq_low_slope", unit: " dB" },
    { id: "strip-eq-mid-freq", key: "eq_mid_freq", unit: " Hz" },
    { id: "strip-eq-mid-gain", key: "eq_mid_gain", unit: " dB" },
    { id: "strip-eq-mid-q", key: "eq_mid_q", unit: "", fmt: function(v) { return parseFloat(v).toFixed(1); } },
    { id: "strip-eq-high-freq", key: "eq_high_freq", unit: " Hz" },
    { id: "strip-eq-high-slope", key: "eq_high_slope", unit: " dB" },
    { id: "strip-comp-threshold", key: "comp_threshold", unit: " dB" },
    { id: "strip-comp-ratio", key: "comp_ratio", unit: ":1" },
    { id: "strip-comp-attack", key: "comp_attack", unit: " ms" },
    { id: "strip-comp-release", key: "comp_release", unit: " ms" },
    { id: "strip-comp-makeup", key: "comp_makeup", unit: " dB" },
    { id: "strip-lim-threshold", key: "lim_threshold", unit: " dB" },
    { id: "strip-output-gain", key: "output_gain", unit: " dB", fmt: function(v) { return (20 * Math.log10(Math.max(0.001, parseFloat(v)))).toFixed(1); } }
  ];

  // Update slider value display
  function stripUpdateVal(param) {
    var el = document.getElementById(param.id);
    var valEl = document.getElementById(param.id + "-val");
    if (!el || !valEl) return;
    var v = el.value;
    var display = param.fmt ? param.fmt(v) : v;
    valEl.textContent = display + param.unit;
  }

  // Load config from server
  function stripLoadConfig() {
    authFetch("/api/channel-strip")
      .then(function(r) { return r.json(); })
      .then(function(data) {
        stripLoaded = true;
        if (data.bypass !== undefined) {
          if (stripBypass) stripBypass.checked = !!data.bypass;
          stripUpdateBadge(data.bypass);
        }
        STRIP_PARAMS.forEach(function(param) {
          if (data[param.key] !== undefined) {
            var el = document.getElementById(param.id);
            if (el) {
              el.value = data[param.key];
              stripUpdateVal(param);
            }
          }
        });
        log("strip: config loaded (bypass=" + data.bypass + ")");
      })
      .catch(function(e) { log("strip: load error: " + e); });
  }

  function stripUpdateBadge(bypass) {
    if (!stripBypassBadge) return;
    var grid = document.getElementById("channel-strip-grid");
    if (bypass) {
      stripBypassBadge.textContent = "BYPASS";
      stripBypassBadge.className = "strip-badge bypass";
      if (grid) grid.classList.add("bypassed");
    } else {
      stripBypassBadge.textContent = "ACTIVE";
      stripBypassBadge.className = "strip-badge active";
      if (grid) grid.classList.remove("bypassed");
    }
  }

  // Send changes with debounce
  function stripSendConfig(params) {
    clearTimeout(stripDebounce);
    stripDebounce = setTimeout(function() {
      authFetch("/api/channel-strip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params)
      }).catch(function(e) { log("strip: send error: " + e); });
    }, 50);
  }

  // Bypass toggle
  if (stripBypass) stripBypass.onchange = function() {
    var bypass = stripBypass.checked;
    stripUpdateBadge(bypass);
    stripSendConfig({ bypass: bypass });
    stripPreset.value = "";
    log("strip: bypass=" + bypass);
    // Start/stop metering
    if (!bypass) stripStartMetering();
    else stripStopMetering();
  };

  // Preset selector
  if (stripPreset) stripPreset.onchange = function() {
    var name = stripPreset.value;
    if (!name) return;
    authFetch("/api/channel-strip/preset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          log("strip: preset=" + name);
          stripLoadConfig();
        } else {
          showError("Strip preset failed: " + (data.error || "unknown"));
        }
      })
      .catch(function(e) { showError("Strip preset failed: " + e); });
  };

  // Sliders — oninput
  STRIP_PARAMS.forEach(function(param) {
    var el = document.getElementById(param.id);
    if (!el) return;
    el.oninput = function() {
      stripUpdateVal(param);
      var obj = {};
      obj[param.key] = parseFloat(el.value);
      stripSendConfig(obj);
      stripPreset.value = "";
    };
  });

  // Metering polling (300ms)
  function stripStartMetering() {
    if (stripMeteringInterval) return;
    stripMeteringInterval = setInterval(function() {
      authFetch("/api/channel-strip/metering")
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var gateOpen = data.gate > 0.5;
          // Gate LED (large, meters column)
          if (stripGateLed) {
            stripGateLed.className = "strip-led-large" + (gateOpen ? " open" : "");
          }
          // Compact gate LED (header)
          var compactGate = document.getElementById("strip-compact-gate");
          if (compactGate) {
            compactGate.className = "strip-led" + (gateOpen ? " open" : "");
          }
          // Compressor GR meter (vertical)
          if (stripCompGr) {
            var gr = data.comp_gain || 0;
            var grDb = Math.max(-20, Math.min(0, gr));
            var pct = Math.abs(grDb) / 20 * 100;
            var fill = stripCompGr.querySelector(".strip-gr-vertical-fill");
            if (fill) fill.style.height = pct + "%";
            // GR value text
            var grVal = document.getElementById("strip-gr-value");
            if (grVal) grVal.textContent = grDb.toFixed(1) + " dB";
          }
          // Compact GR text (header)
          var compactGr = document.getElementById("strip-compact-gr");
          if (compactGr) {
            var grDb2 = Math.max(-20, Math.min(0, data.comp_gain || 0));
            compactGr.textContent = grDb2.toFixed(1) + " dB";
          }
        })
        .catch(function() {});
    }, 300);
  }

  function stripStopMetering() {
    if (stripMeteringInterval) {
      clearInterval(stripMeteringInterval);
      stripMeteringInterval = null;
    }
    // Reset LED and GR meter
    if (stripGateLed) stripGateLed.className = "strip-led-large";
    if (stripCompGr) {
      var fill = stripCompGr.querySelector(".strip-gr-vertical-fill");
      if (fill) fill.style.height = "0%";
    }
    var grVal = document.getElementById("strip-gr-value");
    if (grVal) grVal.textContent = "0 dB";
    var compactGate = document.getElementById("strip-compact-gate");
    if (compactGate) compactGate.className = "strip-led";
    var compactGr = document.getElementById("strip-compact-gr");
    if (compactGr) compactGr.textContent = "0 dB";
  }

  if (stripBypass) {
    stripLoadConfig();
    // Start metering if strip is active
    setTimeout(function() {
      if (stripLoaded && stripBypass && !stripBypass.checked) stripStartMetering();
    }, 2000);
  }

  // ============================
  // GENERIC MODAL
  // ============================
  var genericModal = document.getElementById('generic-modal');
  var genericModalSave = document.getElementById('generic-modal-save');
  var genericModalCallback = null;

  function openGenericModal(title, bodyHtml, onSave) {
    document.getElementById('generic-modal-title').textContent = title;
    document.getElementById('generic-modal-body').innerHTML = bodyHtml;
    genericModalCallback = onSave;
    genericModal.style.display = 'flex';
  }

  window.closeGenericModal = function() {
    genericModal.style.display = 'none';
    genericModalCallback = null;
  };

  genericModalSave.onclick = function() {
    if (genericModalCallback) genericModalCallback();
  };

  genericModal.onclick = function(e) {
    if (e.target === genericModal) closeGenericModal();
  };

  // ---- Push-to-Talk ----

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

  // Preview: play
  pttPlayBtn.onclick = function() {
    if (!pttBlobUrl) return;
    if (pttPreviewAudio) { pttPreviewAudio.pause(); }
    pttPreviewAudio = new Audio(pttBlobUrl);
    pttPreviewAudio.play().catch(function() {});
  };

  // Preview: discard
  pttDiscardBtn.onclick = function() {
    log('PTT: discarded');
    pttReset();
  };

  // Preview: send to air
  pttSendBtn.onclick = function() {
    pttSend();
  };

  // --- PTT Settings ---
  var pttConfigDebounce = null;

  pttSettingsBtn.onclick = function() {
    var visible = pttConfig.style.display !== 'none';
    pttConfig.style.display = visible ? 'none' : 'flex';
    pttSettingsBtn.classList.toggle('active', !visible);
    if (!visible) pttLoadConfig();
  };

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

  pttDuckSlider.oninput = function() {
    pttDuckValue.textContent = pttDuckSlider.value + '%';
    clearTimeout(pttConfigDebounce);
    pttConfigDebounce = setTimeout(pttSaveConfig, 300);
  };

  pttGainSlider.oninput = function() {
    var gain = (parseInt(pttGainSlider.value) / 10).toFixed(1);
    pttGainValue.textContent = gain + 'x';
    clearTimeout(pttConfigDebounce);
    pttConfigDebounce = setTimeout(pttSaveConfig, 300);
  };

  // ============================================================
  // MONITOR MIXER — Talk Over mode + Live/AFK browser mic
  // ============================================================
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

  // DOM refs — Monitor Mixer
  var mmPanel = document.getElementById('monitor-mixer');
  var mmStatusBadge = document.getElementById('mm-status-badge');
  var mmMicBtn = document.getElementById('mm-mic-btn');
  var mmMonBtn = document.getElementById('mm-mon-btn');
  var mmDuckBtn = document.getElementById('mm-duck-btn');
  var micInputSelect = document.getElementById('mic-input-select');
  var micOutputSelect = document.getElementById('mic-output-select');

  // Faders
  var mmMicFader = document.getElementById('mm-mic-fader');
  var mmMicVal = document.getElementById('mm-mic-val');
  var mmMusicFader = document.getElementById('mm-music-fader');
  var mmMusicVal = document.getElementById('mm-music-val');
  var mmMasterFader = document.getElementById('mm-master-fader');
  var mmMasterVal = document.getElementById('mm-master-val');
  var mmDuckAmount = document.getElementById('mm-duck-amount');
  var mmDuckVal = document.getElementById('mm-duck-val');
  var mmDuckSpeedSel = document.getElementById('mm-duck-speed');

  // Meter canvases
  var mmMicMeterCanvas = document.getElementById('mm-mic-meter');
  var mmMicMeterCtx = mmMicMeterCanvas ? mmMicMeterCanvas.getContext('2d') : null;
  var mmMusicMeterCanvas = document.getElementById('mm-music-meter');
  var mmMusicMeterCtx = mmMusicMeterCanvas ? mmMusicMeterCanvas.getContext('2d') : null;
  var mmMasterMeterCanvas = document.getElementById('mm-master-meter');
  var mmMasterMeterCtx = mmMasterMeterCanvas ? mmMasterMeterCanvas.getContext('2d') : null;

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
    if (!azInited) azInit();

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
    if (duckActive && azGainNode && azAudioCtx && !studioPlayer.muted) {
      azGainNode.gain.setTargetAtTime(monitorMusicGain * mmMasterGain, azAudioCtx.currentTime, 0.05);
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
    if (azAudioCtx && azAudioCtx.setSinkId) {
      azAudioCtx.setSinkId(outputId).catch(function(e) {
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
    var musicData = azMain ? new Uint8Array(azMain.frequencyBinCount) : null;

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
      if (azMain && musicData && !studioPlayer.muted) {
        musicLevel = computeLevels(azMain, musicData);
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
      if (duckEnabled && micActive && azGainNode && azAudioCtx && !studioPlayer.muted) {
        var speeds = duckSpeeds[duckSpeed] || duckSpeeds.medium;
        if (micLevel.rms > duckThreshold) {
          // Voice detected — duck music
          if (!duckActive) {
            var duckedGain = monitorMusicGain * mmMasterGain * duckMultiplier;
            azGainNode.gain.setTargetAtTime(duckedGain, azAudioCtx.currentTime, speeds.attack);
            duckActive = true;
          }
        } else {
          // Voice gone — restore
          if (duckActive) {
            var normalGain = monitorMusicGain * mmMasterGain;
            azGainNode.gain.setTargetAtTime(normalGain, azAudioCtx.currentTime, speeds.release);
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
      if (!duckEnabled && duckActive && azGainNode && azAudioCtx && !studioPlayer.muted) {
        azGainNode.gain.setTargetAtTime(monitorMusicGain * mmMasterGain, azAudioCtx.currentTime, 0.05);
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
      if (azGainNode && azAudioCtx && !studioPlayer.muted) {
        azGainNode.gain.setValueAtTime(monitorMusicGain * mmMasterGain, azAudioCtx.currentTime);
      }
    });
  }

  // Master fader → update music and mic monitor gain
  if (mmMasterFader) {
    mmMasterFader.addEventListener('input', function() {
      mmMasterGain = parseInt(mmMasterFader.value) / 100;
      if (mmMasterVal) mmMasterVal.textContent = parseInt(mmMasterFader.value) + '%';
      // Update music gain
      if (azGainNode && azAudioCtx && !studioPlayer.muted) {
        azGainNode.gain.setValueAtTime(monitorMusicGain * mmMasterGain, azAudioCtx.currentTime);
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

  // ============================================================
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
    var isTalkover = broadcastState.uiMode === 'talkover';
    var isLiveBrowserMic = broadcastState.visualMode === 'live' &&
                           broadcastState.liveMode.source === 'browser-mic';
    var isOnAir = broadcastState.streamMode === 'live' || broadcastState.streamMode === 'armed';

    // Stream if: (talkover + mic on + on air) OR (live/browser-mic + on air)
    var shouldStream = (isTalkover && micActive && isOnAir) ||
                       (isLiveBrowserMic && isOnAir && micActive);

    if (shouldStream && !micStreaming) {
      startMicStreaming();
    } else if (!shouldStream && micStreaming) {
      stopMicStreaming();
    }
  }

  // Check mic streaming state periodically
  setInterval(checkMicStreaming, 2000);

  // ============================================================
  // CRT ANALYZER — multi-mode audio visualizer
  // ============================================================
  var azCanvas = document.getElementById('analyzer-canvas');
  var azCrt = document.getElementById('analyzer-crt');
  var azWrap = document.getElementById('analyzer-wrap');
  var azInfo = document.getElementById('analyzer-info');
  var azCtx = null;
  var azAudioCtx = null;
  var azGainNode = null;
  var azMain = null;
  var azL = null;
  var azR = null;
  var azMode = 'spectrum';
  var azAnimFrame = null;
  var azInited = false;
  var azPeaks = [];
  var azPeakHoldL = -100;
  var azPeakHoldR = -100;
  var azSpectroTmp = null;
  var azSpectroCol = null;
  var azW = 0, azH = 0;

  // --- Theme system ---
  var azThemeNames = ['phosphor', 'amber', 'neon', 'vapor', 'ice', 'fire'];
  var azThemes = {
    phosphor: {
      label: 'GRN',
      hex: '#c4ffcb',
      hoverHex: '#d8ffe0',
      primary: [196, 255, 203],
      spectrumColor: function(r) {
        if (r < 0.5) { var t = r * 2; return [20+80*t|0, 180+75*t|0, 40+215*t|0]; }
        var t = (r - 0.5) * 2; return [100+155*t|0, 255, 255];
      },
      spectroColor: function(v) {
        if (v < 15) return [5, 10, 14];
        if (v < 70) { var t = (v-15)/55; return [5+25*t|0, 15+150*t|0, 14+35*t|0]; }
        if (v < 150) { var t = (v-70)/80; return [30+70*t|0, 165+90*t|0, 49+206*t|0]; }
        var t = Math.min(1, (v-150)/105); return [100+155*t|0, 255, 255];
      },
      levelStops: [
        [0, 'rgba(196,255,203,0.8)'], [0.6, 'rgba(196,255,203,0.8)'],
        [0.8, 'rgba(255,230,160,0.85)'], [0.95, 'rgba(255,179,179,0.9)'], [1, 'rgba(255,100,100,0.95)']
      ]
    },
    amber: {
      label: 'AMB',
      hex: '#ffb43c',
      hoverHex: '#ffc870',
      primary: [255, 180, 60],
      spectrumColor: function(r) {
        if (r < 0.5) { var t = r * 2; return [80+120*t|0, 40+80*t|0, 0+10*t|0]; }
        var t = (r - 0.5) * 2; return [200+55*t|0, 120+100*t|0, 10+70*t|0];
      },
      spectroColor: function(v) {
        if (v < 15) return [8, 4, 2];
        if (v < 70) { var t = (v-15)/55; return [8+72*t|0, 4+36*t|0, 2+3*t|0]; }
        if (v < 150) { var t = (v-70)/80; return [80+120*t|0, 40+90*t|0, 5+10*t|0]; }
        var t = Math.min(1, (v-150)/105); return [200+55*t|0, 130+100*t|0, 15+85*t|0];
      },
      levelStops: [
        [0, 'rgba(255,180,60,0.8)'], [0.6, 'rgba(255,180,60,0.8)'],
        [0.8, 'rgba(255,220,100,0.85)'], [0.95, 'rgba(255,130,80,0.9)'], [1, 'rgba(255,80,50,0.95)']
      ]
    },
    neon: {
      label: 'NEON',
      hex: '#a0ffc8',
      hoverHex: '#c0ffd8',
      primary: [160, 255, 200],
      spectrumColor: function(r) {
        if (r < 0.35) { var t = r / 0.35; return [10+30*t|0, 160+95*t|0, 60+60*t|0]; }
        if (r < 0.65) { var t = (r-0.35)/0.3; return [40+140*t|0, 255-115*t|0, 120+110*t|0]; }
        var t = (r - 0.65) / 0.35; return [180+75*t|0, 140+60*t|0, 230+25*t|0];
      },
      spectroColor: function(v) {
        if (v < 15) return [4, 8, 6];
        if (v < 70) { var t = (v-15)/55; return [4+11*t|0, 8+152*t|0, 6+54*t|0]; }
        if (v < 150) { var t = (v-70)/80; return [15+145*t|0, 160-80*t|0, 60+140*t|0]; }
        var t = Math.min(1, (v-150)/105); return [160+95*t|0, 80+120*t|0, 200+55*t|0];
      },
      levelStops: [
        [0, 'rgba(100,255,170,0.8)'], [0.6, 'rgba(100,255,170,0.8)'],
        [0.8, 'rgba(200,160,255,0.85)'], [0.95, 'rgba(255,120,200,0.9)'], [1, 'rgba(255,80,160,0.95)']
      ]
    },
    vapor: {
      label: 'VPR',
      hex: '#ff6ec8',
      hoverHex: '#ff99d8',
      primary: [255, 110, 200],
      spectrumColor: function(r) {
        if (r < 0.5) { var t = r * 2; return [20+80*t|0, 140+60*t|0, 170+60*t|0]; }
        var t = (r - 0.5) * 2; return [100+155*t|0, 200-90*t|0, 230-30*t|0];
      },
      spectroColor: function(v) {
        if (v < 15) return [6, 3, 10];
        if (v < 70) { var t = (v-15)/55; return [6+24*t|0, 3+77*t|0, 10+120*t|0]; }
        if (v < 150) { var t = (v-70)/80; return [30+150*t|0, 80-20*t|0, 130+30*t|0]; }
        var t = Math.min(1, (v-150)/105); return [180+75*t|0, 60+100*t|0, 160+70*t|0];
      },
      levelStops: [
        [0, 'rgba(80,200,240,0.8)'], [0.6, 'rgba(80,200,240,0.8)'],
        [0.8, 'rgba(220,120,255,0.85)'], [0.95, 'rgba(255,90,180,0.9)'], [1, 'rgba(255,60,120,0.95)']
      ]
    },
    ice: {
      label: 'ICE',
      hex: '#8cd2ff',
      hoverHex: '#b0e0ff',
      primary: [140, 210, 255],
      spectrumColor: function(r) {
        if (r < 0.5) { var t = r * 2; return [10+50*t|0, 40+100*t|0, 120+100*t|0]; }
        var t = (r - 0.5) * 2; return [60+160*t|0, 140+105*t|0, 220+35*t|0];
      },
      spectroColor: function(v) {
        if (v < 15) return [3, 5, 12];
        if (v < 70) { var t = (v-15)/55; return [3+7*t|0, 5+45*t|0, 12+118*t|0]; }
        if (v < 150) { var t = (v-70)/80; return [10+50*t|0, 50+100*t|0, 130+100*t|0]; }
        var t = Math.min(1, (v-150)/105); return [60+160*t|0, 150+95*t|0, 230+25*t|0];
      },
      levelStops: [
        [0, 'rgba(140,210,255,0.8)'], [0.6, 'rgba(140,210,255,0.8)'],
        [0.8, 'rgba(200,235,255,0.85)'], [0.95, 'rgba(255,180,180,0.9)'], [1, 'rgba(255,100,100,0.95)']
      ]
    },
    fire: {
      label: 'FIRE',
      hex: '#ff8228',
      hoverHex: '#ffa060',
      primary: [255, 130, 40],
      spectrumColor: function(r) {
        if (r < 0.35) { var t = r / 0.35; return [80+120*t|0, 8+17*t|0, 0+5*t|0]; }
        if (r < 0.7) { var t = (r-0.35)/0.35; return [200+55*t|0, 25+105*t|0, 5+10*t|0]; }
        var t = (r - 0.7) / 0.3; return [255, 130+110*t|0, 15+65*t|0];
      },
      spectroColor: function(v) {
        if (v < 15) return [8, 2, 1];
        if (v < 70) { var t = (v-15)/55; return [8+92*t|0, 2+8*t|0, 1+1*t|0]; }
        if (v < 150) { var t = (v-70)/80; return [100+120*t|0, 10+60*t|0, 2+3*t|0]; }
        var t = Math.min(1, (v-150)/105); return [220+35*t|0, 70+140*t|0, 5+75*t|0];
      },
      levelStops: [
        [0, 'rgba(255,100,20,0.8)'], [0.6, 'rgba(255,100,20,0.8)'],
        [0.8, 'rgba(255,200,60,0.85)'], [0.95, 'rgba(255,240,180,0.9)'], [1, 'rgba(255,255,240,0.95)']
      ]
    }
  };

  var azThemeName = localStorage.getItem('ui-theme') || localStorage.getItem('az-theme') || 'phosphor';
  if (!azThemes[azThemeName]) azThemeName = 'phosphor';
  var azTheme = azThemes[azThemeName];

  function azRGBA(a) {
    var p = azTheme.primary;
    return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + a + ')';
  }

  function azSetTheme(name) {
    if (!azThemes[name]) return;
    azThemeName = name;
    azTheme = azThemes[name];
    localStorage.setItem('ui-theme', name);
    // Update CSS accent on root (whole UI)
    var p = azTheme.primary;
    var root = document.documentElement.style;
    root.setProperty('--accent', azTheme.hex);
    root.setProperty('--accent-rgb', p[0] + ', ' + p[1] + ', ' + p[2]);
    root.setProperty('--accent-hover', azTheme.hoverHex);
    root.setProperty('--green', azTheme.hex);
    // Analyzer wrapper accent
    if (azWrap) azWrap.style.setProperty('--az-accent-rgb', p[0] + ',' + p[1] + ',' + p[2]);
    var themeBtn = document.getElementById('ui-theme-btn');
    if (themeBtn) themeBtn.textContent = azTheme.label;
    // Reset spectrogram buffer on theme change
    azSpectroTmp = null;
    azSpectroCol = null;
    if (azCtx) azCtx.clearRect(0, 0, azW, azH);
    if (!azInited) azDrawIdle();
  }

  function azResize() {
    if (!azCrt) return;
    var rect = azCrt.getBoundingClientRect();
    azW = Math.floor(rect.width);
    azH = Math.floor(rect.height);
    if (azW < 1 || azH < 1) return;
    azCanvas.width = azW;
    azCanvas.height = azH;
    azSpectroTmp = null;
    azSpectroCol = null;
    azCtx = azCanvas.getContext('2d');
    if (!azInited) azDrawIdle();
  }


  // --- Server-side FFT: virtual AnalyserNode for Safari ---
  var azServerFFT = false;

  function AzServerAnalyser(binCount) {
    this.frequencyBinCount = binCount;
    this.fftSize = binCount * 2;
    this.smoothingTimeConstant = 0;
    this._freq = new Float32Array(binCount);       // current (smoothed)
    this._freqTarget = new Uint8Array(binCount);   // target from server
    this._time = new Float32Array(binCount * 2);
    this._timeTarget = new Float32Array(binCount * 2);
  }
  AzServerAnalyser.prototype.getByteFrequencyData = function(dst) {
    // Fast attack / slow decay
    var f = this._freq, t = this._freqTarget;
    for (var i = 0; i < f.length; i++) {
      var lerp = t[i] > f[i] ? 0.92 : 0.6;
      f[i] += (t[i] - f[i]) * lerp;
    }
    var len = Math.min(dst.length, f.length);
    for (var i = 0; i < len; i++) dst[i] = f[i] + 0.5 | 0;
  };
  AzServerAnalyser.prototype.getFloatTimeDomainData = function(dst) {
    var tm = this._time, tt = this._timeTarget;
    for (var i = 0; i < tm.length; i++) {
      tm[i] += (tt[i] - tm[i]) * 0.7;
    }
    var len = Math.min(dst.length, tm.length);
    for (var i = 0; i < len; i++) dst[i] = tm[i];
  };

  // --- Pre-allocated circular buffer for FFT (zero-alloc in hot path) ---
  var AZ_RING_CAP = 600;       // ~6.4 sec at 94fps
  var azRingSpec = new Array(AZ_RING_CAP);
  var azRingWL  = new Array(AZ_RING_CAP);
  var azRingWR  = new Array(AZ_RING_CAP);
  var azRingTs  = new Float64Array(AZ_RING_CAP);
  var azRingHead = 0;          // next write position
  var azRingLen  = 0;          // how many filled
  var azMeasuredDelay = null;
  var azLastDelayCheck = 0;

  // Pre-allocate all slots once
  for (var _ri = 0; _ri < AZ_RING_CAP; _ri++) {
    azRingSpec[_ri] = new Uint8Array(1024);
    azRingWL[_ri]   = new Float32Array(512);
    azRingWR[_ri]   = new Float32Array(512);
  }

  function handleFftFrame(buf) {
    if (buf[0] !== 0x01 || !azServerFFT) return;

    // Write to pre-allocated slot — ZERO allocations
    var slot = azRingHead;
    var sp = azRingSpec[slot];
    for (var i = 0; i < 1024 && (1 + i) < buf.length; i++) sp[i] = buf[1 + i];

    var wl = azRingWL[slot];
    for (var i = 0; i < 512 && (1025 + i) < buf.length; i++) {
      var v = buf[1025 + i];
      wl[i] = (v > 127 ? v - 256 : v) / 127.0;
    }

    var wr = azRingWR[slot];
    for (var i = 0; i < 512 && (1537 + i) < buf.length; i++) {
      var v = buf[1537 + i];
      wr[i] = (v > 127 ? v - 256 : v) / 127.0;
    }

    azRingTs[slot] = Date.now();
    azRingHead = (azRingHead + 1) % AZ_RING_CAP;
    if (azRingLen < AZ_RING_CAP) azRingLen++;
  }

  function azMeasureHlsDelay() {
    var now = Date.now();
    if (now - azLastDelayCheck < 2000) return;
    azLastDelayCheck = now;
    try {
      if (studioPlayer.seekable.length > 0 && studioPlayer.currentTime > 0) {
        var edge = studioPlayer.seekable.end(studioPlayer.seekable.length - 1);
        var pos = studioPlayer.currentTime;
        var bufDelay = edge - pos;
        if (bufDelay > 0 && bufDelay < 30) {
          var measured = bufDelay + 1.0;
          if (azMeasuredDelay === null) {
            azMeasuredDelay = measured;
            log('ANALYZER: measured HLS delay=' + measured.toFixed(1) + 's');
          } else {
            azMeasuredDelay = azMeasuredDelay * 0.85 + measured * 0.15;
          }
        }
      }
    } catch(e) {}
  }

  function azPickDelayedFrame() {
    azMeasureHlsDelay();
    var delay = (azMeasuredDelay || 4) + azSyncOffset;
    var targetTs = Date.now() - delay * 1000;

    // Search from end of circular buffer (newest → oldest)
    for (var j = 1; j <= azRingLen; j++) {
      var idx = (azRingHead - j + AZ_RING_CAP) % AZ_RING_CAP;
      if (azRingTs[idx] <= targetTs) {
        azMain._freqTarget.set(azRingSpec[idx]);
        azL._timeTarget.set(azRingWL[idx]);
        azR._timeTarget.set(azRingWR[idx]);
        return;
      }
    }
  }

  var azStreamAbort = null; // AbortController for Safari stream fallback

  function azInitAnalysers() {
    azMain = azAudioCtx.createAnalyser();
    azMain.fftSize = 2048;
    azMain.smoothingTimeConstant = 0.82;
    azL = azAudioCtx.createAnalyser();
    azL.fftSize = 512;
    azL.smoothingTimeConstant = 0.75;
    azR = azAudioCtx.createAnalyser();
    azR.fftSize = 512;
    azR.smoothingTimeConstant = 0.75;
  }

  // --- Sync delay for Safari stream decode ---
  // Measured ONCE at startup (seekable + pipeline offset).
  // User adjusts via +/-sync buttons, saved in localStorage.
  var azFixedDelay = null; // null = not yet measured
  var azSyncOffset = parseFloat(localStorage.getItem('az-sync-offset')) || 0;

  function azGetHlsDelay() {
    if (azFixedDelay !== null) return azFixedDelay + azSyncOffset;
    try {
      if (studioPlayer.seekable.length > 0 && studioPlayer.currentTime > 0) {
        var edge = studioPlayer.seekable.end(studioPlayer.seekable.length - 1);
        var pos = studioPlayer.currentTime;
        var bufDelay = edge - pos;
        if (bufDelay > 0 && bufDelay < 30) {
          azFixedDelay = bufDelay + 1.5;
          log('ANALYZER: delay fixed=' + azFixedDelay.toFixed(1) + 's, offset=' + azSyncOffset.toFixed(1) + 's');
          return azFixedDelay + azSyncOffset;
        }
      }
    } catch(e) {}
    return 4 + azSyncOffset; // fallback
  }

  function azAdjustSync(delta) {
    azSyncOffset = Math.round((azSyncOffset + delta) * 10) / 10;
    azSyncOffset = Math.max(-5, Math.min(5, azSyncOffset));
    localStorage.setItem('az-sync-offset', azSyncOffset);
    var total = (azFixedDelay || 4) + azSyncOffset;
    log('ANALYZER: sync offset=' + azSyncOffset.toFixed(1) + 's, total=' + total.toFixed(1) + 's');
    // Update UI
    var lbl = document.getElementById('az-sync-label');
    if (lbl) lbl.textContent = (azSyncOffset >= 0 ? '+' : '') + azSyncOffset.toFixed(1) + 's';
  }

  // Safari fallback: fetch Icecast → decodeAudioData → feed AnalyserNode.
  // Ring buffer: data stored with timestamp, played back with delay.
  // Safari fallback: fetch Icecast → decodeAudioData → feed AnalyserNode.
  // Each chunk delayed via setTimeout by hlsDelay, then start(0).
  // No contiguous scheduling — AnalyserNode doesn't need smooth splicing.
  var azStreamGen = 0; // stream generation for cancelling stale setTimeouts

  function azStartStreamDecode() {
    var gen = ++azStreamGen; // new generation — old setTimeouts won't fire
    azStreamAbort = new AbortController();
    log('ANALYZER: stream decode active (v3 setTimeout)');

    function playChunk(buf) {
      if (gen !== azStreamGen) return; // stale — stream already restarted
      var src = azAudioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(azMain);
      if (buf.numberOfChannels >= 2) {
        var sp = azAudioCtx.createChannelSplitter(2);
        src.connect(sp);
        sp.connect(azL, 0);
        sp.connect(azR, 1);
      } else {
        src.connect(azL);
        src.connect(azR);
      }
      src.start(0); // immediately — delay already handled in setTimeout
    }

    authFetch('/api/audio-stream', { signal: azStreamAbort.signal }).then(function(resp) {
      var reader = resp.body.getReader();
      var chunks = [];
      var total = 0;
      var DECODE_SIZE = 8000;
      var logged = false;

      function pump() {
        reader.read().then(function(result) {
          if (result.done) return;
          chunks.push(result.value);
          total += result.value.length;

          if (total >= DECODE_SIZE) {
            var merged = new Uint8Array(total);
            var off = 0;
            for (var i = 0; i < chunks.length; i++) {
              merged.set(chunks[i], off);
              off += chunks[i].length;
            }
            chunks = [];
            total = 0;

            var delayMs = azGetHlsDelay() * 1000;
            azAudioCtx.decodeAudioData(merged.buffer).then(function(buf) {
              if (gen !== azStreamGen) return;
              setTimeout(function() { playChunk(buf); }, delayMs);
              if (!logged) {
                logged = true;
                var seekInfo = 'N/A';
                try {
                  if (studioPlayer.seekable.length > 0 && studioPlayer.currentTime > 0) {
                    seekInfo = (studioPlayer.seekable.end(0) - studioPlayer.currentTime).toFixed(2) + 's';
                  }
                } catch(e) {}
                log('ANALYZER: streaming, delay=' + (delayMs/1000).toFixed(1) + 's, seekable=' + seekInfo);
              }
            }).catch(function() {});
          }
          pump();
        }).catch(function() {});
      }
      pump();
    }).catch(function(e) {
      if (e.name !== 'AbortError') log('ANALYZER: fetch error — ' + e.message);
    });
  }

  function azInit() {
    if (azInited) return;

      if (isSafari) {
        // Safari: WebKit bug 180696 — createMediaElementSource doesn't work with HLS.
        // Hide analyzer completely.
        var awrap = document.getElementById('analyzer-wrap');
        if (awrap) awrap.style.display = 'none';
        log('ANALYZER: Safari — hidden (WebKit bug 180696)');
        return;
      }

    try {
      azAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (azAudioCtx.state === 'suspended') azAudioCtx.resume();

      azInitAnalysers();
      azPeaks = new Array(64).fill(0);

      // Chrome/Firefox path: createMediaElementSource works with HLS
      var source = azAudioCtx.createMediaElementSource(studioPlayer);
      azGainNode = azAudioCtx.createGain();
      azGainNode.gain.value = studioPlayer.muted ? 0 : 1;

      var splitter = azAudioCtx.createChannelSplitter(2);
      source.connect(azMain);
      source.connect(splitter);
      splitter.connect(azL, 0);
      splitter.connect(azR, 1);
      source.connect(azGainNode);
      azGainNode.connect(azAudioCtx.destination);

      azInited = true;
      azInfo.textContent = (azAudioCtx.sampleRate / 1000) + 'kHz';
      log('ANALYZER: Chrome mode — createMediaElementSource, sr=' + azAudioCtx.sampleRate);
      azLoop();
    } catch (e) {
      log('ANALYZER: init failed — ' + e.message);
      if (azAudioCtx) { azAudioCtx.close().catch(function(){}); azAudioCtx = null; }
    }
  }

  function setPlayerMuted(muted) {
    if (!muted && !userInteracted) return; // never unmute without user gesture
    studioPlayer.muted = muted;
    if (azGainNode && azAudioCtx) {
      // Use monitorMusicGain * mmMasterGain instead of hardcoded 1
      azGainNode.gain.setValueAtTime(muted ? 0 : monitorMusicGain * mmMasterGain, azAudioCtx.currentTime);
    }
  }

  // --- Idle state ---
  function azDrawIdle() {
    if (!azCtx || azW < 1 || azH < 1) return;
    azCtx.clearRect(0, 0, azW, azH);
    azDrawGrid(azCtx, azW, azH);
    azCtx.font = '11px monospace';
    azCtx.fillStyle = azRGBA(0.2);
    azCtx.textAlign = 'center';
    azCtx.textBaseline = 'middle';
    azCtx.fillText('SIGNAL STANDBY', azW / 2, azH / 2);
    azCtx.textBaseline = 'alphabetic';
  }

  // --- Main loop ---
  function azLoop() {
    azAnimFrame = requestAnimationFrame(azLoop);
    if (!azInited || !azMain || !azCtx || azW < 1 || azH < 1) return;
    if (azServerFFT) azPickDelayedFrame();
    switch (azMode) {
      case 'spectrum': azDrawSpectrum(); break;
      case 'spectrogram': azDrawSpectrogram(); break;
      case 'scope': azDrawScope(); break;
      case 'levels': azDrawLevels(); break;
    }
    azUpdateGlow();
  }

  // --- Grid ---
  function azDrawGrid(ctx, w, h) {
    ctx.strokeStyle = 'rgba(36, 50, 68, 0.4)';
    ctx.lineWidth = 1;
    for (var i = 1; i < 4; i++) {
      var y = Math.floor(h * i / 4) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    for (var i = 1; i < 8; i++) {
      var x = Math.floor(w * i / 8) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
  }

  // --- SPECTRUM ---
  function azDrawSpectrum() {
    var ctx = azCtx, w = azW, h = azH;
    var bufLen = azMain.frequencyBinCount;
    var data = new Uint8Array(bufLen);
    azMain.getByteFrequencyData(data);

    ctx.clearRect(0, 0, w, h);
    azDrawGrid(ctx, w, h);

    var numBars = 64;
    var barW = w / numBars;
    var gap = 1;
    var sr = azAudioCtx.sampleRate;
    var logMin = Math.log10(20);
    var logMax = Math.log10(sr / 2);
    var usableH = h - 14;

    for (var i = 0; i < numBars; i++) {
      var logS = logMin + (i / numBars) * (logMax - logMin);
      var logE = logMin + ((i + 1) / numBars) * (logMax - logMin);
      var binS = Math.max(0, Math.floor(Math.pow(10, logS) / sr * bufLen * 2));
      var binE = Math.min(bufLen - 1, Math.floor(Math.pow(10, logE) / sr * bufLen * 2));

      var val = 0;
      for (var b = binS; b <= binE; b++) { if (data[b] > val) val = data[b]; }

      var barH = (val / 255) * usableH;
      var x = i * barW + gap;
      var bw = barW - gap * 2;
      if (bw < 1) bw = 1;

      var ratio = val / 255;
      var rgb = azTheme.spectrumColor(ratio);
      var r = rgb[0], g = rgb[1], bl = rgb[2];

      ctx.shadowColor = 'rgba(' + r + ',' + g + ',' + bl + ',0.35)';
      ctx.shadowBlur = 5;
      ctx.fillStyle = 'rgba(' + r + ',' + g + ',' + bl + ',0.85)';
      ctx.fillRect(x, h - 8 - barH, bw, barH);
      ctx.shadowBlur = 0;

      // Peak hold
      if (val > azPeaks[i]) azPeaks[i] = val;
      else azPeaks[i] = Math.max(0, azPeaks[i] - 1.2);

      var peakY = (azPeaks[i] / 255) * usableH;
      if (peakY > 2) {
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillRect(x, h - 8 - peakY, bw, 1.5);
      }
    }

    // Frequency labels
    var freqs = [60, 250, 1000, 4000, 16000];
    var labels = ['60', '250', '1K', '4K', '16K'];
    ctx.font = '9px monospace';
    ctx.fillStyle = 'rgba(159,182,204,0.45)';
    ctx.textAlign = 'center';
    for (var i = 0; i < freqs.length; i++) {
      var fx = ((Math.log10(freqs[i]) - logMin) / (logMax - logMin)) * w;
      ctx.fillText(labels[i], fx, h - 1);
    }

    // Band zone labels
    var zones = [
      [30, 60, 'SUB'], [80, 150, 'KICK'], [200, 400, 'BASS'],
      [800, 2000, 'MID'], [5000, 10000, 'HIGH'], [12000, 20000, 'AIR']
    ];
    ctx.font = '8px monospace';
    ctx.fillStyle = azRGBA(0.12);
    for (var i = 0; i < zones.length; i++) {
      var zx1 = ((Math.log10(zones[i][0]) - logMin) / (logMax - logMin)) * w;
      var zx2 = ((Math.log10(zones[i][1]) - logMin) / (logMax - logMin)) * w;
      ctx.fillText(zones[i][2], (zx1 + zx2) / 2, 10);
    }
  }

  // --- SPECTROGRAM ---
  function azDrawSpectrogram() {
    var ctx = azCtx, w = azW, h = azH;
    var bufLen = azMain.frequencyBinCount;
    var data = new Uint8Array(bufLen);
    azMain.getByteFrequencyData(data);
    var sr = azAudioCtx.sampleRate;
    var logMin = Math.log10(20);
    var logMax = Math.log10(sr / 2);

    // Scroll: copy current canvas to temp, redraw shifted
    if (!azSpectroTmp || azSpectroTmp.width !== w || azSpectroTmp.height !== h) {
      azSpectroTmp = document.createElement('canvas');
      azSpectroTmp.width = w;
      azSpectroTmp.height = h;
    }
    var tmpCtx = azSpectroTmp.getContext('2d');
    tmpCtx.clearRect(0, 0, w, h);
    tmpCtx.drawImage(azCanvas, 0, 0);
    var sBg = azTheme.spectroColor(0);
    ctx.fillStyle = 'rgb(' + sBg[0] + ',' + sBg[1] + ',' + sBg[2] + ')';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(azSpectroTmp, -1, 0);

    // New column via ImageData
    if (!azSpectroCol || azSpectroCol.height !== h) {
      azSpectroCol = ctx.createImageData(1, h);
    }
    var px = azSpectroCol.data;
    for (var y = 0; y < h; y++) {
      var logF = logMin + ((h - 1 - y) / (h - 1)) * (logMax - logMin);
      var bin = Math.floor(Math.pow(10, logF) / sr * bufLen * 2);
      if (bin >= bufLen) bin = bufLen - 1;
      var val = data[bin];
      var rgb = azSpectroRGB(val);
      var idx = y * 4;
      px[idx] = rgb[0]; px[idx+1] = rgb[1]; px[idx+2] = rgb[2]; px[idx+3] = 255;
    }
    ctx.putImageData(azSpectroCol, w - 1, 0);

    // Freq labels on left
    var freqs = [100, 500, 2000, 8000];
    var labels = ['100', '500', '2K', '8K'];
    ctx.font = '9px monospace';
    ctx.fillStyle = 'rgba(159,182,204,0.35)';
    ctx.textAlign = 'left';
    for (var i = 0; i < freqs.length; i++) {
      var fy = h - ((Math.log10(freqs[i]) - logMin) / (logMax - logMin)) * h;
      ctx.fillText(labels[i], 3, fy + 3);
    }
  }

  function azSpectroRGB(val) {
    return azTheme.spectroColor(val);
  }

  // --- SCOPE (Vectorscope) ---
  function azDrawScope() {
    var ctx = azCtx, w = azW, h = azH;
    if (!azL || !azR) return;

    var bufLen = azL.fftSize;
    var dataL = new Float32Array(bufLen);
    var dataR = new Float32Array(bufLen);
    azL.getFloatTimeDomainData(dataL);
    azR.getFloatTimeDomainData(dataR);

    // Phosphor decay
    ctx.fillStyle = 'rgba(5,10,14,0.18)';
    ctx.fillRect(0, 0, w, h);

    // Grid: circles + crosshairs
    var cx = w / 2, cy = h / 2;
    var rad = Math.min(cx, cy) - 6;
    ctx.strokeStyle = 'rgba(36,50,68,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, rad * 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - rad, cy); ctx.lineTo(cx + rad, cy);
    ctx.moveTo(cx, cy - rad); ctx.lineTo(cx, cy + rad);
    var d = rad * 0.707;
    ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d);
    ctx.moveTo(cx - d, cy + d); ctx.lineTo(cx + d, cy - d);
    ctx.stroke();

    // Labels
    ctx.font = '9px monospace';
    ctx.fillStyle = 'rgba(159,182,204,0.45)';
    ctx.textAlign = 'center';
    ctx.fillText('M', cx, cy - rad - 3);
    ctx.fillText('+S', cx + rad + 2, cy - 3);
    ctx.fillText('-S', cx - rad - 2, cy - 3);

    // Lissajous trace
    ctx.beginPath();
    ctx.strokeStyle = azRGBA(0.5);
    ctx.lineWidth = 1.2;
    var step = Math.max(1, Math.floor(bufLen / 300));
    for (var i = 0; i < bufLen; i += step) {
      var mid = (dataL[i] + dataR[i]) * 0.5;
      var side = (dataL[i] - dataR[i]) * 0.5;
      var x = cx + side * rad;
      var y = cy - mid * rad;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Bright dots at recent samples
    ctx.shadowColor = azRGBA(0.7);
    ctx.shadowBlur = 3;
    ctx.fillStyle = azRGBA(0.85);
    var recent = Math.max(0, bufLen - 48);
    for (var i = recent; i < bufLen; i += step) {
      var mid = (dataL[i] + dataR[i]) * 0.5;
      var side = (dataL[i] - dataR[i]) * 0.5;
      ctx.fillRect(cx + side * rad - 0.8, cy - mid * rad - 0.8, 1.6, 1.6);
    }
    ctx.shadowBlur = 0;
  }

  // --- LEVELS ---
  function azDrawLevels() {
    var ctx = azCtx, w = azW, h = azH;
    if (!azL || !azR) return;

    var bufLen = azL.fftSize;
    var dataL = new Float32Array(bufLen);
    var dataR = new Float32Array(bufLen);
    azL.getFloatTimeDomainData(dataL);
    azR.getFloatTimeDomainData(dataR);

    ctx.clearRect(0, 0, w, h);
    azDrawGrid(ctx, w, h);

    function calcLevels(d) {
      var sum = 0, pk = 0;
      for (var i = 0; i < d.length; i++) {
        sum += d[i] * d[i];
        var a = Math.abs(d[i]);
        if (a > pk) pk = a;
      }
      return { rms: Math.sqrt(sum / d.length), peak: pk };
    }
    function toDB(v) { return v > 0.00001 ? 20 * Math.log10(v) : -100; }

    var lv = calcLevels(dataL), rv = calcLevels(dataR);
    var rmsL = toDB(lv.rms), rmsR = toDB(rv.rms);
    var pkL = toDB(lv.peak), pkR = toDB(rv.peak);

    // Peak hold (slow decay)
    if (pkL > azPeakHoldL) azPeakHoldL = pkL;
    else azPeakHoldL = Math.max(-100, azPeakHoldL - 0.3);
    if (pkR > azPeakHoldR) azPeakHoldR = pkR;
    else azPeakHoldR = Math.max(-100, azPeakHoldR - 0.3);

    var minDb = -60, maxDb = 0;
    var mL = 36, mR = w - 48;
    var mH = Math.min(24, h / 4);
    var mYL = h * 0.3 - mH / 2;
    var mYR = h * 0.65 - mH / 2;

    function dbToX(db) { return mL + ((db - minDb) / (maxDb - minDb)) * (mR - mL); }

    // Labels
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(159,182,204,0.6)';
    ctx.textAlign = 'right';
    ctx.fillText('L', mL - 6, mYL + mH / 2 + 4);
    ctx.fillText('R', mL - 6, mYR + mH / 2 + 4);

    // Meter backgrounds
    ctx.fillStyle = 'rgba(15,22,32,0.6)';
    ctx.fillRect(mL, mYL, mR - mL, mH);
    ctx.fillRect(mL, mYR, mR - mL, mH);

    function drawMeter(y, rmsDb, peakDb, holdDb) {
      var rmsX = dbToX(Math.max(minDb, Math.min(maxDb, rmsDb)));
      var peakX = dbToX(Math.max(minDb, Math.min(maxDb, peakDb)));
      var holdX = dbToX(Math.max(minDb, Math.min(maxDb, holdDb)));

      // RMS gradient bar
      var grad = ctx.createLinearGradient(mL, 0, mR, 0);
      var ls = azTheme.levelStops;
      for (var si = 0; si < ls.length; si++) grad.addColorStop(ls[si][0], ls[si][1]);

      ctx.shadowColor = azRGBA(0.25);
      ctx.shadowBlur = 4;
      ctx.fillStyle = grad;
      if (rmsX > mL) ctx.fillRect(mL, y, rmsX - mL, mH);
      ctx.shadowBlur = 0;

      // Peak line
      if (peakX > mL + 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect(peakX - 1, y, 2, mH);
      }

      // Peak hold marker
      if (holdX > mL + 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(holdX - 1, y, 2, mH);
      }
    }

    drawMeter(mYL, rmsL, pkL, azPeakHoldL);
    drawMeter(mYR, rmsR, pkR, azPeakHoldR);

    // dB scale
    ctx.font = '8px monospace';
    ctx.fillStyle = 'rgba(159,182,204,0.4)';
    ctx.textAlign = 'center';
    var marks = [-48, -36, -24, -12, -6, 0];
    var scaleY = h * 0.5 - 1;
    for (var i = 0; i < marks.length; i++) {
      var mx = dbToX(marks[i]);
      ctx.fillText(marks[i] + '', mx, scaleY);
      ctx.fillStyle = 'rgba(36,50,68,0.3)';
      ctx.fillRect(mx, mYL - 2, 1, mH + 4);
      ctx.fillRect(mx, mYR - 2, 1, mH + 4);
      ctx.fillStyle = 'rgba(159,182,204,0.4)';
    }

    // dB readout
    ctx.font = '10px monospace';
    ctx.fillStyle = azRGBA(0.65);
    ctx.textAlign = 'left';
    ctx.fillText(rmsL > -100 ? rmsL.toFixed(1) + ' dB' : '-inf', mR + 4, mYL + mH / 2 + 4);
    ctx.fillText(rmsR > -100 ? rmsR.toFixed(1) + ' dB' : '-inf', mR + 4, mYR + mH / 2 + 4);
  }

  // --- BPM glow ---
  function azUpdateGlow() {
    var bpmText = studioBpm ? studioBpm.textContent : '';
    var bpm = parseInt(bpmText);
    if (!bpm || bpm < 60 || bpm > 220 || !trackStartedAt || broadcastState.streamMode === 'standby') {
      azCrt.style.boxShadow = '';
      return;
    }
    var beatMs = 60000 / bpm;
    var phase = ((Date.now() - trackStartedAt) % beatMs) / beatMs;
    var pulse = Math.pow(Math.max(0, Math.cos(phase * Math.PI * 2)) * 0.5 + 0.5, 4);
    if (pulse > 0.25) {
      var s = (8 + pulse * 14).toFixed(1);
      var a = (pulse * 0.18).toFixed(3);
      var si = (pulse * 15).toFixed(1);
      var ai = (pulse * 0.025).toFixed(4);
      var gp = azTheme.primary;
      azCrt.style.boxShadow = '0 0 ' + s + 'px rgba(' + gp[0] + ',' + gp[1] + ',' + gp[2] + ',' + a + '), inset 0 0 ' + si + 'px rgba(' + gp[0] + ',' + gp[1] + ',' + gp[2] + ',' + ai + ')';
    } else {
      azCrt.style.boxShadow = '';
    }
  }

  // --- Mode switching ---
  if (azWrap) {
    var azModeBtns = azWrap.querySelectorAll('.az-mode');
    azModeBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        if (!azInited) azInit();
        azMode = btn.dataset.azmode;
        azModeBtns.forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        // Reset mode-specific state
        if (azCtx) azCtx.clearRect(0, 0, azW, azH);
        azSpectroTmp = null;
        azSpectroCol = null;
        azPeakHoldL = -100;
        azPeakHoldR = -100;
      });
    });
  }

  // --- ON/OFF toggle ---
  var azToggle = document.getElementById('az-toggle');
  var azOn = true;
  if (azToggle) {
    azToggle.onclick = function() {
      azOn = !azOn;
      azToggle.textContent = azOn ? 'ON' : 'OFF';
      azToggle.classList.toggle('off', !azOn);
      azWrap.classList.toggle('collapsed', !azOn);
      if (azOn) {
        azResize();
        if (azInited && !azAnimFrame) azLoop();
      } else {
        if (azAnimFrame) { cancelAnimationFrame(azAnimFrame); azAnimFrame = null; }
        azCrt.style.boxShadow = '';
      }
    };
  }

  // --- Theme switching ---
  var azThemeBtn = document.getElementById('ui-theme-btn');
  if (azThemeBtn) {
    azThemeBtn.addEventListener('click', function() {
      var idx = azThemeNames.indexOf(azThemeName);
      var next = azThemeNames[(idx + 1) % azThemeNames.length];
      azSetTheme(next);
    });
  }

  // Apply saved theme on load
  azSetTheme(azThemeName);

  // --- Sync offset UI (Safari stream decode only) ---
  if (isSafari) {
    var syncWrap = document.getElementById('az-sync');
    var syncLabel = document.getElementById('az-sync-label');
    var syncMinus = document.getElementById('az-sync-minus');
    var syncPlus = document.getElementById('az-sync-plus');
    if (syncWrap) {
      syncWrap.style.display = 'inline-flex';
      if (syncLabel) syncLabel.textContent = (azSyncOffset >= 0 ? '+' : '') + azSyncOffset.toFixed(1) + 's';
      if (syncMinus) syncMinus.addEventListener('click', function(e) {
        e.stopPropagation();
        azAdjustSync(-0.5);
      });
      if (syncPlus) syncPlus.addEventListener('click', function(e) {
        e.stopPropagation();
        azAdjustSync(0.5);
      });
    }
  }

  // --- Init canvas on load + resize ---
  window.addEventListener('resize', azResize);
  azResize();

  // Test-only drift hook: exposes the 4 helpers that were cut over from inline
  // copies to FRUtils delegations (C3), plus the closure handles tests need to
  // drive them (broadcastState, and setters for currentMixMode /
  // currentPlatformNames). Placed at the bottom of the IIFE so all three vars
  // are already declared. Guarded by window.__APP_TEST__ — completely inert in
  // production (flag unset).
  if (typeof window !== 'undefined' && window.__APP_TEST__) {
    window.__appDrift = {
      computeMixDur: computeMixDur,
      getBroadcastPhase: getBroadcastPhase,
      uniquePlatformName: uniquePlatformName,
      deriveUiMode: deriveUiMode,
      broadcastState: broadcastState,
      setMixMode: function (m) { currentMixMode = m; },
      setPlatformNames: function (a) { currentPlatformNames = a; }
    };
    // Test-only schedule hook: exposes the schedule-domain functions plus
    // accessors for the closure state (scheduleData, DAYS) so characterization
    // tests can drive the domain and assert the AS-IS contract. Inert in
    // production (flag unset). No function is moved/renamed by adding this.
    window.__appSchedule = {
      loadSchedule: loadSchedule,
      loadScheduleCurrent: loadScheduleCurrent,
      renderScheduleGrid: renderScheduleGrid,
      renderEventsList: renderEventsList,
      renderScheduleSettings: renderScheduleSettings,
      loadPlaylistsForSelect: loadPlaylistsForSelect,
      deleteWeeklySlot: deleteWeeklySlot,
      deleteEvent: deleteEvent,
      getScheduleData: function () { return scheduleData; },
      setScheduleData: function (d) { scheduleData = d; },
      getDAYS: function () { return DAYS; }
    };
  }

})();
