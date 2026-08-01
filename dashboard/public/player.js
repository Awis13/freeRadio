/**
 * player.js — HLS player, loading overlay and standby overlay for the
 * STUDIO 23 / FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the player/analyzer/mixer
 * refactor). Owns the live-only HLS player (hls.js and native paths), the
 * loading-overlay state machine with its lock fields, the standby/static-noise
 * overlay, the channel-flash transition, and the page-lifecycle + bfcache
 * recovery. init() runs the boot side-effects that were module-scope statements
 * in app.js: the media-element listeners, the mute-button binding, initPlayer(),
 * and the visibilitychange/pageshow listeners — in that original order.
 *
 * OWNED STATE (moved here, exposed with accessors only where app.js still
 * reads or writes it):
 *   hlsInstance, hlsSrc, useNativeHls, aliveTimer, safetyTimer, hlsRetryTimer,
 *   playRetryTimer, stallCount, stallResetTimer, lastVisibleTime — internal.
 *   overlayLockedUntil, pendingModeSwitch, noiseActive — the broadcast state
 *   machine still touches these, so they get get/set accessors rather than
 *   moving to app.js.
 *
 * NOT MOVED (foreign state that merely happened to be declared in this region;
 * injected or left where its consumers are):
 *   - userInteracted + getUserInteracted/setUserInteracted — read by
 *     setPlayerMuted and the studio hook, written by ARM/PLAY. Studio-facade
 *     state; stays in app.js, injected here as setUserInteracted.
 *   - playTransitionLock — declared in this region but used ONLY by the
 *     broadcast machine (ARM/PLAY/STOP and the /api/status poll); no player
 *     code reads it. It now lives in broadcast.js.
 *   - isIOS / isSafari — UA detection shared with the analyzer (azInit reads
 *     isSafari). Single source stays in app.js and both flags are injected.
 *   - The Safari analyzer-hide block that sat at the top of this region
 *     deliberately stays in app.js: it hides the analyzer wrapper during app.js
 *     evaluation, before FRAnalyzer.init runs. Consolidating it with the rest
 *     of the analyzer is separate work, not done here.
 *   - The analyzer and mute concerns now live in analyzer.js and arrive as
 *     deps: setPlayerMuted, ensureAnalyzer and resyncAnalyzerStream are wired
 *     to FRAnalyzer.setPlayerMuted / ensureInited / resyncStreamDecode.
 *   - The WebSocket lives in wsHub.js; getWs/reconnectWs are injected so this
 *     module never reaches into the socket or its backoff state.
 *
 * DOM refs are resolved via document.getElementById at call time, exactly as the
 * former app.js closure referenced them.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/player.js"> (attaches its public API to window.FRPlayer) AND
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
    window.FRPlayer = api;
  }
})(function () {
  'use strict';

  // Injected host services (set by init). Defaults keep a pre-init call inert
  // rather than throwing, matching the sibling modules.
  var deps = {
    log: function () {},
    getStudioPlayer: function () { return null; },
    getBroadcastState: function () { return null; },
    setPlayerMuted: function () {},
    setUserInteracted: function () {},
    ensureAnalyzer: function () {},
    resyncAnalyzerStream: function () {},
    getWs: function () { return null; },
    reconnectWs: function () {},
    isIOS: false,
    isSafari: false,
  };

  // -------------------------------------------------------------------------
  // Helpers that resolve injected services at call time.
  // -------------------------------------------------------------------------
  function log(msg) { return deps.log(msg); }
  function getStudioPlayer() { return deps.getStudioPlayer(); }
  function getBroadcastState() { return deps.getBroadcastState(); }
  function setPlayerMuted(m) { return deps.setPlayerMuted(m); }
  function setUserInteracted(v) { return deps.setUserInteracted(v); }
  function ensureAnalyzer() { return deps.ensureAnalyzer(); }
  function resyncAnalyzerStream() { return deps.resyncAnalyzerStream(); }
  function getWs() { return deps.getWs(); }
  function reconnectWs() { return deps.reconnectWs(); }

  // -------------------------------------------------------------------------
  // Module-owned state (moved from the app.js closure).
  // -------------------------------------------------------------------------
  var hlsInstance = null;

  var aliveTimer = null;    // 4s no-timeupdate → show "Loading stream..."
  var safetyTimer = null;   // 20s max overlay duration
  var hlsRetryTimer = null;
  var overlayLockedUntil = 0;  // timestamp — auto-hide blocked until this time
  var pendingModeSwitch = false;  // hard block: overlay stays until mode actually applies

  var stallCount = 0;
  var stallResetTimer = null;

  var noiseActive = false;

  var hlsSrc = '/hls/stream.m3u8';
  var useNativeHls = false;

  var playRetryTimer = null;

  var lastVisibleTime = 0;

  // -------------------------------------------------------------------------
  // Overlay state machine
  // showLoading(text, source, lockMs) — show overlay.
  //   lockMs: minimum display time. During lock, only 'manifest' and 'safety' can hide.
  //           timeupdate/canplay from old stream are blocked until lock expires.
  // hideLoading(source) — hide overlay (respects lock for auto-sources).
  // -------------------------------------------------------------------------
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

  /**
   * Clear the alive timer on its own. app.js's PLAY-from-armed path did this
   * inline immediately before calling clearAllTimers, which already covers it;
   * kept as a distinct entry point so that call site stays behaviour-identical.
   */
  function clearAliveTimer() {
    if (aliveTimer) { clearTimeout(aliveTimer); aliveTimer = null; }
  }

  // -------------------------------------------------------------------------
  // Standby overlay (solid black div) + channel flash
  // -------------------------------------------------------------------------
  function startStaticNoise() {
    noiseActive = true;
    document.getElementById('standby-overlay').classList.add('active');
    log('STANDBY overlay on');
  }

  function stopStaticNoise() {
    noiseActive = false;
    document.getElementById('standby-overlay').classList.remove('active');
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

  // -------------------------------------------------------------------------
  // Player core
  // -------------------------------------------------------------------------
  function initPlayer() {
    getStudioPlayer().muted = true; // force muted — Safari may persist unmuted state across reloads
    log('PLR init src=' + hlsSrc);

    if (deps.isSafari || typeof Hls === 'undefined' || !Hls.isSupported()) {
      // iOS: native HLS (reliable). Desktop fallback when no MSE.
      // createMediaElementSource doesn't work on Safari (HLS or MMS) — WebKit bug 180696.
      // Also fallback for very old browsers without MSE.
      log('PLR mode=native-hls' + (deps.isSafari ? ' (Safari)' : ' (no MSE)'));
      useNativeHls = true;
      getStudioPlayer().src = hlsSrc;
      tryPlay('native-init');
      return;
    }
    // hls.js works on Chrome, Firefox, Safari desktop 17.1+ (via ManagedMediaSource)
    log('PLR mode=hls.js v' + (Hls.version || '?'));
    startHls('init');
  }

  function tryPlay(source) {
    if (playRetryTimer) { clearTimeout(playRetryTimer); playRetryTimer = null; }
    var attempt = 0;
    var maxAttempts = deps.isIOS ? 8 : 3;
    function go() {
      getStudioPlayer().play().then(function() {
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
    getStudioPlayer().removeAttribute("src");
    getStudioPlayer().load();

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
      var broadcastState = getBroadcastState();
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
          var bs = getBroadcastState();
          if (bs && (bs.streamMode === 'armed' || bs.arming)) {
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
      var broadcastState = getBroadcastState();
      if (broadcastState && broadcastState.arming) { log('HLS MANIFEST_PARSED (arming, keep overlay)'); tryPlay('manifest'); return; }
      hideLoading('manifest');
      log('HLS MANIFEST_PARSED → play()');
      tryPlay('manifest');
    });

    hlsInstance.loadSource(hlsSrc);
    hlsInstance.attachMedia(getStudioPlayer());
  }

  // restartPlayer: clean restart — clears ALL timers, shows overlay during reconnect
  function restartPlayer(source, hlsConfigOverride) {
    log('PLR restart src=' + (source || '?'));
    clearAllTimers('restart-' + (source || '?'));
    // Show overlay during reconnection — locked so stale timeupdate can't hide it.
    // 'manifest' source (MANIFEST_PARSED) always bypasses the lock.
    showLoading('Loading stream...', 'restart', 3000);
    // Restart Safari stream decode so analyzer re-syncs with new HLS session
    resyncAnalyzerStream();
    if (useNativeHls) {
      getStudioPlayer().src = hlsSrc;
      tryPlay('native-restart');
    } else {
      startHls('restart-' + (source || '?'), hlsConfigOverride);
    }
  }

  // -------------------------------------------------------------------------
  // Boot side-effects (module-scope statements in app.js, now run by init()).
  // -------------------------------------------------------------------------
  function bindMediaListeners() {
    // timeupdate = video is receiving frames → stream alive → hide overlay (if not locked)
    getStudioPlayer().addEventListener('timeupdate', function() {
      if (noiseActive) return;
      var broadcastState = getBroadcastState();
      if (broadcastState && broadcastState.arming) return;
      if (aliveTimer) { clearTimeout(aliveTimer); aliveTimer = null; }
      hideLoading('timeupdate');
      aliveTimer = setTimeout(function() {
        aliveTimer = null;
        if (noiseActive) return;
        // Don't show buffering overlay when armed (poster loops normally)
        var bs = getBroadcastState();
        if (bs && bs.streamMode === 'armed') return;
        showLoading('Buffering...', 'alive-timeout');
      }, 4000);
    });

    getStudioPlayer().addEventListener('canplay', function() {
      hideLoading('canplay');
    });

    // No seeking handler needed — controls are disabled (pointer-events: none)
    // Previously had a snap-to-live handler here, but it fought with HLS.js
    // gap recovery (bufferSeekOverHole), creating an infinite loop every 100ms.

    // iOS/Safari: recover from stalls — video element fires 'stalled' when buffering stops
    getStudioPlayer().addEventListener('stalled', function() {
      if (noiseActive) return;
      var broadcastState = getBroadcastState();
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
    getStudioPlayer().addEventListener('error', function() {
      if (!useNativeHls) return;
      var err = getStudioPlayer().error;
      log('PLR native error: ' + (err ? err.code + ' ' + err.message : 'unknown'));
      var broadcastState = getBroadcastState();
      if (broadcastState && (broadcastState.streamMode === 'armed' || broadcastState.arming)) return;
      showLoading('Reconnecting...', 'native-error');
      setTimeout(function() { restartPlayer('native-error'); }, 2000);
    });
  }

  function bindMuteButton() {
    // Mute/unmute (integrated with CRT Analyzer GainNode)
    var playerMuteBtn = document.getElementById('player-mute-btn');
    playerMuteBtn.onclick = function() {
      setUserInteracted(true);
      ensureAnalyzer();
      var muted = !getStudioPlayer().muted;
      setPlayerMuted(muted);
      playerMuteBtn.innerHTML = muted ? '&#128263;' : '&#128266;';
      playerMuteBtn.title = muted ? 'Unmute' : 'Mute';
      if (!muted) playerMuteBtn.classList.add('unmuted');
      else playerMuteBtn.classList.remove('unmuted');
    };
  }

  function bindPageLifecycle() {
    // --- Page lifecycle: iOS suspends pages aggressively ---
    // On return from background/tab-switch, HLS stalls and WS dies.
    // Detect resume and restart both.
    lastVisibleTime = Date.now();

    document.addEventListener('visibilitychange', function() {
      if (document.hidden) {
        lastVisibleTime = Date.now();
        log('PAGE hidden');
        return;
      }
      var away = Date.now() - lastVisibleTime;
      log('PAGE visible (away ' + Math.round(away / 1000) + 's)');

      // Skip recovery during standby/arming
      var broadcastState = getBroadcastState();
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
      if (!getWs() || getWs().readyState > 1) {
        log('PAGE resume: WS dead, reconnecting');
        reconnectWs();
      }
    });

    // bfcache: iOS Safari may restore page from bfcache on back/forward navigation
    window.addEventListener('pageshow', function(e) {
      if (e.persisted) {
        log('PAGE restored from bfcache');
        restartPlayer('bfcache');
        if (!getWs() || getWs().readyState > 1) {
          reconnectWs();
        }
      }
    });
  }

  /**
   * Store injected dependencies, then run the boot side-effects in the exact
   * order they ran as module-scope statements in app.js: media listeners, mute
   * button, initPlayer(), page-lifecycle listeners.
   */
  function init(injected) {
    injected = injected || {};
    window.FRUtils.mergeDeps(deps, injected, 'FRPlayer');
    bindMediaListeners();
    bindMuteButton();
    initPlayer();
    bindPageLifecycle();
  }

  return {
    init: init,
    // Overlay state machine
    showLoading: showLoading,
    hideLoading: hideLoading,
    clearAllTimers: clearAllTimers,
    clearAliveTimer: clearAliveTimer,
    setOverlayLockedUntil: function (v) { overlayLockedUntil = v; },
    getPendingModeSwitch: function () { return pendingModeSwitch; },
    setPendingModeSwitch: function (v) { pendingModeSwitch = v; },
    // Standby overlay
    startStaticNoise: startStaticNoise,
    stopStaticNoise: stopStaticNoise,
    isNoiseActive: function () { return noiseActive; },
    flashTransition: flashTransition,
    restartPlayer: restartPlayer,

    // Surface used by the characterization tests to drive the module.
    // Player core
    initPlayer: initPlayer,
    tryPlay: tryPlay,
  };
});
