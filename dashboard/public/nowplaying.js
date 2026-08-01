/**
 * nowplaying.js — Now-playing / transport readout for the STUDIO 23 /
 * FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C3 of the broadcast-core refactor).
 * Owns the track clock, the transport progress bar and cue marker, the
 * now-playing title and BPM badge, the output-mode tag, and the Icecast /
 * FFmpeg stat row. init() starts the 1s progress ticker that was a module-scope
 * statement in app.js.
 *
 * OWNED STATE (moved with the functions that write it):
 *   trackStartedAt, trackDuration, trackMixDur, lastAudioMsg — written by
 *   updateAudio, reset by the STOP handler (which calls resetTrackState).
 *   startTime — written by updateIcecast from the server clock, read by the
 *   uptime ticker still in app.js via getStartTime().
 *   listenerHistory, peakListeners — appended by updateIcecast, read live by
 *   FRAnalytics through app.js's injected getters, now re-pointed here.
 *
 * getTrackStartedAt moved here with the state it reads. It was a seam in app.js
 * for the analyzer's BPM glow; app.js's FRAnalyzer wiring and the __appStudio
 * test hook both re-point to this module.
 *
 * NOT OWNED HERE — bpmMap. Its writers are the WS 'init' and 'bpm' frames,
 * whose bodies now live in broadcast.js, so bpmMap lives there too. This module
 * is one of its four injected readers, alongside FRQueue, FRFileMgmt and
 * FRPlaylists.
 *
 * Three small helpers encapsulate idioms app.js used at more than one site, so
 * the call sites stay one line each: onAudioFrame (cache then render, the WS
 * 'audio' case), replayLastAudio (the ARM and PLAY replays) and setMixDuration
 * (recompute the mix duration then reposition the cue, used by the
 * mixing-config frame and by setMixingMode).
 *
 * DOM refs are resolved once in init(), mirroring app.js's module-scope
 * caching. #studio-audio-track, #studio-bpm and the three transport nodes are
 * ALSO written by app.js's STOP and mixing handlers, so app.js keeps its own
 * refs and this module resolves the same elements by id.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/nowplaying.js"> (attaches its public API to
 * window.FRNowPlaying) AND required by the vitest suite via module.exports
 * (CJS). It deliberately uses NO top-level `export`/`import` so a browser
 * <script> can load it without a SyntaxError.
 */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.FRNowPlaying = api;
  }
})(function () {
  'use strict';

  // Injected host services (set by init). These defaults are placeholders for a
  // correctly-initialised host, NOT a safe pre-init mode: getBroadcastState
  // returning null makes updateAudio and updateTrackProgress throw, exactly as
  // the app.js closure would have before broadcastState was assigned. init() is
  // called during boot, before any consumer can reach these.
  var deps = {
    log: function () {},
    getBroadcastState: function () { return null; },
    getBpmMap: function () { return {}; },
    getMixMode: function () { return 'smart'; },
  };

  function log(msg) { return deps.log(msg); }
  function getBroadcastState() { return deps.getBroadcastState(); }
  function getBpmMap() { return deps.getBpmMap(); }
  function getMixMode() { return deps.getMixMode(); }

  // Shared FRUtils helpers resolved at call time (single source of truth).
  // Named apart from this module's own computeMixDur(bpm), which supplies the
  // current mix mode before delegating here.
  function utilsComputeMixDur(b, m) { return window.FRUtils.computeMixDur(b, m); }
  function cleanTrackName(f) { return window.FRUtils.cleanTrackName(f); }
  function formatTime(s) { return window.FRUtils.formatTime(s); }

  // -------------------------------------------------------------------------
  // Module-owned state (moved from the app.js closure).
  // -------------------------------------------------------------------------
  var trackStartedAt = 0;
  var trackDuration = 0;
  var trackMixDur = 0;
  var lastAudioMsg = null; // cached last audio message (for replay after ARM->PLAY)
  var startTime = Date.now();
  var listenerHistory = [];
  var peakListeners = 0;

  // DOM refs — assigned once by resolveDom() from init().
  var modeTag = null;
  var studioAudioTrack = null;
  var studioBpm = null;
  var transportElapsed = null;
  var transportDuration = null;
  var transportBarFill = null;
  var transportCue = null;
  var statListeners = null;
  var statAudioBr = null;
  var statFps = null;
  var statSpeed = null;
  var statVideoBr = null;
  var statTime = null;

  /**
   * Clear the transport readout back to its idle state.
   *
   * These six elements belong to this module — it resolves them and repaints
   * them on every tick — but the STOP path in broadcast.js used to write them
   * directly, so two modules assigned the same nodes. Same writes, one owner.
   */
  function resetTransportDom() {
    studioAudioTrack.textContent = '--';
    studioBpm.textContent = '';
    transportBarFill.style.width = '0%';
    transportElapsed.textContent = '0:00';
    transportDuration.textContent = '0:00';
    transportCue.style.display = 'none';
  }

  function resolveDom() {
    modeTag = document.getElementById('mode-tag');
    studioAudioTrack = document.getElementById('studio-audio-track');
    studioBpm = document.getElementById('studio-bpm');
    transportElapsed = document.getElementById('transport-elapsed');
    transportDuration = document.getElementById('transport-duration');
    transportBarFill = document.getElementById('transport-bar-fill');
    transportCue = document.getElementById('transport-cue');
    statListeners = document.getElementById('stat-listeners');
    statAudioBr = document.getElementById('stat-audio-br');
    statFps = document.getElementById('stat-fps');
    statSpeed = document.getElementById('stat-speed');
    statVideoBr = document.getElementById('stat-video-br');
    statTime = document.getElementById('stat-time');
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
    return utilsComputeMixDur(bpm, getMixMode());
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
    if (getBroadcastState().streamMode === 'standby' || getBroadcastState().streamMode === 'armed' || getBroadcastState().arming) return;
    var name = data.title || cleanTrackName(data.filename) || '--';
    studioAudioTrack.textContent = name;

    var filename = (data.filename || '').split('/').pop();
    // BPM lookup: try both original filename and extensionless match
    var bpm = getBpmMap()[filename];
    if (!bpm) {
      var stem = filename.replace(/\.[^.]+$/, '');
      for (var k in getBpmMap()) {
        if (k.replace(/\.[^.]+$/, '') === stem) { bpm = getBpmMap()[k]; break; }
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
    if (getBroadcastState().streamMode === 'standby' || getBroadcastState().streamMode === 'armed' || getBroadcastState().arming) return;
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

  /** Read-only seam over the track clock (was app.js's getTrackStartedAt). */
  function getTrackStartedAt() { return trackStartedAt; }

  /** The WS 'audio' case: cache the frame, then render it. */
  function onAudioFrame(data) {
    lastAudioMsg = data;
    updateAudio(data);
  }

  /** The ARM and PLAY replays of the cached frame. */
  function replayLastAudio() {
    if (lastAudioMsg) updateAudio(lastAudioMsg);
  }

  /** The STOP handler's reset of the track state (its DOM writes stay there). */
  function resetTrackState() {
    lastAudioMsg = null;
    trackStartedAt = 0;
    trackDuration = 0;
    trackMixDur = 0;
  }

  /** Recompute the mix duration for a BPM and reposition the cue marker. */
  function setMixDuration(bpm) {
    trackMixDur = computeMixDur(bpm);
    positionCueMarker();
  }

  function init(injected) {
    injected = injected || {};
    window.FRUtils.mergeDeps(deps, injected, 'FRNowPlaying');
    resolveDom();
    setInterval(updateTrackProgress, 1000);
  }

  return {
    init: init,
    updateMode: updateMode,
    computeMixDur: computeMixDur,
    onAudioFrame: onAudioFrame,
    replayLastAudio: replayLastAudio,
    updateIcecast: updateIcecast,
    updateFfmpeg: updateFfmpeg,
    getTrackStartedAt: getTrackStartedAt,
    resetTrackState: resetTrackState,
    resetTransportDom: resetTransportDom,
    setMixDuration: setMixDuration,
    getStartTime: function () { return startTime; },
    getListenerHistory: function () { return listenerHistory; },
    getPeakListeners: function () { return peakListeners; },

    // Surface used by the characterization tests to drive the module.
    updateAudio: updateAudio,
    updateTrackProgress: updateTrackProgress,
  };
});
