/**
 * tests/dashboard/authUI.test.js
 *
 * Characterization pins for the auth/login cluster currently living inside the
 * app.js IIFE (dashboard/public/app.js:89-196): the authFetch wrapper, the login
 * overlay (showLoginOverlay / hideLoginOverlay), doLogin, and the authToken
 * state. These pins capture the AS-IS observable contract so the C2 extraction
 * into dashboard/public/auth.js (window.FRAuth) can be proven behaviourally
 * equivalent — at which point these same assertions are re-pointed from
 * window.__appAuth to window.FRAuth, UNCHANGED.
 *
 * In C1 the cluster is reached via the window.__appAuth test hook (guarded by
 * window.__APP_TEST__, added immediately after the checkAuth IIFE). The hook
 * exposes the four cluster fns plus get/setAuthToken accessors for the mutable
 * authToken state. The login overlay is a real <div id="login-overlay"> the app
 * builds at factory time and appends to document.body, so the real
 * #login-token / #login-btn / #login-error DOM is driven directly.
 *
 * Harness notes:
 *   - makeFetchStub ALWAYS returns { ok:true, status:200 }, so the 401 branch of
 *     authFetch and the !r.ok branch of doLogin CANNOT be driven through it; for
 *     those paths win.fetch is assigned directly (Promise.resolve({status:401})
 *     / { ok:false }), exactly as visualProfilesUI.test.js does for its error
 *     paths.
 *   - makeFetchStub records { method, url, body } only — NOT headers. So the
 *     Authorization-header pins assign win.fetch to a capturing function instead.
 *   - authToken is sourced at IIFE top-level from localStorage.getItem('s23_token')
 *     (factory-equivalent, not gated on init). The harness boots with empty
 *     localStorage, so the boot checkAuth takes the !authToken branch ->
 *     showLoginOverlay (overlay display 'flex', no /api/auth/verify fetch). The
 *     "stored token -> Bearer" path is the SAME authToken var, here driven via
 *     the setAuthToken accessor; doLogin pins the localStorage write itself.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, flush, closeAllWindows } from './appBoot.js';

// Close every jsdom window this file booted (rationale in appBoot.js).
afterAll(closeAllWindows);

/** Boot a fresh window and grab the auth module + document. */
function boot() {
  const { win, doc } = bootWindow();
  return { win, doc, auth: win.FRAuth };
}

/** Install a recording fetch stub (replacing the never-resolving boot fetch). */
function withFetch(win, routes) {
  const stub = makeFetchStub(routes);
  win.fetch = stub.fetch;
  return stub;
}

describe('auth UI characterization (window.FRAuth)', () => {
  it('exposes the cluster fns + authToken accessors', () => {
    const { auth } = boot();
    expect(auth).toBeTruthy();
    for (const fn of ['authFetch', 'showLoginOverlay', 'hideLoginOverlay', 'doLogin',
      'getAuthToken', 'setAuthToken']) {
      expect(typeof auth[fn]).toBe('function');
    }
  });

  // -------------------------------------------------------------------------
  // checkAuth boot behaviour (observable overlay state only — checkAuth is a
  // named function expression and is NOT exposed on the hook)
  // -------------------------------------------------------------------------
  describe('checkAuth boot', () => {
    it('empty localStorage -> overlay shown (display flex), no token', () => {
      const { doc, auth } = boot();
      // boot ran checkAuth with no stored token -> showLoginOverlay()
      expect(doc.getElementById('login-overlay').style.display).toBe('flex');
      expect(auth.getAuthToken()).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // authFetch — Authorization header injection (capturing fetch, not the stub)
  // -------------------------------------------------------------------------
  describe('authFetch header injection', () => {
    it('token set -> injects exactly "Bearer <token>"', async () => {
      const { win, auth } = boot();
      let captured;
      win.fetch = (url, opts) => { captured = opts; return Promise.resolve({ status: 200 }); };
      auth.setAuthToken('abc123');
      await auth.authFetch('/api/status');
      expect(captured.headers['Authorization']).toBe('Bearer abc123');
    });

    it('token unset -> NO Authorization header', async () => {
      const { win, auth } = boot();
      let captured;
      win.fetch = (url, opts) => { captured = opts; return Promise.resolve({ status: 200 }); };
      // boot left authToken '' (empty localStorage)
      expect(auth.getAuthToken()).toBe('');
      await auth.authFetch('/api/status');
      expect('Authorization' in captured.headers).toBe(false);
    });

    it('Headers instance is flattened to a plain object (Authorization still added)', async () => {
      const { win, auth } = boot();
      let captured;
      win.fetch = (url, opts) => { captured = opts; return Promise.resolve({ status: 200 }); };
      auth.setAuthToken('tok');
      await auth.authFetch('/api/status', { headers: new win.Headers({ 'X-Custom': 'v' }) });
      expect(captured.headers instanceof win.Headers).toBe(false);
      // jsdom Headers lowercases keys on forEach copy
      expect(captured.headers['x-custom']).toBe('v');
      expect(captured.headers['Authorization']).toBe('Bearer tok');
    });

    it('non-401 response passes through unchanged', async () => {
      const { win, auth } = boot();
      const resp = { status: 200, marker: true };
      win.fetch = () => Promise.resolve(resp);
      const out = await auth.authFetch('/api/status');
      expect(out).toBe(resp);
      expect(out.marker).toBe(true);
    });

    it('401 response -> showLoginOverlay + reject(Error "Unauthorized") + wipes token', async () => {
      const { win, doc, auth } = boot();
      win.fetch = () => Promise.resolve({ status: 401 });
      auth.setAuthToken('willbewiped');
      win.localStorage.setItem('s23_token', 'willbewiped');

      await expect(auth.authFetch('/api/status')).rejects.toThrow('Unauthorized');

      // showLoginOverlay side effects: overlay shown + token + storage wiped
      expect(doc.getElementById('login-overlay').style.display).toBe('flex');
      expect(auth.getAuthToken()).toBe('');
      expect(win.localStorage.getItem('s23_token')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // showLoginOverlay / hideLoginOverlay
  // -------------------------------------------------------------------------
  describe('overlay toggles', () => {
    it('showLoginOverlay clears token+storage, shows overlay, blanks error/input', () => {
      const { win, doc, auth } = boot();
      auth.setAuthToken('zzz');
      win.localStorage.setItem('s23_token', 'zzz');
      const overlay = doc.getElementById('login-overlay');
      const tokenInput = doc.getElementById('login-token');
      const errorEl = doc.getElementById('login-error');
      tokenInput.value = 'typed';
      errorEl.textContent = 'old error';

      auth.showLoginOverlay();

      expect(auth.getAuthToken()).toBe('');
      expect(win.localStorage.getItem('s23_token')).toBeNull();
      expect(overlay.style.display).toBe('flex');
      expect(errorEl.textContent).toBe('');
      expect(tokenInput.value).toBe('');
    });

    it('hideLoginOverlay sets overlay display none', () => {
      const { doc, auth } = boot();
      auth.hideLoginOverlay();
      expect(doc.getElementById('login-overlay').style.display).toBe('none');
    });
  });

  // -------------------------------------------------------------------------
  // doLogin
  // -------------------------------------------------------------------------
  describe('doLogin', () => {
    it('empty token -> "enter token", early return, NO POST', async () => {
      const { win, doc, auth } = boot();
      const stub = withFetch(win, [routeExact('POST', '/api/auth/verify', {})]);
      doc.getElementById('login-token').value = '   '; // trims to empty
      auth.doLogin();
      await flush();
      expect(doc.getElementById('login-error').textContent).toBe('enter token');
      expect(stub.calls.some((c) => c.url === '/api/auth/verify')).toBe(false);
    });

    it('success -> POST {token}, stores token + storage, hides overlay, re-enables button', async () => {
      const { win, doc, auth } = boot();
      const stub = withFetch(win, [routeExact('POST', '/api/auth/verify', {})]);
      const btn = doc.getElementById('login-btn');
      doc.getElementById('login-token').value = 'goodtok';

      auth.doLogin();
      await flush();

      const post = stub.calls.find((c) => c.method === 'POST' && c.url === '/api/auth/verify');
      expect(post).toBeTruthy();
      expect(post.body).toEqual({ token: 'goodtok' });
      expect(auth.getAuthToken()).toBe('goodtok');
      expect(win.localStorage.getItem('s23_token')).toBe('goodtok');
      expect(doc.getElementById('login-overlay').style.display).toBe('none');
      expect(btn.disabled).toBe(false);
    });

    it('success -> fires onLogin side-effects: WS reconnect + data reload (status/music/visuals)', async () => {
      // The post-login callbacks (connectWs + FRFileMgmt.loadFileList music/visuals
      // + loadBroadcastState) are app.js-resident and will be injected into FRAuth
      // as the onLogin callback in C2. This pin locks that they actually FIRE on
      // success — observed behaviourally (a fresh WebSocket is built, and the three
      // data-reload GETs hit fetch) so it re-points to window.FRAuth UNCHANGED and a
      // no-op onLogin in C2 cannot pass undetected.
      const { win, doc, auth } = boot();
      // Spy WebSocket construction (connectWs builds a fresh socket on login).
      let wsBuilt = 0;
      const BootWS = win.WebSocket;
      win.WebSocket = class extends BootWS {
        constructor(url) { super(url); wsBuilt++; }
      };
      const stub = withFetch(win, [routeExact('POST', '/api/auth/verify', {})]);
      doc.getElementById('login-token').value = 'goodtok';

      auth.doLogin();
      await flush();

      // connectWs() ran -> a new socket was constructed after the spy was installed.
      expect(wsBuilt).toBeGreaterThan(0);
      // Post-login data reload fired through authFetch (GET, default method).
      const gotGet = (p) => stub.calls.some((c) => c.method === 'GET' && c.url === p);
      expect(gotGet('/api/status')).toBe(true);   // loadBroadcastState
      expect(gotGet('/api/music')).toBe(true);     // FRFileMgmt.loadFileList('music')
      expect(gotGet('/api/visuals')).toBe(true);   // FRFileMgmt.loadFileList('visuals')
    });

    it('real #login-btn click drives doLogin (event binding)', async () => {
      const { win, doc, auth } = boot();
      withFetch(win, [routeExact('POST', '/api/auth/verify', {})]);
      doc.getElementById('login-token').value = 'viaclick';
      doc.getElementById('login-btn').click();
      await flush();
      expect(auth.getAuthToken()).toBe('viaclick');
      expect(win.localStorage.getItem('s23_token')).toBe('viaclick');
    });

    it('failure (!ok) -> "invalid token", button re-enabled, token NOT stored', async () => {
      const { win, doc, auth } = boot();
      // makeFetchStub can only return ok:true; drive the !ok branch directly.
      win.fetch = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
      const btn = doc.getElementById('login-btn');
      doc.getElementById('login-token').value = 'badtok';

      auth.doLogin();
      await flush();

      expect(doc.getElementById('login-error').textContent).toBe('invalid token');
      expect(btn.disabled).toBe(false);
      expect(auth.getAuthToken()).toBe('');
      expect(win.localStorage.getItem('s23_token')).toBeNull();
    });
  });
});
