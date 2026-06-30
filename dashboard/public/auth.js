/**
 * auth.js — Auth/login UI for the STUDIO 23 / FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js auth refactor). Owns
 * the auth token state (`authToken`, seeded from localStorage at factory load),
 * the authFetch wrapper (injects the Authorization Bearer header and bounces a
 * 401 to the login overlay), the login-overlay DOM (showLoginOverlay /
 * hideLoginOverlay), doLogin, and the boot-time checkAuth.
 *
 * DEPENDENCY ROOT — unlike the other extracted domains, this module CANNOT defer
 * everything to init(): authFetch is called very early (FRFileMgmt.loadFileList
 * fires it before any FRAuth.init runs), and its 401 path calls showLoginOverlay.
 * So authToken AND the login overlay (+ showLoginOverlay) are set up at MODULE
 * FACTORY time, not gated on init(). Only the post-login callback (onLogin) waits
 * for init() — the WS/boot core stays in app.js, so doLogin reaches it via the
 * injected onLogin() callback instead of calling connectWs / loadFileList /
 * loadBroadcastState directly.
 *
 * app.js keeps the ~37 in-file authFetch() call-sites and the sibling
 * init({ authFetch }) passes unchanged via two aliases at the top of its IIFE
 * (var authFetch = window.FRAuth.authFetch; var showLoginOverlay =
 * window.FRAuth.showLoginOverlay;). The mutable authToken is read live via
 * window.FRAuth.getAuthToken() (connectWs + the FRFileMgmt.init getter).
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/auth.js"> (attaches its public API to window.FRAuth) AND required
 * by the vitest suite via module.exports (CJS). It deliberately uses NO top-level
 * `export`/`import` so a browser <script> can load it without a SyntaxError.
 */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.FRAuth = api;
  }
})(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Module-owned state (moved out of app.js). Seeded at FACTORY load, NOT init,
  // because authFetch runs before any FRAuth.init.
  // -------------------------------------------------------------------------
  // --- Auth ---
  var authToken = localStorage.getItem('s23_token') || '';

  // Injected host services (set by init). onLogin fires the app.js-resident
  // post-login side-effects (WS reconnect + data reload); default is a no-op so
  // a pre-init login cannot throw.
  var deps = {
    onLogin: function () {},
  };

  function authFetch(url, opts) {
    opts = opts || {};
    if (!opts.headers) {
      opts.headers = {};
    } else if (opts.headers instanceof Headers) {
      // convert Headers to plain object for easy merge
      var h = {};
      opts.headers.forEach(function(v, k) { h[k] = v; });
      opts.headers = h;
    }
    if (authToken) {
      opts.headers['Authorization'] = 'Bearer ' + authToken;
    }
    return fetch(url, opts).then(function(resp) {
      if (resp.status === 401) {
        showLoginOverlay();
        return Promise.reject(new Error('Unauthorized'));
      }
      return resp;
    });
  }

  // --- Login Overlay ---
  var loginOverlay = document.createElement('div');
  loginOverlay.id = 'login-overlay';
  loginOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:#0a0a0a;z-index:99999;display:flex;align-items:center;justify-content:center;';
  loginOverlay.innerHTML =
    '<div style="text-align:center;max-width:340px;width:100%;padding:20px;">' +
      '<div style="font-family:monospace;font-size:28px;color:#00ff41;margin-bottom:8px;letter-spacing:2px;">STUDIO 23</div>' +
      '<div style="font-family:monospace;font-size:12px;color:#555;margin-bottom:32px;">dashboard access</div>' +
      '<input id="login-token" type="password" placeholder="token" ' +
        'style="width:100%;box-sizing:border-box;padding:12px;background:#111;border:1px solid #333;color:#00ff41;font-family:monospace;font-size:14px;outline:none;margin-bottom:12px;border-radius:2px;" />' +
      '<button id="login-btn" ' +
        'style="width:100%;padding:12px;background:#00ff41;color:#0a0a0a;border:none;font-family:monospace;font-size:14px;font-weight:bold;cursor:pointer;border-radius:2px;">ENTER</button>' +
      '<div id="login-error" style="font-family:monospace;font-size:12px;color:#ff4141;margin-top:12px;min-height:16px;"></div>' +
    '</div>';
  document.body.appendChild(loginOverlay);

  var loginTokenInput = document.getElementById('login-token');
  var loginBtn = document.getElementById('login-btn');
  var loginError = document.getElementById('login-error');

  function showLoginOverlay() {
    authToken = '';
    localStorage.removeItem('s23_token');
    loginOverlay.style.display = 'flex';
    loginError.textContent = '';
    loginTokenInput.value = '';
    loginTokenInput.focus();
  }

  function hideLoginOverlay() {
    loginOverlay.style.display = 'none';
  }

  function doLogin() {
    var val = loginTokenInput.value.trim();
    if (!val) { loginError.textContent = 'enter token'; return; }
    loginBtn.disabled = true;
    loginError.textContent = '';
    fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: val })
    }).then(function(r) {
      if (r.ok) return r.json();
      throw new Error('bad token');
    }).then(function() {
      authToken = val;
      localStorage.setItem('s23_token', val);
      loginBtn.disabled = false;
      hideLoginOverlay();
      // Reconnect WebSocket + reload data (app.js-resident WS/boot core).
      deps.onLogin();
    }).catch(function() {
      loginError.textContent = 'invalid token';
      loginBtn.disabled = false;
    });
  }

  loginBtn.addEventListener('click', doLogin);
  loginTokenInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') doLogin();
  });

  // Initial auth check. Was an immediately-invoked named function expression in
  // app.js; now an exposed named function so app.js can call FRAuth.checkAuth()
  // in its wiring block to preserve the boot auth check.
  function checkAuth() {
    if (!authToken) { showLoginOverlay(); return; }
    fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: authToken })
    }).then(function(r) {
      if (r.ok) { hideLoginOverlay(); return; }
      showLoginOverlay();
    }).catch(function() {
      // Server unreachable — hide overlay (no auth configured or offline)
      hideLoginOverlay();
    });
  }

  /**
   * Store injected dependencies. Safe to call more than once (the vitest harness
   * re-inits per test with its own deps). The token + overlay are already live
   * (factory), so init only wires the post-login callback.
   */
  function init(injected) {
    injected = injected || {};
    for (var k in deps) {
      if (Object.prototype.hasOwnProperty.call(injected, k)) {
        deps[k] = injected[k];
      }
    }
  }

  return {
    init: init,
    authFetch: authFetch,
    showLoginOverlay: showLoginOverlay,
    hideLoginOverlay: hideLoginOverlay,
    doLogin: doLogin,
    checkAuth: checkAuth,
    getAuthToken: function () { return authToken; },
    setAuthToken: function (v) { authToken = v; },
  };
});
