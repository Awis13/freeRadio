/**
 * quality.js — Quality-settings UI for the STUDIO 23 / FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js quality refactor).
 * Loads the current quality preset (GET /api/quality) into the #quality-select
 * element and posts the chosen preset back (POST /api/quality) on change.
 *
 * Dependency injection: `init(deps)` receives the host services (authFetch, log,
 * showError) and binds the #quality-select onchange handler. The #quality-select
 * DOM node is resolved via document.getElementById at call time, exactly as the
 * former app.js closure referenced it. The boot-time GET /api/quality is NOT
 * triggered by init(); the host calls loadQuality() explicitly at wiring time to
 * preserve the original boot order.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/quality.js"> (attaches its public API to window.FRQuality) AND
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
    window.FRQuality = api;
  }
})(function () {
  'use strict';

  // Injected host services (set by init).
  var deps = {
    authFetch: function () { return Promise.reject(new Error('FRQuality not initialised')); },
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
  // Quality Settings (behaviour-identical to the former app.js functions).
  // The #quality-select ref is resolved via getElementById at call time, where
  // app.js captured it once at top-of-file.
  // -------------------------------------------------------------------------
  function loadQuality() {
    var qualitySelect = document.getElementById('quality-select');
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

  /**
   * Bind the #quality-select onchange (was a module-scope inline statement in
   * app.js). Called from init() — runs AFTER deps are injected. Null-guarded for
   * a missing element. The select ref is resolved once and reused for both the
   * handler-time value read and the POST body.
   */
  function bindQualityChange() {
    var sel = document.getElementById('quality-select');
    if (!sel) return;
    sel.onchange = function() {
      var preset = sel.value;
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
  }

  /**
   * Store injected dependencies, then bind the onchange. Safe to call more than
   * once (the vitest harness re-inits per test with its own deps).
   */
  function init(injected) {
    injected = injected || {};
    for (var k in deps) {
      if (Object.prototype.hasOwnProperty.call(injected, k)) {
        deps[k] = injected[k];
      }
    }
    bindQualityChange();
  }

  return {
    init: init,
    loadQuality: loadQuality,
    bindQualityChange: bindQualityChange,
  };
});
