/**
 * restreamStatus.js — Restream STATUS widget for the STUDIO 23 / FreeRadio
 * dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js restream-status
 * refactor). Owns the per-platform LED status list (#restream-status-list):
 * renders one row per restream output from the rtmp-health WebSocket feed
 * (updateRestreamStatus), and falls back to GET /api/stream-keys when the WS
 * feed has no outputs (loadRestreamStatusFallback). This is the render-only
 * restream-STATUS cluster — it is DISTINCT from the already-extracted
 * restream-SETTINGS autostart control (window.FRRestreamSettings).
 *
 * The WS handleMessage dispatcher STAYS in app.js; it now reaches this widget
 * through FRRestreamStatus.updateRestreamStatus(...). The boot-time fallback
 * load is re-sourced as an explicit FRRestreamStatus.loadRestreamStatusFallback()
 * call in the FRx.init wiring block to preserve the original boot order.
 *
 * Dependency injection: `init(deps)` receives the host services (authFetch, log,
 * showError). The cluster owns no buttons, so init() only stores the deps. The
 * write-only state var lastRtmpHealth is moved here verbatim (assigned by
 * updateRestreamStatus, never read) and exposed via get/setLastRtmpHealth.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/restreamStatus.js"> (attaches its public API to
 * window.FRRestreamStatus) AND required by the vitest suite via module.exports
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
    window.FRRestreamStatus = api;
  }
})(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Module-owned state (moved out of app.js). Assigned by updateRestreamStatus
  // and never read back (write-only dead state); kept verbatim and exposed via
  // get/setLastRtmpHealth so the assignment stays observable.
  // -------------------------------------------------------------------------
  var lastRtmpHealth = null;

  // Injected host services (set by init).
  var deps = {
    authFetch: function () { return Promise.reject(new Error('FRRestreamStatus not initialised')); },
    log: function () {},
    showError: function () {},
  };

  // -------------------------------------------------------------------------
  // Helpers that resolve injected services / shared utils at call time.
  // -------------------------------------------------------------------------
  function authFetch(url, opts) { return deps.authFetch(url, opts); }
  function log(msg) { return deps.log(msg); }
  function showError(msg) { return deps.showError(msg); }

  function escapeHtml(s) {
    return window.FRUtils.escapeHtml(s);
  }

  // -------------------------------------------------------------------------
  // Restream status (behaviour-identical to the former app.js functions).
  // -------------------------------------------------------------------------
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

  /**
   * Store injected dependencies. The cluster owns no DOM buttons, so init() just
   * captures the deps. Safe to call more than once (the vitest harness re-inits
   * per test with its own deps).
   */
  function init(injected) {
    injected = injected || {};
    window.FRUtils.mergeDeps(deps, injected, 'FRRestreamStatus');
  }

  return {
    init: init,
    updateRestreamStatus: updateRestreamStatus,
    loadRestreamStatusFallback: loadRestreamStatusFallback,

    // Surface used by the characterization tests to drive the module.
    getLastRtmpHealth: function () { return lastRtmpHealth; },
    setLastRtmpHealth: function (v) { lastRtmpHealth = v; },
  };
});
