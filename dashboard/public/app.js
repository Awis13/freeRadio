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
  var uptimeEl = document.getElementById('uptime');
  // music-list / music-count / visuals-list / visuals-count refs moved into
  // filemgmt.js (window.FRFileMgmt), which resolves them via getElementById.
  // #log / #dbg-clear / #dbg-pause refs moved into notify.js (window.FRNotify),
  // which resolves them via getElementById.

  // --- Studio DOM refs ---
  var studioBpm = document.getElementById('studio-bpm');

  // PTT DOM refs moved into ptt.js (window.FRPtt), which resolves them via
  // getElementById inside FRPtt.init().


  // --- State ---
  // logsPaused / logs (the #log ring buffer) moved into notify.js (window.FRNotify).
  // musicFiles / visualFiles moved into filemgmt.js (window.FRFileMgmt); read via
  // FRFileMgmt.getMusicFiles() / getVisualFiles().

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
    var s = Math.floor((Date.now() - FRNowPlaying.getStartTime()) / 1000);
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
    getBroadcastState: FRBroadcast.getBroadcastState,
    setPlayerMuted: FRAnalyzer.setPlayerMuted,
    setUserInteracted: setUserInteracted,
    ensureAnalyzer: FRAnalyzer.ensureInited,
    resyncAnalyzerStream: FRAnalyzer.resyncStreamDecode,
    getWs: FRWsHub.getWs,
    reconnectWs: FRWsHub.reconnectNow,
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
    if (FRWsHub.getWs()) { try { FRWsHub.getWs().close(); } catch (e) {} }
    FRWsHub.connectWs();
    FRFileMgmt.loadFileList('music');
    FRFileMgmt.loadFileList('visuals');
    FRBroadcast.loadBroadcastState();
  }});
  FRAuth.checkAuth();

  FRNotify.init({});

  FRFileMgmt.init({
    authFetch: authFetch, log: log, showError: showError,
    showLoginOverlay: showLoginOverlay,
    renderTrackSelector: FRQueue.renderTrackSelector,
    loadOverlayAssets: function () { return FROverlays.loadOverlayAssets(); },
    getBpmMap: FRBroadcast.getBpmMap,
    getAuthToken: function () { return window.FRAuth.getAuthToken(); }
  });

  // Load file lists immediately
  FRFileMgmt.loadFileList('music');
  FRFileMgmt.loadFileList('visuals');

  // --- Now Playing / Transport ---
  // updateMode, computeMixDur, positionCueMarker, updateAudio,
  // updateTrackProgress, updateIcecast and updateFfmpeg now live in
  // nowplaying.js (window.FRNowPlaying), together with the track clock
  // (trackStartedAt / trackDuration / trackMixDur / lastAudioMsg), the server
  // start time and the listener history that updateIcecast feeds. Its init()
  // resolves the transport DOM and starts the 1s progress ticker.
  //
  // bpmMap stays here: its writers are the WS init and bpm frames below, and it
  // already has three injected readers (FRQueue, FRFileMgmt, FRPlaylists).
  FRNowPlaying.init({
    log: log,
    getBroadcastState: FRBroadcast.getBroadcastState,
    getBpmMap: FRBroadcast.getBpmMap,
    getMixMode: FRBroadcast.getMixMode
  });


  // Wire the WebSocket hub and open the first connection, where connectWs()
  // used to be called. Passing FRNowPlaying/FRAnalyzer methods as bare
  // references is safe: the UMD factories run at script load, so every module
  // object and its closures exist before app.js evaluates.
  FRWsHub.init({
    log: log,
    getAuthToken: function () { return window.FRAuth.getAuthToken(); },
    isServerFFT: FRAnalyzer.isServerFFT,
    handleFftFrame: FRAnalyzer.handleFftFrame,
    handlers: FRBroadcast.buildWsHandlers()
  });

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
    getBroadcastState: FRBroadcast.getBroadcastState,
    getBpmMap: FRBroadcast.getBpmMap,
    getMusicFiles: function () { return FRFileMgmt.getMusicFiles(); },
    getProcessedVisualFiles: FRBroadcast.getProcessedVisualFiles,
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
    getBpmMap: FRBroadcast.getBpmMap
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
  // authFetch plus live getters for the read-only listener state. The listener
  // history and peak now live in nowplaying.js, fed by its updateIcecast; the
  // getters are passed straight through so the module still reads them live.
  FRAnalytics.init({
    authFetch: authFetch,
    getListenerHistory: FRNowPlaying.getListenerHistory,
    getPeakListeners: FRNowPlaying.getPeakListeners
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
  // peakListeners moved to nowplaying.js with the updateIcecast that feeds them;
  // app.js passes FRNowPlaying's getters straight through, so the module still
  // reads them live.

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
  // The broadcast state machine - phase model, repaint, transport buttons, mode
  // cards, Live Mode bar, status polling and mixing pills - now lives in
  // broadcast.js (window.FRBroadcast), together with broadcastState, bpmMap,
  // processedVisualFiles, the mix mode and the WS handler bodies. Its init()
  // resolves the machine's DOM and runs the former module-scope statements in
  // their original order.
  FRBroadcast.init({
    authFetch: authFetch,
    log: log,
    showError: showError,
    getStudioPlayer: getStudioPlayer,
    setUserInteracted: setUserInteracted
  });

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
    getBroadcastState: FRBroadcast.getBroadcastState,
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
    getBroadcastState: FRBroadcast.getBroadcastState,
    getTrackStartedAt: FRNowPlaying.getTrackStartedAt,
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
      computeMixDur: FRNowPlaying.computeMixDur,
      getBroadcastPhase: FRBroadcast.getBroadcastPhase,
      uniquePlatformName: function (b) { return window.FRPlatforms.uniquePlatformName(b); },
      deriveUiMode: FRBroadcast.deriveUiMode,
      broadcastState: FRBroadcast.getBroadcastState(),
      getBroadcastState: FRBroadcast.getBroadcastState,
      getMixMode: FRBroadcast.getMixMode,
      setMixMode: FRBroadcast.setMixMode,
      setPlatformNames: function (a) { window.FRPlatforms.setCurrentPlatformNames(a); }
    };
    // Test-only WS reconnect handle: exposes the sole connection factory plus
    // read access to the closure-held live socket and backoff delay, so the
    // wsReconnectUI pins can drive onclose/onopen and assert the AS-IS backoff
    // doubling (cap 10000) + reset-to-1000 sequence. Additive only; no
    // production code path reads these — inert when __APP_TEST__ is unset.
    window.__appWs = {
      connectWs: FRWsHub.connectWs,
      getWs: FRWsHub.getWs,
      setWs: FRWsHub.setWs,
      getWsReconnectDelay: FRWsHub.getWsReconnectDelay
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
      getTrackStartedAt: FRNowPlaying.getTrackStartedAt
    };
  }

})();
