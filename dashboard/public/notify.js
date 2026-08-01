/**
 * notify.js — logging + error-toast ("notify") UI for the STUDIO 23 / FreeRadio
 * dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js notify refactor).
 * Combines two co-located DOM fan-out primitives:
 *
 *   - log(msg)        in-page ring-buffer logger -> #log debug console
 *   - showError(msg)  transient #error-banner toast (auto-hide after 5000ms)
 *   plus the #dbg-clear / #dbg-pause control buttons (bound in init()).
 *
 * Owns the ring-buffer state (`logs`) and the pause flag (`logsPaused`).
 *
 * Dependency injection: this domain is PURE DOM — it injects NO host services.
 * init(deps) accepts (and ignores) an optional deps object only to mirror the
 * sibling modules' signature; its real job is to (re)bind the #dbg-clear /
 * #dbg-pause buttons via bindDebugControls(). log()/showError() resolve their
 * DOM nodes (#log / #error-banner) via document.getElementById at CALL time, so
 * they work immediately with NO init-timing dependency — log() fires very early
 * during WS connect, long before the FRx.init wiring block runs.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/notify.js"> (attaches its public API to window.FRNotify) AND
 * required by the vitest suite via module.exports (CJS). It deliberately uses
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
    window.FRNotify = api;
  }
})(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Module-owned state (moved out of app.js). `logs` is the in-page ring buffer
  // (capped at 500); `logsPaused` freezes #log rendering while still buffering.
  // -------------------------------------------------------------------------
  var logsPaused = false;
  var logs = [];

  // -------------------------------------------------------------------------
  // Logging (behaviour-identical to the former app.js function). #log is
  // resolved at call time so log() works before any init wiring.
  // -------------------------------------------------------------------------
  function log(msg) {
    var logEl = document.getElementById('log');
    var ts = new Date().toISOString().slice(11, 23);
    console.log('[S23 ' + ts + '] ' + msg);
    logs.push('[' + ts + '] ' + msg);
    if (logs.length > 500) logs.shift();
    if (!logsPaused) {
      logEl.textContent = logs.join('\n');
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  function showError(msg) {
    var errorBanner = document.getElementById('error-banner');
    errorBanner.textContent = msg;
    errorBanner.classList.add('visible');
    log('ERROR: ' + msg);
    setTimeout(function() { errorBanner.classList.remove('visible'); }, 5000);
  }

  /**
   * Bind the #dbg-clear / #dbg-pause onclick handlers (were module-scope inline
   * statements in app.js). Called from init(); null-guarded for missing
   * elements. The handler bodies are byte-identical to the former app.js code,
   * resolving #log via getElementById at call time.
   */
  function bindDebugControls() {
    var dbgClear = document.getElementById('dbg-clear');
    if (dbgClear) dbgClear.onclick = function () { logs.length = 0; document.getElementById('log').textContent = ''; };
    var dbgPause = document.getElementById('dbg-pause');
    if (dbgPause) dbgPause.onclick = function () {
      logsPaused = !logsPaused;
      dbgPause.textContent = logsPaused ? 'Resume' : 'Pause';
      if (!logsPaused) {
        var logEl = document.getElementById('log');
        logEl.textContent = logs.join('\n');
        logEl.scrollTop = logEl.scrollHeight;
      }
    };
  }

  /**
   * No injected dependencies (pure DOM); init() just (re)binds the debug
   * controls. Safe to call more than once (the vitest harness re-inits per
   * test).
   */
  function init(injected) {
    bindDebugControls();
  }

  return {
    init: init,
    log: log,
    showError: showError,

    // Surface used by the characterization tests to drive the module.
    getLogs: function () { return logs; },
    setLogs: function (a) { logs = a; },
    getLogsPaused: function () { return logsPaused; },
    setLogsPaused: function (v) { logsPaused = v; },
  };
});
