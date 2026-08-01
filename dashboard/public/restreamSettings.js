/**
 * restreamSettings.js — Restream auto-start UI for the STUDIO 23 / FreeRadio
 * dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js restream-settings
 * refactor). Owns the single #restream-autostart-checkbox in the Stream
 * Platforms panel: loads the persisted autoStart flag (GET /api/restream/settings)
 * and persists changes (POST /api/restream/settings). This is the
 * restream-SETTINGS cluster only — the WS-fed restream-STATUS widget
 * (updateRestreamStatus / lastRtmpHealth) stays in app.js.
 *
 * Dependency injection: `init(deps)` receives the host services
 * (authFetch, log, showError). The checkbox element is resolved via
 * document.getElementById in init() and stored in a module-private var, exactly
 * as the former app.js closure referenced it. init() also binds the checkbox
 * onchange (the only DOM bind this domain owns); that handler reaches authFetch /
 * log / showError through the injected deps, so it no longer relies on the
 * module-scope binding the old app.js used.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/restreamSettings.js"> (attaches its public API to
 * window.FRRestreamSettings) AND required by the vitest suite via module.exports
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
    window.FRRestreamSettings = api;
  }
})(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Module-owned state (moved out of app.js). Resolved in init() from
  // #restream-autostart-checkbox; referenced by the moved function bodies under
  // the SAME name so they stay byte-identical.
  // -------------------------------------------------------------------------
  var restreamAutoStartCheckbox = null;

  // Injected host services (set by init).
  var deps = {
    authFetch: function () { return Promise.reject(new Error('FRRestreamSettings not initialised')); },
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
  // Restream settings (behaviour-identical to the former app.js functions).
  // -------------------------------------------------------------------------
  function loadRestreamSettings() {
    authFetch('/api/restream/settings')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        restreamAutoStartCheckbox.checked = !!data.autoStart;
      })
      .catch(function(e) { log('restream settings: error loading: ' + e); });
  }

  /**
   * Bind the autostart checkbox onchange (was a module-scope inline statement in
   * app.js). Called from init() — runs AFTER deps are injected and the element is
   * resolved, so the handler reaches authFetch/log/showError via deps rather than
   * relying on the old module-scope binding. Null-guarded for a missing element.
   */
  function bindAutoStart() {
    if (!restreamAutoStartCheckbox) return;
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
  }

  /**
   * Store injected dependencies, resolve the checkbox element, then bind its
   * onchange. Safe to call more than once (the vitest harness re-inits per test
   * with its own deps).
   */
  function init(injected) {
    injected = injected || {};
    window.FRUtils.mergeDeps(deps, injected, 'FRRestreamSettings');
    restreamAutoStartCheckbox = document.getElementById('restream-autostart-checkbox');
    bindAutoStart();
  }

  return {
    init: init,
    loadRestreamSettings: loadRestreamSettings,

    // Surface used by the characterization tests to drive the module.
    getAutoStart: function () { return restreamAutoStartCheckbox ? restreamAutoStartCheckbox.checked : undefined; },
    setAutoStart: function (v) { if (restreamAutoStartCheckbox) restreamAutoStartCheckbox.checked = v; },
  };
});
