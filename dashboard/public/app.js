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

  // --- Logging + error-toast (notify.js / window.FRNotify, loaded before this
  // script) ---
  // log() and showError() are sourced from FRNotify as the single source of
  // truth. The names are kept identical so every existing call site — and every
  // sibling init({ log, showError }) pass — is untouched. These aliases precede
  // the first log/showError use (nothing above this line calls them), so the
  // former hoisted `function log` / `function showError` declarations are safely
  // replaced by these var bindings. FRNotify resolves #log / #error-banner via
  // getElementById at call time, so both work immediately (log() fires early
  // during WS connect, long before FRNotify.init wires the debug controls).
  var log = window.FRNotify.log;
  var showError = window.FRNotify.showError;

  // --- DOM refs ---
  var studioPlayer = document.getElementById('studio-player');
  function getStudioPlayer() { return studioPlayer; }
  var modeTag = document.getElementById('mode-tag');
  var uptimeEl = document.getElementById('uptime');
  var statListeners = document.getElementById('stat-listeners');
  var statAudioBr = document.getElementById('stat-audio-br');
  var statFps = document.getElementById('stat-fps');
  var statSpeed = document.getElementById('stat-speed');
  var statVideoBr = document.getElementById('stat-video-br');
  var statTime = document.getElementById('stat-time');
  // music-list / music-count / visuals-list / visuals-count refs moved into
  // filemgmt.js (window.FRFileMgmt), which resolves them via getElementById.
  // #log / #dbg-clear / #dbg-pause refs moved into notify.js (window.FRNotify),
  // which resolves them via getElementById.

  // --- Studio DOM refs ---
  var studioAudioTrack = document.getElementById('studio-audio-track');
  var studioBpm = document.getElementById('studio-bpm');
  var transportElapsed = document.getElementById('transport-elapsed');
  var transportDuration = document.getElementById('transport-duration');
  var transportBarFill = document.getElementById('transport-bar-fill');
  var transportCue = document.getElementById('transport-cue');
  var trackStartedAt = 0;
  // Read-only seam over the track clock. trackStartedAt is written by
  // updateAudio (from the WS 'audio' frame) and read by updateTrackProgress here
  // and by azUpdateGlow in analyzer.js. PURE indirection:
  // returns the same live var, zero behaviour change, no setter (updateAudio and
  // the STOP reset keep direct access).
  function getTrackStartedAt() { return trackStartedAt; }
  var trackDuration = 0;
  var trackMixDur = 0;
  var lastAudioMsg = null; // cached last audio message (for replay after ARM→PLAY)
  var skipBtn = document.getElementById('skip-btn');
  var clearQueueBtn = document.getElementById('clear-queue-btn');
  var queueSearch = document.getElementById('queue-search');
  var queuePanelTitle = document.getElementById('queue-panel-title');
  var queueSelectorTitle = document.getElementById('queue-selector-title');

  // PTT DOM refs moved into ptt.js (window.FRPtt), which resolves them via
  // getElementById inside FRPtt.init().

  // --- Mixing Mode DOM refs ---
  var mixModeContainer = document.getElementById('transport-mix-mode');
  var mixPills = mixModeContainer ? mixModeContainer.querySelectorAll('.mix-pill') : [];
  var currentMixMode = 'smart';
  function getMixMode() { return currentMixMode; }
  function setMixMode(mode) { currentMixMode = mode; }

  // --- State ---
  var bpmMap = {};
  // logsPaused / logs (the #log ring buffer) moved into notify.js (window.FRNotify).
  var startTime = Date.now();
  // musicFiles / visualFiles moved into filemgmt.js (window.FRFileMgmt); read via
  // FRFileMgmt.getMusicFiles() / getVisualFiles().
  var processedVisualFiles = [];
  var listenerHistory = [];
  var peakListeners = 0;

  // --- Auth ---
  // The auth/login cluster (authFetch wrapper, login overlay, doLogin, checkAuth,
  // authToken state) lives in auth.js (window.FRAuth), loaded before app.js. These
  // two aliases keep the ~37 in-file authFetch() call-sites, the sibling
  // init({ authFetch }) passes, and the FRFileMgmt.init showLoginOverlay pass
  // UNCHANGED. authFetch is captured here as a stable function reference because it
  // is fired at factory load (FRFileMgmt.loadFileList runs it before any
  // FRAuth.init). The mutable authToken is NOT aliased — read it live via
  // window.FRAuth.getAuthToken() (connectWs + the FRFileMgmt.init getter below).
  var authFetch = window.FRAuth.authFetch;
  var showLoginOverlay = window.FRAuth.showLoginOverlay;

  // --- Navigation (tab switching, collapsible panels, keyboard shortcuts) ---
  // Lives in navigation.js (window.FRNavigation), wired up via FRNavigation.init
  // below (which binds the three handlers and owns the activeTab state). The
  // per-tab lazy loaders are window.FRX.* module methods read directly off
  // window by the module.

  // --- Logging + error-toast ---
  // log() / showError() + the #log ring buffer, #dbg-clear/#dbg-pause handlers
  // and showError's transient #error-banner toast moved into notify.js
  // (window.FRNotify). The `log` / `showError` aliases at the top of this IIFE
  // resolve to FRNotify; FRNotify.init() (wired below) binds the debug controls.

  // --- Uptime ---
  setInterval(function () {
    var s = Math.floor((Date.now() - startTime) / 1000);
    var h = Math.floor(s / 3600); s %= 3600;
    var m = Math.floor(s / 60); s %= 60;
    uptimeEl.textContent = pad(h) + ':' + pad(m) + ':' + pad(s);
  }, 1000);

  // --- HLS Player (live-only, no scrubbing) ---
  // The player, the loading/standby overlays and the page-lifecycle recovery now
  // live in player.js (window.FRPlayer); FRPlayer.init() below injects the host
  // services and runs the boot side-effects that used to be statements here.
  // playerMuteBtn stays because the ARM/PLAY/STOP handlers and the /api/status
  // poll still read and write it; isIOS/isSafari stay because the analyzer reads
  // isSafari (azInit), and both are injected into the player module.
  var playerMuteBtn = document.getElementById('player-mute-btn');
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent) || isIOS;

  // Safari/iOS: hide analyzer (WebKit bug 180696)
  if (isSafari) {
    var _aw = document.getElementById('analyzer-wrap');
    if (_aw) _aw.style.display = 'none';
  }

  // Player-adjacent state that did NOT move with the player: playTransitionLock
  // is read/written only by the broadcast machine (ARM/PLAY/STOP and the
  // /api/status poll) and by no player code at all, and userInteracted is
  // studio-facade state read by setPlayerMuted and the studio test hook. The
  // player module receives setUserInteracted as a dep.
  var playTransitionLock = false; // prevents loadBroadcastState from interfering during PLAY
  var userInteracted = false; // blocks unmuting until user clicks ARM/PLAY/mute
  function getUserInteracted() { return userInteracted; }
  function setUserInteracted(v) { userInteracted = v; }

  // Wire the player module and run its boot side-effects (media-element
  // listeners, mute button, initPlayer(), page-lifecycle listeners) in the same
  // order they ran as inline statements. Everything the player needs from
  // another slice is injected as a narrow callback rather than reached for: the
  // analyzer and mute concerns resolve to FRAnalyzer methods (setPlayerMuted,
  // ensureInited, resyncStreamDecode), and only the WebSocket helpers are still
  // app.js-resident.
  FRPlayer.init({
    log: log,
    getStudioPlayer: getStudioPlayer,
    getBroadcastState: getBroadcastState,
    setPlayerMuted: FRAnalyzer.setPlayerMuted,
    setUserInteracted: setUserInteracted,
    ensureAnalyzer: FRAnalyzer.ensureInited,
    resyncAnalyzerStream: FRAnalyzer.resyncStreamDecode,
    getWs: function () { return getWs(); },
    reconnectWs: function () { wsReconnectDelay = 1000; connectWs(); },
    isIOS: isIOS,
    isSafari: isSafari
  });

  // Wire the file-management UI module (filemgmt.js / window.FRFileMgmt) BEFORE the
  // initial loads below. It owns musicFiles/visualFiles; app.js injects the host
  // services plus live getters for the WS-owned bpmMap and the mutable auth token
  // (both read at call time, never cached). renderTrackSelector and
  // loadOverlayAssets are now sibling-module methods (FRQueue / FROverlays),
  // called back into after a music load / overlay-asset upload.
  // Wire the notify UI module (notify.js / window.FRNotify). It takes no host
  // services (pure DOM); init() binds the #dbg-clear / #dbg-pause controls.
  // log()/showError() already work pre-init (resolved via the aliases above),
  // so this position is not load-bearing — it only binds the debug buttons.
  // Wire the auth module (auth.js / window.FRAuth). The token + login overlay are
  // already live (set up at FRAuth factory load, since authFetch runs before this);
  // init only injects the post-login callback — the WS reconnect + data reload that
  // stay app.js-resident. checkAuth() then runs the boot auth check (was an IIFE in
  // app.js): empty/invalid token -> showLoginOverlay, valid -> hideLoginOverlay.
  FRAuth.init({ onLogin: function () {
    if (getWs()) { try { getWs().close(); } catch (e) {} }
    connectWs();
    FRFileMgmt.loadFileList('music');
    FRFileMgmt.loadFileList('visuals');
    loadBroadcastState();
  }});
  FRAuth.checkAuth();

  FRNotify.init({});

  FRFileMgmt.init({
    authFetch: authFetch, log: log, showError: showError,
    showLoginOverlay: showLoginOverlay,
    renderTrackSelector: FRQueue.renderTrackSelector,
    loadOverlayAssets: function () { return FROverlays.loadOverlayAssets(); },
    getBpmMap: function () { return bpmMap; },
    getAuthToken: function () { return window.FRAuth.getAuthToken(); }
  });

  // Load file lists immediately
  FRFileMgmt.loadFileList('music');
  FRFileMgmt.loadFileList('visuals');

  // --- WebSocket ---
  var ws = null;
  var wsReconnectDelay = 1000;
  var wsReconnectTimer = null;

  // Facade seam over the shared-mutable `ws` socket handle (C2 of the core
  // facade-foundation PR). All reads/writes of `ws` route through these so a
  // future PR can inject the socket without touching every call site. PURE
  // indirection — getWs() returns the same value, setWs() assigns the same
  // value; zero behaviour change. wsReconnectDelay/wsReconnectTimer stay
  // internal (not facaded).
  function getWs() { return ws; }
  function setWs(v) { ws = v; }

  function connectWs() {
    // Cancel any pending reconnect to avoid stacking (iOS resume can fire multiple times)
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    // Close stale socket if still lingering
    if (getWs()) {
      try { getWs().onclose = null; getWs().close(); } catch(e) {}
      setWs(null);
    }
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = proto + '//' + location.host;
    setWs(new WebSocket(wsUrl));

    getWs().onopen = function () {
      log('ws: connected');
      wsReconnectDelay = 1000;
      // Send auth token as first message (read live from FRAuth — it is mutable).
      var token = window.FRAuth.getAuthToken();
      if (token) {
        getWs().send(JSON.stringify({type: 'auth', token: token}));
      }
      // Subscribe to server-side FFT if Safari analyzer is active
      if (FRAnalyzer.isServerFFT()) {
        getWs().send(JSON.stringify({type: 'fft-subscribe'}));
      }
    };

    getWs().onclose = function () {
      log('ws: disconnected, reconnecting in ' + (wsReconnectDelay / 1000) + 's');
      wsReconnectTimer = setTimeout(connectWs, wsReconnectDelay);
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, 10000);
    };

    getWs().onerror = function () {
      log('ws: error');
    };

    getWs().binaryType = 'arraybuffer';
    getWs().onmessage = function (evt) {
      if (typeof evt.data !== 'string') {
        // Binary FFT frame from server
        FRAnalyzer.handleFftFrame(new Uint8Array(evt.data));
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
        if (msg.data.rtmpHealth) FRRestreamStatus.updateRestreamStatus(msg.data.rtmpHealth);
        FRFileMgmt.loadFileList('music');
        FRFileMgmt.loadFileList('visuals');
        break;
      case 'audio':
        lastAudioMsg = msg.data;
        updateAudio(msg.data);
        break;
      case 'video':
        if (FRPlayer.getPendingModeSwitch()) {
          // New clip started in feed_fifo, but HLS player still has ~2s of buffered
          // old content (hls_time=1 × liveSyncDurationCount=1 + segment pipeline).
          // Wait for buffer to flush before hiding overlay.
          log('MODE new clip detected: ' + (msg.data && msg.data.filename || '?') + ', waiting for HLS buffer...');
          setTimeout(function() {
            FRPlayer.setPendingModeSwitch(false);
            FRPlayer.hideLoading('mode-applied');
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
        FRRestreamStatus.updateRestreamStatus(msg.data);
        break;
      case 'voice-status':
        if (msg.data && msg.data.status === 'on-air') {
          log('PTT: voice message on air');
        }
        break;
      case 'mixing-config':
        if (msg.data && msg.data.mode) {
          setMixMode(msg.data.mode);
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
    return FRU.computeMixDur(bpm, getMixMode());
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
  // The track queue, the video queue and the track selector now live in
  // queue.js (window.FRQueue). FRQueue.init() below injects the host services
  // and runs the boot side-effects that used to be statements here: binding the
  // skip/clear buttons and the search input, the first queue load, and the 5s
  // active-queue poll.
  //
  // NOTE: updateBroadcastUI further down RE-ASSIGNS skipBtn.onclick and
  // clearQueueBtn.onclick on every repaint, with duplicates of the bodies that
  // moved into queue.js. Both copies are kept deliberately — collapsing them is
  // a behaviour change, not part of this extraction.
  FRQueue.init({
    authFetch: authFetch,
    log: log,
    showError: showError,
    getBroadcastState: getBroadcastState,
    getBpmMap: function () { return bpmMap; },
    getMusicFiles: function () { return FRFileMgmt.getMusicFiles(); },
    getProcessedVisualFiles: function () { return processedVisualFiles; },
    loadTrackHistory: function () { return FRTrackHistory.loadTrackHistory(); }
  });

  // ============================
  // TRACK HISTORY (Studio sidebar)
  // ============================
  // The track-history sidebar (loadTrackHistory / renderTrackHistory) now lives
  // in trackhistory.js (window.FRTrackHistory), wired via FRTrackHistory.init(...)
  // below. init() runs the boot poll (loadTrackHistory() + 15s interval). The
  // queue skip handlers re-source the post-skip refresh as
  // FRTrackHistory.loadTrackHistory().

  // ============================
  // RESTREAM STATUS WIDGET
  // ============================
  // The WS-fed restream-STATUS widget (updateRestreamStatus /
  // loadRestreamStatusFallback / lastRtmpHealth) now lives in restreamStatus.js
  // (window.FRRestreamStatus), wired via FRRestreamStatus.init(...) below. The WS
  // handleMessage dispatcher stays here and calls
  // FRRestreamStatus.updateRestreamStatus(...); the boot-time fallback load is
  // re-sourced as FRRestreamStatus.loadRestreamStatusFallback() in that wiring.

  // ============================
  // GENERIC MODAL
  // ============================
  // The generic-modal UI lives in genericModal.js (window.FRGenericModal). It is
  // pure DOM, so init() takes no host services — it just resolves the modal DOM
  // refs and binds #generic-modal-save + the backdrop. window.closeGenericModal
  // is assigned by the module at load time, so the deferred
  // `function(){ return window.closeGenericModal(); }` wrappers below keep
  // working. The openGenericModal alias re-exposes the module function under the
  // name the sibling init() calls below reference directly. This MUST run before
  // those init() calls so the alias is assigned in time.
  var openGenericModal = window.FRGenericModal.openGenericModal;
  FRGenericModal.init({});

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
    loadQueue: FRQueue.loadQueue,
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

  // Wire the schedule UI module (schedule.js / window.FRSchedule) with the host
  // services. init() also binds the save/add-slot/add-event buttons and starts
  // the 30s current-slot poll. closeGenericModal is assigned to window further
  // down the IIFE, so it is wrapped to defer the lookup to call time.
  FRSchedule.init({
    authFetch: authFetch, log: log, showError: showError,
    openGenericModal: openGenericModal,
    closeGenericModal: function () { return window.closeGenericModal(); }
  });

  // Wire the video-playlists UI module (videoplaylists.js /
  // window.FRVideoPlaylists) with the host services. init() also binds the
  // create-video-playlist-btn and the vpl-update-rules-btn. closeGenericModal is
  // assigned to window further down the IIFE, so it is wrapped to defer the
  // lookup to call time.
  FRVideoPlaylists.init({
    authFetch: authFetch, log: log, showError: showError,
    openGenericModal: openGenericModal,
    closeGenericModal: function () { return window.closeGenericModal(); }
  });

  // Wire the overlays config UI module (overlays.js / window.FROverlays) with the
  // host services. init() also assigns window.toggleOverlayLayer /
  // updateOverlayLayer / removeOverlayLayer and binds the #overlays-enabled-check
  // + #add-overlay-btn handlers. closeGenericModal is assigned to window further
  // down the IIFE, so it is wrapped to defer the lookup to call time.
  FROverlays.init({
    authFetch: authFetch, log: log, showError: showError,
    openGenericModal: openGenericModal,
    closeGenericModal: function () { return window.closeGenericModal(); }
  });

  // Wire the stream-platforms / stream-keys UI module (platforms.js /
  // window.FRPlatforms) with the host services. init() captures the platform DOM
  // refs, assigns window.savePlatform / window.closePlatformModal (driven via
  // inline onclick in index.html), binds the add/preset/modal handlers, and
  // starts the boot auto-load + 30s poll. The domain owns its #platform-modal, so
  // no openGenericModal/closeGenericModal is needed.
  FRPlatforms.init({ authFetch: authFetch, log: log, showError: showError });

  // Wire the quality-settings UI module (quality.js / window.FRQuality) with the
  // host services. init() binds the #quality-select onchange; the boot-time GET
  // /api/quality is re-sourced here as an explicit loadQuality() call to
  // preserve the original boot order.
  FRQuality.init({ authFetch: authFetch, log: log, showError: showError });
  FRQuality.loadQuality();

  // Wire the audio/video enhancement-settings UI module (enhanceSettings.js /
  // window.FREnhance) with the host services. init() binds the #audio-enhance
  // and #video-enhance onchange handlers; the boot-time GET /api/audio and
  // GET /api/video are re-sourced here as explicit loader calls to preserve the
  // original boot order.
  FREnhance.init({ authFetch: authFetch, log: log, showError: showError });
  FREnhance.loadAudioSettings();
  FREnhance.loadVideoSettings();

  // Wire the restream auto-start UI module (restreamSettings.js /
  // window.FRRestreamSettings) with the host services. init() resolves the
  // #restream-autostart-checkbox and binds its onchange; the boot-time GET
  // /api/restream/settings is re-sourced here as an explicit loadRestreamSettings()
  // call to preserve the original boot order.
  FRRestreamSettings.init({ authFetch: authFetch, log: log, showError: showError });
  FRRestreamSettings.loadRestreamSettings();

  // Wire the WS-fed restream-STATUS widget module (restreamStatus.js /
  // window.FRRestreamStatus) with the host services. init() just stores the deps
  // (the cluster owns no buttons); the boot-time GET /api/stream-keys fallback is
  // re-sourced here as an explicit loadRestreamStatusFallback() call to preserve
  // the original boot order.
  FRRestreamStatus.init({ authFetch: authFetch, log: log, showError: showError });
  FRRestreamStatus.loadRestreamStatusFallback();

  // Wire the track-history sidebar module (trackhistory.js /
  // window.FRTrackHistory) with the host services. init() stores the deps AND
  // runs the boot poll (loadTrackHistory() + setInterval(loadTrackHistory,
  // 15000)), so no separate boot call is needed here.
  FRTrackHistory.init({ authFetch: authFetch, log: log, showError: showError });

  // Wire the channel-strip DSP UI module (channelstrip.js /
  // window.FRChannelStrip) with the host services. init() captures the five
  // strip DOM refs (bypass/preset/badge/gate-LED/comp-GR), binds the bypass +
  // preset + slider handlers, and runs the self-contained boot config load + 2s
  // metering auto-start gate — preserving the original boot order.
  FRChannelStrip.init({ authFetch: authFetch, log: log, showError: showError });

  // Wire the push-to-talk UI module (ptt.js / window.FRPtt) with the host
  // services. init() resolves the PTT DOM refs and wires the rec/play/discard/
  // send buttons, settings toggle and duck/gain sliders — preserving the
  // original boot-time binding order.
  FRPtt.init({ authFetch: authFetch, log: log, showError: showError });

  // Wire the analytics UI module (analytics.js / window.FRAnalytics) with
  // authFetch plus live getters for the read-only listener state. The getters are
  // read at call time so the module always sees the latest listenerHistory /
  // peakListeners written by the WS updateIcecast handler.
  FRAnalytics.init({
    authFetch: authFetch,
    getListenerHistory: function () { return listenerHistory; },
    getPeakListeners: function () { return peakListeners; }
  });

  // Wire the navigation UI module (navigation.js / window.FRNavigation). init()
  // binds the tab-switch / collapsible-panel / Space-shortcut handlers and owns
  // the activeTab state. No deps: the per-tab loaders are window.FRX.* methods.
  FRNavigation.init({});

  // ============================
  // SCHEDULE
  // ============================
  // The schedule UI lives in schedule.js (window.FRSchedule), wired up via
  // FRSchedule.init(...) above (which also binds the save/add-slot/add-event
  // buttons and starts the 30s current-slot poll). Callers use
  // FRSchedule.loadSchedule() / FRSchedule.loadPlaylistsForSelect().

  // ============================
  // VISUAL PROFILES
  // ============================
  // The visual-profiles UI lives in visualprofiles.js (window.FRVisualProfiles),
  // wired up via FRVisualProfiles.init(...) above (which also binds the
  // create-visual-profile-btn). Callers use FRVisualProfiles.loadVisualProfiles().


  // ============================
  // VIDEO PLAYLISTS
  // ============================
  // The video-playlists UI lives in videoplaylists.js (window.FRVideoPlaylists),
  // wired up via FRVideoPlaylists.init(...) above (which also binds the
  // create-video-playlist-btn and the vpl-update-rules-btn). Callers use
  // FRVideoPlaylists.loadVideoPlaylists().

  // ============================
  // OVERLAYS
  // ============================
  // The overlays config UI lives in overlays.js (window.FROverlays), wired up
  // via FROverlays.init(...) near the other FRx.init calls (it also assigns the
  // window.toggleOverlayLayer / updateOverlayLayer / removeOverlayLayer globals
  // and binds the #overlays-enabled-check + #add-overlay-btn handlers). Callers
  // use FROverlays.loadOverlays() / FROverlays.loadOverlayAssets().

  // ============================
  // ANALYTICS
  // ============================
  // Analytics UI (loadAnalytics / drawListenerChart / loadHistoryStats /
  // drawTopTracksChart) lives in analytics.js (window.FRAnalytics), wired up via
  // FRAnalytics.init near the FRPlaylists.init call. listenerHistory and
  // peakListeners stay here (fed by the WS updateIcecast handler) and are read by
  // the module live through the injected getters.

  // ============================
  // RESTREAM SETTINGS (Studio sidebar)
  // ============================
  // The stream-platforms / stream-keys domain lives in platforms.js
  // (window.FRPlatforms), wired up via FRPlatforms.init(...) near the other
  // FRx.init calls. The restream auto-start control now lives in
  // restreamSettings.js (window.FRRestreamSettings), wired via
  // FRRestreamSettings.init(...) below. The WS-fed restream-STATUS widget
  // (updateRestreamStatus / lastRtmpHealth) now lives in restreamStatus.js
  // (window.FRRestreamStatus), wired via FRRestreamStatus.init(...) below.

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
    skipBtn.onclick = isVideoMode ? FRQueue.skipVideo : function() {
      authFetch('/api/queue/skip', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok) {
            log('queue: skipped track');
            setTimeout(FRQueue.loadQueue, 1000);
            setTimeout(FRTrackHistory.loadTrackHistory, 2000);
          }
        })
        .catch(function(e) { showError('Skip failed: ' + e); });
    };
    clearQueueBtn.onclick = isVideoMode ? FRQueue.clearVideoQueue : function() {
      authFetch('/api/queue/clear', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok) {
            log('queue: cleared');
            FRQueue.loadQueue();
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
          if (lastAudioMsg) updateAudio(lastAudioMsg);
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
        if (lastAudioMsg) updateAudio(lastAudioMsg);
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
        FRPlayer.stopStaticNoise();
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

  loadProcessedVisuals();
  loadBroadcastState();
  setInterval(loadBroadcastState, 15000);
  setInterval(loadProcessedVisuals, 30000);

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
          trackMixDur = computeMixDur(bpm);
          positionCueMarker();
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

  mixPills.forEach(function(pill) {
    pill.addEventListener('click', function() {
      var mode = pill.dataset.mixmode;
      if (mode && mode !== getMixMode()) {
        setMixingMode(mode);
      }
    });
  });

  loadMixingConfig();

  // ============================================================
  // MONITOR MIXER — Talk Over mode + Live/AFK browser mic
  // ============================================================
  // The mixer, its meters, the auto-duck envelope and the browser-mic streaming
  // loop now live in mixer.js (window.FRMixer). FRMixer.init() below injects the
  // host services and runs the boot side-effects that used to be statements
  // here: resolving the mm-* DOM refs, binding the control listeners under their
  // `if (element)` guards, enumerating devices, and the 2s streaming check.
  //
  // Nothing foreign was declared in that region, so all of its state moved.
  // monitorMusicGain/mmMasterGain are read by FRAnalyzer.setPlayerMuted through
  // FRMixer live getters rather than being copied.
  //
  // The analyzer graph the faders and the duck envelope drive is injected as
  // method references on FRAnalyzer; those are safe to pass here even though
  // FRAnalyzer.init runs later, because the UMD factory has already built the
  // module object and every getter returns null until azInit runs - exactly the
  // pre-extraction behaviour.
  FRMixer.init({
    log: log,
    showError: showError,
    authFetch: authFetch,
    getStudioPlayer: getStudioPlayer,
    getBroadcastState: getBroadcastState,
    getAudioCtx: FRAnalyzer.getAudioCtx,
    getGainNode: FRAnalyzer.getGainNode,
    getMainAnalyser: FRAnalyzer.getMainAnalyser,
    ensureAnalyzer: FRAnalyzer.ensureInited
  });

  // ============================================================
  // CRT ANALYZER — multi-mode audio visualizer
  // ============================================================
  // The analyzer, its WebAudio graph, the Safari server-FFT path and the player
  // mute control now live in analyzer.js (window.FRAnalyzer). FRAnalyzer.init()
  // injects the host services and runs the boot side-effects that used to be
  // statements here: resolving the analyzer DOM refs, binding the mode /
  // on-off / theme controls, applying the saved theme, wiring the Safari
  // sync-offset UI, and registering the resize listener.
  //
  // setPlayerMuted moved with the graph it drives (azGainNode), so app.js and
  // the player module both call FRAnalyzer.setPlayerMuted. isSafari stays here
  // because it is UA detection shared with the player, and is injected.
  FRAnalyzer.init({
    log: log,
    authFetch: authFetch,
    getStudioPlayer: getStudioPlayer,
    getUserInteracted: getUserInteracted,
    getBroadcastState: getBroadcastState,
    getTrackStartedAt: getTrackStartedAt,
    getStudioBpmEl: function () { return studioBpm; },
    getMonitorMusicGain: FRMixer.getMonitorMusicGain,
    getMasterGain: FRMixer.getMasterGain,
    isSafari: isSafari
  });

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
      uniquePlatformName: function (b) { return window.FRPlatforms.uniquePlatformName(b); },
      deriveUiMode: deriveUiMode,
      broadcastState: broadcastState,
      getBroadcastState: getBroadcastState,
      getMixMode: getMixMode,
      setMixMode: setMixMode,
      setPlatformNames: function (a) { window.FRPlatforms.setCurrentPlatformNames(a); }
    };
    // Test-only WS reconnect handle: exposes the sole connection factory plus
    // read access to the closure-held live socket and backoff delay, so the
    // wsReconnectUI pins can drive onclose/onopen and assert the AS-IS backoff
    // doubling (cap 10000) + reset-to-1000 sequence. Additive only; no
    // production code path reads these — inert when __APP_TEST__ is unset.
    window.__appWs = {
      connectWs: connectWs,
      getWs: getWs,
      setWs: setWs,
      getWsReconnectDelay: function () { return wsReconnectDelay; }
    };
    // Test-only WebAudio facade handle: exposes the five read-only graph
    // getters so the analyzer-audio identity pins can assert getX() === the
    // live var — null in jsdom where azInit never runs on boot. Additive only;
    // inert when __APP_TEST__ is unset.
    window.__appAudio = {
      getAudioCtx: FRAnalyzer.getAudioCtx,
      getGainNode: FRAnalyzer.getGainNode,
      getMainAnalyser: FRAnalyzer.getMainAnalyser,
      getAzL: FRAnalyzer.getAzL,
      getAzR: FRAnalyzer.getAzR,
      getAzInited: FRAnalyzer.getAzInited
    };
    // Test-only studio/interaction facade handle: exposes the read-only getters
    // so studio state pins can assert getX() === the live var. Additive only;
    // inert when __APP_TEST__ is unset.
    window.__appStudio = {
      getStudioPlayer: getStudioPlayer,
      getUserInteracted: getUserInteracted,
      getTrackStartedAt: getTrackStartedAt
    };
  }

})();
