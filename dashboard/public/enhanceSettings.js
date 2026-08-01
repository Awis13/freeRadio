/**
 * enhanceSettings.js — Audio/Video enhancement-settings UI for the STUDIO 23 /
 * FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js enhancement
 * refactor). Two structural-twin clusters live here: the audio-enhancement
 * checkbox (#audio-enhance, GET/POST /api/audio) and the video-enhancement
 * checkbox (#video-enhance, GET/POST /api/video). Each loader fetches the
 * current state into its checkbox; each onchange posts the new state back.
 *
 * Dependency injection: `init(deps)` receives the host services (authFetch,
 * log, showError) and binds both checkbox onchange handlers. The checkbox DOM
 * nodes are resolved via document.getElementById at call time, exactly as the
 * former app.js closure referenced them. The boot-time GET /api/audio and
 * GET /api/video are NOT triggered by init(); the host calls
 * loadAudioSettings() / loadVideoSettings() explicitly at wiring time to
 * preserve the original boot order.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/enhanceSettings.js"> (attaches its public API to
 * window.FREnhance) AND required by the vitest suite via module.exports (CJS).
 * It deliberately uses NO top-level `export`/`import` so a browser <script>
 * can load it without a SyntaxError.
 */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.FREnhance = api;
  }
})(function () {
  'use strict';

  // Injected host services (set by init).
  var deps = {
    authFetch: function () { return Promise.reject(new Error('FREnhance not initialised')); },
    log: function () {},
    showError: function () {},
  };

  // -------------------------------------------------------------------------
  // Helpers that resolve injected services at call time.
  // -------------------------------------------------------------------------
  function authFetch(url, opts) { return deps.authFetch(url, opts); }
  function log(msg) { return deps.log(msg); }
  function showError(msg) { return deps.showError(msg); }

  // -------------------------------------------------------------------------
  // Accessors for the checkbox nodes (resolved via getElementById at call
  // time). app.js exposed these via the __appEnhance test hook; the pins reach
  // the exact nodes the loaders/onchange bind to through them.
  // -------------------------------------------------------------------------
  function getAudioEnhanceCheck() { return document.getElementById('audio-enhance'); }
  function getVideoEnhanceCheck() { return document.getElementById('video-enhance'); }

  // -------------------------------------------------------------------------
  // Audio Enhancement Settings (behaviour-identical to the former app.js
  // functions). The #audio-enhance ref is resolved via getElementById at call
  // time, where app.js captured it once inline at the cluster.
  // -------------------------------------------------------------------------
  function loadAudioSettings() {
    var audioEnhanceCheck = document.getElementById('audio-enhance');
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

  /**
   * Bind the #audio-enhance onchange (was a module-scope inline statement in
   * app.js). Called from init() — runs AFTER deps are injected. Null-guarded
   * for a missing element. The checkbox ref is resolved once and reused for the
   * handler-time value read and the POST body.
   */
  function bindAudioChange() {
    var audioEnhanceCheck = document.getElementById('audio-enhance');
    if (!audioEnhanceCheck) return;
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

  // -------------------------------------------------------------------------
  // Video Enhancement Settings (structural twin of the audio cluster).
  // -------------------------------------------------------------------------
  function loadVideoSettings() {
    var videoEnhanceCheck = document.getElementById('video-enhance');
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

  /**
   * Bind the #video-enhance onchange. Twin of bindAudioChange.
   */
  function bindVideoChange() {
    var videoEnhanceCheck = document.getElementById('video-enhance');
    if (!videoEnhanceCheck) return;
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

  /**
   * Store injected dependencies, then bind both onchange handlers. Safe to call
   * more than once (the vitest harness re-inits per test with its own deps).
   */
  function init(injected) {
    injected = injected || {};
    window.FRUtils.mergeDeps(deps, injected, 'FREnhance');
    bindAudioChange();
    bindVideoChange();
  }

  return {
    init: init,
    loadAudioSettings: loadAudioSettings,
    loadVideoSettings: loadVideoSettings,

    // Surface used by the characterization tests to drive the module.
    getAudioEnhanceCheck: getAudioEnhanceCheck,
    getVideoEnhanceCheck: getVideoEnhanceCheck,
  };
});
