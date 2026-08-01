/**
 * navigation.js — Top-level navigation UI for the STUDIO 23 / FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js navigation refactor).
 * Owns the active-tab state (`activeTab`) and binds the three navigation
 * handlers: tab switching (`.tab-btn` clicks, which lazy-load each tab's data on
 * activation), collapsible panels (`.panel-toggle` clicks), and the Space
 * keyboard shortcut (skip on the studio tab).
 *
 * Dependency injection: `init(deps)` takes no loader callbacks — every per-tab
 * lazy loader is a window.FRX.* module method (FRPlaylists / FRSchedule /
 * FRVisualProfiles / FRVideoPlaylists / FROverlays / FRAnalytics), read directly
 * off `window` at call time exactly as the former app.js closure referenced the
 * globals. init() binds the three handlers (each null-guarded) after deps are
 * stored. The Space handler re-queries document.getElementById('skip-btn') at
 * click time (the only non-verbatim adaptation, replacing the captured app.js
 * closure ref) so it always reaches the live #skip-btn.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/navigation.js"> (attaches its public API to window.FRNavigation)
 * AND required by the vitest suite via module.exports (CJS). It deliberately uses
 * NO top-level `export`/`import` so a browser <script> can load it without a
 * SyntaxError.
 */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.FRNavigation = api;
  }
})(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Module-owned state (moved out of app.js). Tracks the active top-level tab;
  // read by the Space handler to gate the skip shortcut to the studio tab.
  // -------------------------------------------------------------------------
  var activeTab = 'studio';

  // Injected host services (set by init). No loader callbacks: every per-tab
  // loader is a window.FRX.* module method read directly off window.
  var deps = {};

  /**
   * Bind the three navigation handlers (was module-scope inline statements in
   * app.js). Called from init() — runs AFTER deps are stored. Each block is
   * null-guarded for missing DOM.
   */
  function bindHandlers() {
    // --- Tab Switching ---
    document.querySelectorAll('.tab-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var tab = btn.dataset.tab;
        activeTab = tab;
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
        document.getElementById('tab-' + tab).classList.add('active');
        if (tab === 'playlists') window.FRPlaylists.loadPlaylists();
        if (tab === 'schedule') { window.FRSchedule.loadSchedule(); window.FRSchedule.loadPlaylistsForSelect(); }
        if (tab === 'visuals') { window.FRVisualProfiles.loadVisualProfiles(); window.FRVideoPlaylists.loadVideoPlaylists(); window.FROverlays.loadOverlays(); window.FROverlays.loadOverlayAssets(); }
        if (tab === 'analytics') window.FRAnalytics.loadAnalytics();
      });
    });

    // --- Collapsible panels ---
    document.querySelectorAll('.panel-toggle').forEach(function(head) {
      head.addEventListener('click', function(e) {
        if (e.target.closest('.dbg-actions')) return;
        var panel = head.closest('.panel-collapsible');
        panel.classList.toggle('collapsed');
      });
    });

    // --- Keyboard shortcuts ---
    document.addEventListener('keydown', function(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space' && activeTab === 'studio') {
        e.preventDefault();
        var sb = document.getElementById('skip-btn'); if (sb) sb.click();
      }
    });
  }

  /**
   * Store injected dependencies, then bind the handlers. Safe to call more than
   * once (the vitest harness re-inits per test with its own deps).
   */
  function init(injected) {
    injected = injected || {};
    window.FRUtils.mergeDeps(deps, injected, 'FRNavigation');
    bindHandlers();
  }

  return {
    init: init,

    // Surface used by the characterization tests to drive the module.
    getActiveTab: function () { return activeTab; },
    setActiveTab: function (v) { activeTab = v; }
  };
});
