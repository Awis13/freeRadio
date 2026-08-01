/**
 * broadcast.js - The broadcast state machine for the STUDIO 23 / FreeRadio
 * dashboard: the phase model, its repaint, the transport buttons, the mode
 * cards, the Live Mode bar, the status polling and the mixing-mode pills.
 *
 * Extracted verbatim from the app.js IIFE (C4 of the broadcast-core refactor,
 * the last extraction of the track). What is left in app.js after this is boot
 * substrate: shared aliases, the module wiring in boot order, and the test hooks.
 *
 * LAYERING NOTE - this is the first module that sits ABOVE its siblings rather
 * than beside them. It drives FRPlayer, FRQueue, FRNowPlaying, FRAnalyzer,
 * FRFileMgmt and FRRestreamStatus, and those calls are kept as BARE GLOBAL
 * identifiers exactly as app.js wrote them (FRPlayer.showLoading(...), not
 * window.FRPlayer...). Under strict mode that means a missing module is a
 * ReferenceError at the call, not a silent undefined - the same failure profile
 * app.js had. Injecting
 * thirty-odd individual callbacks would have transformed most of the moved
 * region for no behavioural gain; only genuine app.js-closure services
 * (authFetch, log, showError, getStudioPlayer, setUserInteracted) are injected.
 * Every sibling module is loaded before this file and every such call happens
 * after boot.
 *
 * OWNED STATE: broadcastState with getBroadcastState, armAborted,
 * playTransitionLock, bpmMap, processedVisualFiles, currentMixMode with
 * getMixMode/setMixMode, and MODE_HINTS.
 *
 * bpmMap moved here because its writers are the WS init and bpm frames, whose
 * bodies moved here too. Its four readers (FRQueue, FRFileMgmt, FRPlaylists,
 * FRNowPlaying) take getBpmMap from this module through app.js's wiring.
 *
 * NOT MOVED - userInteracted with its getter and setter, and studioPlayer with
 * getStudioPlayer, stay in app.js. userInteracted is the one flag genuinely
 * shared three ways: written by this machine (ARM/PLAY), written by FRPlayer
 * (the mute button), read by FRAnalyzer (setPlayerMuted), and exported by the
 * __appStudio hook. Moving it would make the player and the analyzer depend on
 * the broadcast machine, inverting the layering.
 *
 * THE SKIP/CLEAR SPLIT-BRAIN moves with updateBroadcastUI: the repaint copies
 * live here now, the boot copies live in queue.js. Still byte-equivalent, still
 * separately pinned, still deliberately not collapsed.
 *
 * WS DISPATCH - buildWsHandlers() returns the handler table FRWsHub calls. The
 * bodies are the former app.js case bodies verbatim.
 *
 * BOOT ORDER - init() resolves the DOM, then bindMachine() runs the former
 * module-scope statements in their original relative order: the mode-card and
 * sub-pill listeners, the four transport buttons, the Live Mode bar bindings,
 * the first status poll with its two intervals, the mixing pills, and the
 * mixing config load. Function declarations hoist, so splitting them out of
 * that sequence changes nothing.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/broadcast.js"> (attaches its public API to window.FRBroadcast)
 * AND required by the vitest suite via module.exports (CJS). It deliberately
 * uses NO top-level `export`/`import` so a browser <script> can load it without
 * a SyntaxError.
 */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.FRBroadcast = api;
  }
})(function () {
  'use strict';

  // Injected host services (set by init). The defaults are placeholders for a
  // correctly-initialised host, not a safe pre-init mode: a pre-init repaint
  // would still touch DOM refs that resolveDom has not filled in yet. init()
  // runs during boot, before any consumer can reach these.
  var deps = {
    authFetch: function () { return Promise.reject(new Error('FRBroadcast not initialised')); },
    log: function () {},
    showError: function () {},
    getStudioPlayer: function () { return null; },
    setUserInteracted: function () {},
  };

  function authFetch(url, opts) { return deps.authFetch(url, opts); }
  function log(msg) { return deps.log(msg); }
  function showError(msg) { return deps.showError(msg); }
  function getStudioPlayer() { return deps.getStudioPlayer(); }
  function setUserInteracted(v) { return deps.setUserInteracted(v); }

  // Shared FRUtils helpers resolved at call time (single source of truth).
  var FRU = {
    getBroadcastPhase: function (s) { return window.FRUtils.getBroadcastPhase(s); },
    deriveUiMode: function (v) { return window.FRUtils.deriveUiMode(v); }
  };

  // -------------------------------------------------------------------------
  // Module-owned state
  // -------------------------------------------------------------------------
  var bpmMap = {};
  var processedVisualFiles = [];
  var currentMixMode = 'smart';
  function getMixMode() { return currentMixMode; }
  function setMixMode(mode) { currentMixMode = mode; }
  var playTransitionLock = false; // prevents loadBroadcastState from interfering during PLAY

  // DOM refs the machine's functions read. Siblings resolve the same elements
  // by id for their own use. Assigned once by resolveDom() from init().
  var studioAudioTrack = null, studioBpm = null;
  var skipBtn = null, queueSearch = null;
  var queuePanelTitle = null, queueSelectorTitle = null, playerMuteBtn = null;
  var mixModeContainer = null, mixPills = [];
  var broadcastModeTag = null, btnBroadcast = null, btnPlay = null, btnStop = null, btnArm = null;
  var liveModeSettings = null, liveStatusBadge = null, liveIngestUrl = null;
  var liveIngestKey = null, liveAfkFallback = null, liveSourcePills = [];
  var playerOverlay = null, playerOverlayText = null, modeHint = null;

  function resolveDom() {
    studioAudioTrack = document.getElementById('studio-audio-track');
    studioBpm = document.getElementById('studio-bpm');
    skipBtn = document.getElementById('skip-btn');
    queueSearch = document.getElementById('queue-search');
    queuePanelTitle = document.getElementById('queue-panel-title');
    queueSelectorTitle = document.getElementById('queue-selector-title');
    playerMuteBtn = document.getElementById('player-mute-btn');
    mixModeContainer = document.getElementById('transport-mix-mode');
    mixPills = mixModeContainer ? mixModeContainer.querySelectorAll('.mix-pill') : [];
    broadcastModeTag = document.getElementById('broadcast-mode-tag');
    btnBroadcast = document.getElementById('btn-broadcast');
    btnPlay = document.getElementById('btn-play');
    btnStop = document.getElementById('btn-stop');
    btnArm = document.getElementById('btn-arm');
    liveModeSettings = document.getElementById('live-mode-bar');
    liveStatusBadge = document.getElementById('live-status-badge');
    liveIngestUrl = document.getElementById('live-ingest-url');
    liveIngestKey = document.getElementById('live-ingest-key');
    liveAfkFallback = document.getElementById('live-afk-fallback');
    liveSourcePills = document.querySelectorAll('.live-source-pill');
    playerOverlay = document.getElementById('player-overlay');
    playerOverlayText = document.getElementById('player-overlay-text');
    modeHint = document.getElementById('transport-mode-hint');
  }

  // State: streaming=ffmpeg running, broadcast=RTMP active, streamMode=standby|armed|live
  // uiMode/uiSubMode — frontend mode (radio/talkover/takeover)
  var broadcastState = { streaming: false, broadcast: false, streamMode: 'standby', standbyVisual: null, visualMode: 'visual-radio', arming: false, liveMode: { source: 'obs', afkFallback: 'visual-radio', obsStatus: 'offline', ingestKey: '' }, uiMode: 'radio', uiSubMode: 'visual-radio' };
  // Injection seam: sole closure accessor for broadcastState. Object identity is
  // stable, so this getter is a no-op over the existing call sites — it lets
  // future PRs source broadcastState through a single point. No behaviour change.
  function getBroadcastState() { return broadcastState; }
  var armAborted = false;
  // Derived phase from state.
  // Delegates to FRUtils (single source of truth), passing the broadcast state.
  function getBroadcastPhase() {
    return FRU.getBroadcastPhase(broadcastState);
  }
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
    // The skip/clear handlers are NOT rebound here. queue.js binds them once at
    // boot and decides music-vs-video at click time from the same broadcast
    // state this repaint reads, so a repaint no longer has to reinstall a
    // duplicate copy of them. This function still owns the chrome around them:
    // the labels above, the placeholder, and skipBtn.disabled.

    // Mode hint
    var hints = MODE_HINTS[phase] || {};
    modeHint.textContent = hints[s.visualMode] || '';
  }
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
        FRPlayer.setPendingModeSwitch(true);
        FRPlayer.showLoading('Switching mode...', 'pill', 30000);
      }

      authFetch('/api/visual-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: apiMode })
      }).then(function() {
        FRQueue.loadActiveQueue();
        if (queueSearch) FRQueue.renderTrackSelector(queueSearch.value);
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
          if (phase === 'idle' && !FRPlayer.isNoiseActive()) {
            FRPlayer.startStaticNoise();
            FRAnalyzer.setPlayerMuted(true);
          } else if ((phase === 'playing' || phase === 'live') && FRPlayer.isNoiseActive()) {
            FRPlayer.stopStaticNoise();
            FRAnalyzer.setPlayerMuted(!playerMuteBtn.classList.contains('unmuted'));
          }
        }
      })
      .catch(function(e) { log('broadcast state: error: ' + e); });
  }
  // --- Mixing Mode ---
  function loadMixingConfig() {
    authFetch('/api/mixing/config')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.mode) {
          setMixMode(data.mode);
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
          setMixMode(mode);
          updateMixModeUI();
          // Recalculate cue marker for new mode
          var filename = (studioAudioTrack.textContent || '').split('/').pop();
          var bpm = studioBpm.textContent ? parseInt(studioBpm.textContent) : 0;
          FRNowPlaying.setMixDuration(bpm);
          log('mixing: changed to ' + mode);
        }
      })
      .catch(function(e) { log('mixing: error: ' + e); });
  }
  function updateMixModeUI() {
    mixPills.forEach(function(pill) {
      if (pill.dataset.mixmode === getMixMode()) {
        pill.classList.add('active');
      } else {
        pill.classList.remove('active');
      }
    });
  }

  // --- Boot statements, in their original relative order ---
  function bindMachine() {
    // --- Broadcast Control ---
    // States: idle → arming → armed → broadcasting → live
    //         idle → playing → live





    // ============================
    // MODE CARD STATE MACHINE
    // ============================




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
      setUserInteracted(true);
      if (broadcastState.arming || broadcastState.streamMode === 'armed') return;
      // Init analyzer on user gesture (AudioContext needs it)
      FRAnalyzer.ensureInited();
      broadcastState.arming = true;
      updateBroadcastUI();
      log('ARM: starting...');

      // Stop noise, mute — player starts later (after API + cleanup)
      FRPlayer.stopStaticNoise();
      FRAnalyzer.setPlayerMuted(true);
      // Loading screen for entire ARMING duration — hide stuttery video
      FRPlayer.showLoading('Arming...', 'arm', 20000);

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
            FRPlayer.restartPlayer('arm');

          // Detect real video (not black screen) via canvas pixel check
          var armCanvas = document.createElement('canvas');
          armCanvas.width = 16;
          armCanvas.height = 16;
          var armCtx = armCanvas.getContext('2d', { willReadFrequently: true });

          function isVideoBlack() {
            try {
              armCtx.drawImage(getStudioPlayer(), 0, 0, 16, 16);
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
            if (getStudioPlayer().readyState >= 3 && getStudioPlayer().videoWidth > 0 && !isVideoBlack()) {
              broadcastState.arming = false;
              FRPlayer.hideLoading('arm-ready');
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
              FRPlayer.hideLoading('arm-safety');
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
      setUserInteracted(true);
      // Init analyzer on user gesture (AudioContext needs it)
      FRAnalyzer.ensureInited();

      // --- From PREVIEW (playing without broadcast): just open gate ---
      if (broadcastState.streamMode === 'live' && !broadcastState.broadcast) {
        authFetch('/api/dj/resume', { method: 'POST' }).catch(function(){});
        authFetch('/api/stream/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ broadcast: true })
        }).catch(function(){});
        broadcastState.broadcast = true;
        FRAnalyzer.setPlayerMuted(false);
        playerMuteBtn.innerHTML = '&#128266;';
        playerMuteBtn.title = 'Mute';
        playerMuteBtn.classList.add('unmuted');
        updateBroadcastUI();
        log('PLAY: gate opened from preview');
        return;
      }

      // --- From ARMED: open gate, wait for music to fill pipeline, seek to live edge ---
      if (broadcastState.streamMode === 'armed') {
        FRPlayer.clearAliveTimer();
        FRPlayer.clearAllTimers('play-armed');
        FRPlayer.setPendingModeSwitch(false);
        FRPlayer.setOverlayLockedUntil(0);
        FRPlayer.hideLoading('play-armed');
        btnPlay.disabled = true;
        playTransitionLock = true;

        // Cue track → wait for cross buffer → resume → mode live (sequential)
        authFetch('/api/dj/cue', { method: 'POST' })
          .then(function() {
            FRPlayer.showLoading('Cueing track...', 'pill', 7000);
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
            FRPlayer.flashTransition();
            FRPlayer.hideLoading('play-armed-done');
            FRAnalyzer.setPlayerMuted(false);
            playerMuteBtn.innerHTML = '&#128266;';
            playerMuteBtn.title = 'Mute';
            playerMuteBtn.classList.add('unmuted');
            log('PLAY: gate open, track from beginning');
            // Replay cached audio — updateAudio skipped it during armed
            FRNowPlaying.replayLastAudio();
          })
          .catch(function(e) {
            log('PLAY: cue/resume FAILED: ' + e);
            showError('Audio start failed');
            FRPlayer.hideLoading('play-armed-err');
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
      FRPlayer.flashTransition();
      FRAnalyzer.setPlayerMuted(true);
      log('PLAY: cold start');

      // Ensure streaming on + DJ resume + live mode
      authFetch('/api/stream/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streaming: true })
      })
        .then(function() { return authFetch('/api/dj/cue', { method: 'POST' }); })
        .then(function() {
          FRPlayer.showLoading('Cueing track...', 'pill', 7000);
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
          FRPlayer.stopStaticNoise();
          log('PLAY: pipeline live, waiting for content...');
          // Replay cached audio — may have arrived while streamMode was standby
          FRNowPlaying.replayLastAudio();
          // Give pipeline 3s: gate already open, Liquidsoap playing track from 0:00,
          // FFmpeg writing first HLS segments with music. After player restart
          // it picks up fresh segments and starts from track beginning.
          setTimeout(function() {
            FRPlayer.restartPlayer('play');
            var unmuteDone = false;
            var doUnmute = function() {
              if (unmuteDone) return;
              unmuteDone = true;
              FRPlayer.flashTransition();
              if (getStudioPlayer().seekable.length > 0) {
                var edge = getStudioPlayer().seekable.end(getStudioPlayer().seekable.length - 1) - 0.1;
                if (edge > 0) getStudioPlayer().currentTime = edge;
              }
              FRAnalyzer.setPlayerMuted(false);
              playerMuteBtn.innerHTML = '&#128266;';
              playerMuteBtn.title = 'Mute';
              playerMuteBtn.classList.add('unmuted');
              playTransitionLock = false;
              btnPlay.disabled = false;
              log('PLAY: live');
            };
            getStudioPlayer().addEventListener('canplay', function onReady() {
              getStudioPlayer().removeEventListener('canplay', onReady);
              doUnmute();
            });
            // Safety: unmute after 4s regardless
            setTimeout(doUnmute, 4000);
          }, 3000);
        })
        .catch(function(e) {
          showError('Play failed: ' + e);
          FRPlayer.hideLoading('play-cold-err');
          playTransitionLock = false;
          btnPlay.disabled = false;
        });
    };

    // ========== BROADCAST / END ==========
    btnBroadcast.onclick = function() {
      if (broadcastState.arming) return;
      var newBroadcast = !broadcastState.broadcast;
      btnBroadcast.disabled = true;
      FRPlayer.showLoading(newBroadcast ? 'Starting broadcast...' : 'Ending broadcast...', 'broadcast', 4000);
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
      FRPlayer.startStaticNoise();
      FRPlayer.flashTransition();
      FRAnalyzer.setPlayerMuted(true);
      getStudioPlayer().pause();
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
          FRNowPlaying.resetTrackState();
          FRNowPlaying.resetTransportDom();
          updateBroadcastUI();
          log('STOP: idle');
        })
        .catch(function(e) {
          showError('Stop failed: ' + e);
          FRPlayer.stopStaticNoise();
          btnStop.disabled = false;
        });
    };


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



    loadProcessedVisuals();
    loadBroadcastState();
    setInterval(loadBroadcastState, 15000);
    setInterval(loadProcessedVisuals, 30000);




    mixPills.forEach(function(pill) {
      pill.addEventListener('click', function() {
        var mode = pill.dataset.mixmode;
        if (mode && mode !== getMixMode()) {
          setMixingMode(mode);
        }
      });
    });

    loadMixingConfig();
  }

  // --- WS dispatch table handed to FRWsHub ---
  function buildWsHandlers() {
    var wsHandlers = {
      init: function (data) {
        bpmMap = data.bpm || {};
        // Set broadcast state BEFORE updateAudio (race condition fix)
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
        FRNowPlaying.updateMode(data.outputMode);
        FRNowPlaying.onAudioFrame(data.audio);
        FRNowPlaying.updateIcecast(data.icecast);
        FRNowPlaying.updateFfmpeg(data.ffmpeg);
        if (data.rtmpHealth) FRRestreamStatus.updateRestreamStatus(data.rtmpHealth);
        FRFileMgmt.loadFileList('music');
        FRFileMgmt.loadFileList('visuals');
      },
      audio: function (data) {
        FRNowPlaying.onAudioFrame(data);
      },
      video: function (data) {
        if (FRPlayer.getPendingModeSwitch()) {
          // New clip started in feed_fifo, but HLS player still has ~2s of buffered
          // old content (hls_time=1 × liveSyncDurationCount=1 + segment pipeline).
          // Wait for buffer to flush before hiding overlay.
          log('MODE new clip detected: ' + (data && data.filename || '?') + ', waiting for HLS buffer...');
          setTimeout(function() {
            FRPlayer.setPendingModeSwitch(false);
            FRPlayer.hideLoading('mode-applied');
            log('MODE switch applied');
          }, 2500);
        }
      },
      icecast: function (data) {
        FRNowPlaying.updateIcecast(data);
      },
      ffmpeg: function (data) {
        FRNowPlaying.updateFfmpeg(data);
      },
      bpm: function (data) {
        bpmMap = data || {};
        FRFileMgmt.refreshBpmInList();
      },
      rtmpHealth: function (data) {
        FRRestreamStatus.updateRestreamStatus(data);
      },
      voiceStatus: function (data) {
        if (data && data.status === 'on-air') {
          log('PTT: voice message on air');
        }
      },
      mixingConfig: function (data) {
        if (data && data.mode) {
          setMixMode(data.mode);
          updateMixModeUI();
          var wsB = studioBpm.textContent ? parseInt(studioBpm.textContent) : 0;
          FRNowPlaying.setMixDuration(wsB);
        }
      },
      liveMode: function (data) {
        if (data) {
          broadcastState.liveMode = data;
          updateLiveModeUI();
          updateModeUI();
          log('live: ' + data.obsStatus);
        }
      }
    };

    return wsHandlers;
  }

  function init(injected) {
    injected = injected || {};
    window.FRUtils.mergeDeps(deps, injected, 'FRBroadcast');
    resolveDom();
    bindMachine();
  }

  return {
    init: init,
    buildWsHandlers: buildWsHandlers,
    getBroadcastState: getBroadcastState,
    getBroadcastPhase: getBroadcastPhase,
    getBpmMap: function () { return bpmMap; },
    getProcessedVisualFiles: function () { return processedVisualFiles; },
    getMixMode: getMixMode,
    setMixMode: setMixMode,
    deriveUiMode: deriveUiMode,
    loadBroadcastState: loadBroadcastState,

    // Surface used by the characterization tests to drive the module.
    updateBroadcastUI: updateBroadcastUI,
    updateModeUI: updateModeUI,
    updateLiveModeUI: updateLiveModeUI,
  };
});
