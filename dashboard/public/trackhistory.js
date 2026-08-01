/**
 * trackhistory.js — Track-history sidebar UI for the STUDIO 23 / FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js track-history
 * refactor). Owns ZERO state. Polls GET /api/history?limit=10 and renders the
 * recent-tracks sidebar (#track-history-list) — the NOW badge, time-ago and BPM
 * rows — using cleanTrackName/timeAgo from window.FRUtils.
 *
 * Dependency injection: `init(deps)` receives the host services
 * (authFetch, log, showError). loadTrackHistory's .catch is intentionally empty
 * (silent failure), so log/showError are injected for template parity / future
 * use but are NOT exercised by any moved body. cleanTrackName/timeAgo are taken
 * from window.FRUtils (loaded before this file). The list DOM node is resolved
 * via document.getElementById at call time, exactly as the former app.js closure
 * referenced it. init() also runs the boot poll (loadTrackHistory() +
 * setInterval(loadTrackHistory, 15000)), preserving the original boot behaviour.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/trackhistory.js"> (attaches its public API to
 * window.FRTrackHistory) AND required by the vitest suite via module.exports
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
    window.FRTrackHistory = api;
  }
})(function () {
  'use strict';

  // Injected host services (set by init).
  var deps = {
    authFetch: function () { return Promise.reject(new Error('FRTrackHistory not initialised')); },
    log: function () {},
    showError: function () {},
  };

  // -------------------------------------------------------------------------
  // Helpers that resolve injected services at call time.
  // -------------------------------------------------------------------------
  function authFetch(url, opts) { return deps.authFetch(url, opts); }
  function log(msg) { return deps.log(msg); }
  function showError(msg) { return deps.showError(msg); }

  // Shared FRUtils helpers resolved at call time (single source of truth).
  function cleanTrackName(f) { return window.FRUtils.cleanTrackName(f); }
  function timeAgo(ts) { return window.FRUtils.timeAgo(ts); }

  // -------------------------------------------------------------------------
  // Track History (behaviour-identical to the former app.js functions).
  // -------------------------------------------------------------------------
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

  /**
   * Store injected dependencies, then run the boot poll (the load + 15s
   * interval that were module-scope statements in app.js). Safe to call once
   * per host; the vitest harness controls fetch so the boot load stays pending.
   */
  function init(injected) {
    injected = injected || {};
    window.FRUtils.mergeDeps(deps, injected, 'FRTrackHistory');
    loadTrackHistory();
    setInterval(loadTrackHistory, 15000);
  }

  return {
    init: init,
    loadTrackHistory: loadTrackHistory,

    // Surface used by the characterization tests to drive the module.
    renderTrackHistory: renderTrackHistory,
  };
});
