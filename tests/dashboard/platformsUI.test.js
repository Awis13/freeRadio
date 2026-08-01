/**
 * tests/dashboard/platformsUI.test.js
 *
 * Characterization pins for the STREAM PLATFORMS / stream-keys UI domain, while it
 * still lives inside the app.js IIFE (app.js:1518-1689). These tests pin the AS-IS
 * observable contract BEFORE the C2 extraction into dashboard/public/platforms.js.
 *
 * The domain is reached two ways:
 *   - window.__appPlatforms  — the C1 test-only hook (sibling of __appDrift), holding
 *     the REAL closure fns (loadPlatforms/renderPlatforms/deletePlatform/togglePlatform/
 *     syncPlatformHints/uniquePlatformName/applyPreset) + getters/setters for the closure
 *     state (currentPlatformNames, maxPlatforms).
 *   - window.savePlatform / window.closePlatformModal — REAL window globals (driven in
 *     production via inline onclick in index.html). NOT on the hook; driven off `win`.
 *
 * The domain uses the REAL deps (authFetch -> win.fetch, log, showError, alert, confirm,
 * FRUtils.uniquePlatformName). The only backend control is replacing the boot's
 * never-resolving win.fetch with a recording makeFetchStub AFTER boot, then driving the
 * fns and asserting DOM (in `doc`) + recorded fetches (stub.calls).
 *
 * AS-IS quirks pinned here (flagged for the C2 extraction):
 *   - loadPlatforms does Object.keys(data.platforms) with NO guard: a response missing
 *     `platforms` throws -> .catch log() (NO #error-banner). Success needs {platforms:{...}}.
 *   - togglePlatform expects {success:true} in the PATCH response; anything else throws
 *     'toggle failed' -> showError, NOT loadPlatforms.
 *   - savePlatform validation calls alert() (not a silent early-return) and returns after
 *     the FIRST empty field, order: name, rtmpUrl, key.
 *   - applyPreset('kick') leaves the RTMP URL EDITABLE (preset.rtmpUrl === '' -> urlEditable);
 *     youtube/twitch/facebook LOCK it (readOnly + opacity '.7').
 *   - addPlatformBtn.onclick forces preset 'youtube' -> name = uniquePlatformName('YouTube'),
 *     which depends on currentPlatformNames at that moment (collision suffixes).
 *   - platform-del button textContent is the '×' (×) char.
 *   - URL paths use encodeURIComponent(name): 'YouTube 2' -> 'YouTube%202'.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, flush, closeAllWindows } from './appBoot.js';

// Close every jsdom window this file booted (rationale in appBoot.js).
afterAll(closeAllWindows);

/**
 * Boot a fresh window and grab the platforms hook. No init/deps to inject — the
 * hook fns are the real closure fns; tests control only win.fetch (+ alert/confirm).
 */
function boot() {
  const { win, doc } = bootWindow();
  const hook = win.FRPlatforms;
  return { win, doc, hook };
}

/** Install a recording fetch stub (replacing the never-resolving boot fetch). */
function withFetch(win, routes) {
  const stub = makeFetchStub(routes);
  win.fetch = stub.fetch;
  return stub;
}

describe('platforms / stream-keys UI characterization (window.FRPlatforms)', () => {
  it('exposes the domain fns + state getters/setters; save/close are window globals', () => {
    const { win, hook } = boot();
    expect(hook).toBeTruthy();
    for (const fn of [
      'loadPlatforms', 'renderPlatforms', 'deletePlatform', 'togglePlatform',
      'syncPlatformHints', 'uniquePlatformName', 'applyPreset',
      'getCurrentPlatformNames', 'setCurrentPlatformNames', 'getMaxPlatforms',
    ]) {
      expect(typeof hook[fn]).toBe('function');
    }
    // window globals (driven via inline onclick in index.html) are NOT on the hook
    expect(typeof win.savePlatform).toBe('function');
    expect(typeof win.closePlatformModal).toBe('function');
    expect(hook.savePlatform).toBeUndefined();
    expect(hook.closePlatformModal).toBeUndefined();
    // defaults
    expect(hook.getMaxPlatforms()).toBe(3);
    expect(hook.getCurrentPlatformNames()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // loadPlatforms -> renderPlatforms + currentPlatformNames
  // -------------------------------------------------------------------------
  describe('loadPlatforms', () => {
    it('GET /api/stream-keys -> renders a row per platform, sets names + maxPlatforms', async () => {
      const { win, doc, hook } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/stream-keys', {
          maxPlatforms: 5,
          platforms: {
            YouTube: { enabled: true },
            Kick: { enabled: false },
          },
        }),
      ]);
      hook.loadPlatforms();
      await flush();

      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/stream-keys')).toBe(true);

      const rows = doc.getElementById('platform-list').querySelectorAll('.platform-item');
      expect(rows.length).toBe(2);
      // names captured from Object.keys(data.platforms)
      expect(hook.getCurrentPlatformNames()).toEqual(['YouTube', 'Kick']);
      // maxPlatforms taken from the payload
      expect(hook.getMaxPlatforms()).toBe(5);

      // enabled row: ' enabled' class, 'ON' status, 'Disable' toggle
      expect(rows[0].className).toBe('platform-item enabled');
      expect(rows[0].querySelector('.platform-name').textContent).toBe('YouTube');
      expect(rows[0].querySelector('.platform-status').textContent).toBe('ON');
      expect(rows[0].querySelector('.platform-toggle').textContent).toBe('Disable');
      expect(rows[0].querySelector('.platform-toggle').className).toBe('platform-toggle on');
      // disabled row: no ' enabled', 'OFF', 'Enable'
      expect(rows[1].className).toBe('platform-item');
      expect(rows[1].querySelector('.platform-status').textContent).toBe('OFF');
      expect(rows[1].querySelector('.platform-toggle').textContent).toBe('Enable');
      expect(rows[1].querySelector('.platform-toggle').className).toBe('platform-toggle off');
      // delete button is the × char
      expect(rows[0].querySelector('.platform-del').textContent).toBe('×');
    });

    it('AS-IS: maxPlatforms falsy in payload -> falls back to 3', async () => {
      const { win, hook } = boot();
      withFetch(win, [routeExact('GET', '/api/stream-keys', { platforms: {} })]);
      hook.loadPlatforms();
      await flush();
      expect(hook.getMaxPlatforms()).toBe(3);
    });

    it('AS-IS: response missing `platforms` -> Object.keys throws -> .catch log() (no #error-banner)', async () => {
      const { win, doc, hook } = boot();
      withFetch(win, [routeExact('GET', '/api/stream-keys', { maxPlatforms: 4 })]);
      hook.loadPlatforms();
      await flush();
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // renderPlatforms — driven directly
  // -------------------------------------------------------------------------
  describe('renderPlatforms', () => {
    it('empty object -> no rows; add button enabled (0 < maxPlatforms)', () => {
      const { doc, hook } = boot();
      hook.renderPlatforms({});
      const list = doc.getElementById('platform-list');
      expect(list.querySelectorAll('.platform-item').length).toBe(0);
      const btn = doc.getElementById('add-platform-btn');
      expect(btn.disabled).toBe(false);
      expect(btn.title).toBe('');
    });

    it('AS-IS: entries.length >= maxPlatforms -> add button disabled + limit title', () => {
      const { doc, hook } = boot();
      // default maxPlatforms is 3; render exactly 3 -> at limit
      hook.renderPlatforms({ A: { enabled: true }, B: { enabled: false }, C: { enabled: true } });
      const btn = doc.getElementById('add-platform-btn');
      expect(doc.getElementById('platform-list').querySelectorAll('.platform-item').length).toBe(3);
      expect(btn.disabled).toBe(true);
      expect(btn.title).toBe('Limit: max 3 platforms');
    });

    it('toggle button onclick routes through togglePlatform(name, !enabled)', async () => {
      const { win, doc, hook } = boot();
      const stub = withFetch(win, [
        routeExact('PATCH', '/api/stream-keys/YouTube/enabled', { success: true }),
        routeExact('GET', '/api/stream-keys', { maxPlatforms: 3, platforms: {} }),
      ]);
      hook.renderPlatforms({ YouTube: { enabled: false } });
      // enabled:false -> toggle fires togglePlatform('YouTube', true)
      doc.getElementById('platform-list').querySelector('.platform-toggle').onclick();
      await flush();
      const patch = stub.calls.find((c) => c.method === 'PATCH');
      expect(patch.url).toBe('/api/stream-keys/YouTube/enabled');
      expect(patch.body).toEqual({ enabled: true });
    });

    it('delete button onclick routes through deletePlatform(name) (confirm gated)', async () => {
      const { win, doc, hook } = boot();
      win.confirm = () => true;
      const stub = withFetch(win, [
        routeExact('DELETE', '/api/stream-keys/Kick', {}),
        routeExact('GET', '/api/stream-keys', { maxPlatforms: 3, platforms: {} }),
      ]);
      hook.renderPlatforms({ Kick: { enabled: false } });
      doc.getElementById('platform-list').querySelector('.platform-del').onclick();
      await flush();
      expect(stub.calls.some((c) => c.method === 'DELETE' && c.url === '/api/stream-keys/Kick')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // deletePlatform — confirm gating + DELETE + reload
  // -------------------------------------------------------------------------
  describe('deletePlatform', () => {
    it('confirm=true -> DELETE <enc(name)> then reloads (GET)', async () => {
      const { win, hook } = boot();
      win.confirm = () => true;
      const stub = withFetch(win, [
        routeExact('DELETE', '/api/stream-keys/My%20Stream', {}),
        routeExact('GET', '/api/stream-keys', { maxPlatforms: 3, platforms: {} }),
      ]);
      hook.deletePlatform('My Stream');
      await flush();
      // name is encodeURIComponent'd in the path
      expect(stub.calls.some((c) => c.method === 'DELETE' && c.url === '/api/stream-keys/My%20Stream')).toBe(true);
      // success reloads the list
      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/stream-keys')).toBe(true);
    });

    it('confirm=false -> no DELETE fired', async () => {
      const { win, hook } = boot();
      win.confirm = () => false;
      const stub = withFetch(win, [routeExact('DELETE', '/api/stream-keys/X', {})]);
      hook.deletePlatform('X');
      await flush();
      expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(false);
    });

    it('AS-IS: delete error -> showError writes #error-banner', async () => {
      const { win, doc, hook } = boot();
      win.confirm = () => true;
      win.fetch = () => Promise.reject(new Error('boom'));
      hook.deletePlatform('X');
      await flush();
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);
      expect(banner.textContent).toContain('Remove failed');
    });
  });

  // -------------------------------------------------------------------------
  // togglePlatform — PATCH .../enabled, {success:true} contract
  // -------------------------------------------------------------------------
  describe('togglePlatform', () => {
    it('PATCH <enc(name)>/enabled with {enabled} body; {success:true} -> reload', async () => {
      const { win, hook } = boot();
      const stub = withFetch(win, [
        routeExact('PATCH', '/api/stream-keys/Twitch/enabled', { success: true }),
        routeExact('GET', '/api/stream-keys', { maxPlatforms: 3, platforms: {} }),
      ]);
      hook.togglePlatform('Twitch', false);
      await flush();
      const patch = stub.calls.find((c) => c.method === 'PATCH' && c.url === '/api/stream-keys/Twitch/enabled');
      expect(patch).toBeTruthy();
      expect(patch.body).toEqual({ enabled: false });
      // success reloads
      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/stream-keys')).toBe(true);
    });

    it('AS-IS: response without success:true -> throws "toggle failed", showError, NO reload', async () => {
      const { win, doc, hook } = boot();
      const stub = withFetch(win, [
        // bare {} -> data.success undefined -> throws
        routeExact('PATCH', '/api/stream-keys/Twitch/enabled', {}),
        routeExact('GET', '/api/stream-keys', { maxPlatforms: 3, platforms: {} }),
      ]);
      hook.togglePlatform('Twitch', true);
      await flush();
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);
      expect(banner.textContent).toContain('Platform toggle failed');
      // did NOT reload
      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/stream-keys')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // syncPlatformHints — placeholder + help text per current name
  // -------------------------------------------------------------------------
  describe('syncPlatformHints', () => {
    it('name "kick" (case-insensitive) -> kick-specific placeholder + help', () => {
      const { doc, hook } = boot();
      doc.getElementById('platform-name-input').value = 'KiCk';
      hook.syncPlatformHints();
      expect(doc.getElementById('rtmp-url-input').placeholder)
        .toBe('rtmps://<ingest>.global-contribute.live-video.net/app');
      expect(doc.getElementById('rtmp-help').textContent)
        .toBe('Kick: server URL from Creator Dashboard, stream key separately.');
    });

    it('any other name -> generic placeholder + help', () => {
      const { doc, hook } = boot();
      doc.getElementById('platform-name-input').value = 'YouTube';
      hook.syncPlatformHints();
      expect(doc.getElementById('rtmp-url-input').placeholder).toBe('rtmp://... or rtmps://...');
      expect(doc.getElementById('rtmp-help').textContent)
        .toBe('Use server URL; stream key is stored separately.');
    });
  });

  // -------------------------------------------------------------------------
  // uniquePlatformName — dedup against currentPlatformNames
  // -------------------------------------------------------------------------
  describe('uniquePlatformName', () => {
    it('no collision -> base unchanged; collisions -> "base 2", "base 3"...', () => {
      const { hook } = boot();
      expect(hook.uniquePlatformName('YouTube')).toBe('YouTube');
      hook.setCurrentPlatformNames(['YouTube']);
      expect(hook.uniquePlatformName('YouTube')).toBe('YouTube 2');
      hook.setCurrentPlatformNames(['YouTube', 'YouTube 2']);
      expect(hook.uniquePlatformName('YouTube')).toBe('YouTube 3');
    });
  });

  // -------------------------------------------------------------------------
  // applyPreset — per-preset name/url/readOnly/opacity matrix
  // -------------------------------------------------------------------------
  describe('applyPreset', () => {
    it('youtube -> name=YouTube, url filled + LOCKED (readOnly, opacity .7)', () => {
      const { doc, hook } = boot();
      hook.applyPreset('youtube');
      const nameInput = doc.getElementById('platform-name-input');
      const urlInput = doc.getElementById('rtmp-url-input');
      expect(nameInput.value).toBe('YouTube');
      expect(urlInput.value).toBe('rtmp://a.rtmp.youtube.com/live2');
      expect(nameInput.readOnly).toBe(true);
      expect(urlInput.readOnly).toBe(true);
      expect(nameInput.style.opacity).toBe('0.7');
      expect(urlInput.style.opacity).toBe('0.7');
    });

    it('AS-IS: kick -> url is "" and EDITABLE (preset.rtmpUrl falsy -> urlEditable)', () => {
      const { doc, hook } = boot();
      hook.applyPreset('kick');
      const nameInput = doc.getElementById('platform-name-input');
      const urlInput = doc.getElementById('rtmp-url-input');
      expect(nameInput.value).toBe('Kick');
      expect(urlInput.value).toBe('');
      // name still locked (not custom), url EDITABLE
      expect(nameInput.readOnly).toBe(true);
      expect(urlInput.readOnly).toBe(false);
      expect(urlInput.style.opacity).toBe('');
    });

    it('custom -> both empty + editable + opacity cleared', () => {
      const { doc, hook } = boot();
      hook.applyPreset('custom');
      const nameInput = doc.getElementById('platform-name-input');
      const urlInput = doc.getElementById('rtmp-url-input');
      expect(nameInput.value).toBe('');
      expect(urlInput.value).toBe('');
      expect(nameInput.readOnly).toBe(false);
      expect(urlInput.readOnly).toBe(false);
      expect(nameInput.style.opacity).toBe('');
      expect(urlInput.style.opacity).toBe('');
    });

    it('AS-IS: unknown preset key -> no-op (inputs untouched)', () => {
      const { doc, hook } = boot();
      const nameInput = doc.getElementById('platform-name-input');
      nameInput.value = 'PREEXISTING';
      hook.applyPreset('nope');
      expect(nameInput.value).toBe('PREEXISTING');
    });

    it('preset name collides with existing -> uniquePlatformName suffix applied', () => {
      const { doc, hook } = boot();
      hook.setCurrentPlatformNames(['YouTube']);
      hook.applyPreset('youtube');
      expect(doc.getElementById('platform-name-input').value).toBe('YouTube 2');
    });
  });

  // -------------------------------------------------------------------------
  // add-platform-btn open flow -> savePlatform (window global) -> POST + reload
  // -------------------------------------------------------------------------
  describe('add modal + savePlatform (window globals)', () => {
    it('add button opens modal, forces youtube preset, name = uniquePlatformName(YouTube)', () => {
      const { win, doc, hook } = boot();
      win.fetch = () => new Promise(() => {});
      // pre-seed a collision so the forced youtube preset suffixes the name
      hook.setCurrentPlatformNames(['YouTube']);
      doc.getElementById('add-platform-btn').onclick();
      expect(doc.getElementById('platform-modal').style.display).toBe('flex');
      expect(doc.getElementById('platform-preset-select').value).toBe('youtube');
      expect(doc.getElementById('platform-enabled').checked).toBe(true);
      expect(doc.getElementById('stream-key-input').value).toBe('');
      // forced applyPreset('youtube') -> name deduped against currentPlatformNames
      expect(doc.getElementById('platform-name-input').value).toBe('YouTube 2');
    });

    it('savePlatform POSTs {enabled, streamKey, rtmpUrl} to <enc(name)>, closes + reloads', async () => {
      const { win, doc, hook } = boot();
      const stub = withFetch(win, [
        routeExact('POST', '/api/stream-keys/My%20Stream', { ok: true }),
        routeExact('GET', '/api/stream-keys', { maxPlatforms: 3, platforms: {} }),
      ]);
      doc.getElementById('platform-name-input').value = 'My Stream';
      doc.getElementById('rtmp-url-input').value = 'rtmp://x/app';
      doc.getElementById('stream-key-input').value = 'sk_123';
      doc.getElementById('platform-enabled').checked = true;
      // make sure the modal looks open so we can pin the close
      doc.getElementById('platform-modal').style.display = 'flex';

      win.savePlatform();
      await flush();

      const post = stub.calls.find((c) => c.method === 'POST' && c.url === '/api/stream-keys/My%20Stream');
      expect(post).toBeTruthy();
      expect(post.body).toEqual({ enabled: true, streamKey: 'sk_123', rtmpUrl: 'rtmp://x/app' });
      // happy path closes the modal and reloads
      expect(doc.getElementById('platform-modal').style.display).toBe('none');
      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/stream-keys')).toBe(true);
    });

    it('AS-IS: validation alerts + returns on first empty field (order name, rtmpUrl, key)', () => {
      const { win, doc, hook } = boot();
      const alerts = [];
      win.alert = (m) => alerts.push(m);
      const stub = withFetch(win, [routeExact('POST', '/api/stream-keys/x', {})]);

      // 1) empty name -> 'Please enter platform name'
      doc.getElementById('platform-name-input').value = '   ';
      doc.getElementById('rtmp-url-input').value = 'rtmp://x';
      doc.getElementById('stream-key-input').value = 'k';
      win.savePlatform();

      // 2) name ok, empty rtmpUrl -> 'Please enter RTMP URL'
      doc.getElementById('platform-name-input').value = 'A';
      doc.getElementById('rtmp-url-input').value = '';
      win.savePlatform();

      // 3) name+url ok, empty key -> 'Please enter stream key'
      doc.getElementById('rtmp-url-input').value = 'rtmp://x';
      doc.getElementById('stream-key-input').value = '  ';
      win.savePlatform();

      expect(alerts).toEqual([
        'Please enter platform name',
        'Please enter RTMP URL',
        'Please enter stream key',
      ]);
      // no POST fired for any invalid attempt
      expect(stub.calls.some((c) => c.method === 'POST')).toBe(false);
    });

    it('AS-IS: !r.ok branch (custom fetch) -> showError "Save failed", no reload, modal stays', async () => {
      const { win, doc } = boot();
      // the recording stub always returns ok:true; use a custom fetch for the error branch
      win.fetch = () => Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'duplicate' }),
      });
      doc.getElementById('platform-name-input').value = 'Dup';
      doc.getElementById('rtmp-url-input').value = 'rtmp://x';
      doc.getElementById('stream-key-input').value = 'k';
      doc.getElementById('platform-modal').style.display = 'flex';

      win.savePlatform();
      await flush();

      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);
      expect(banner.textContent).toContain('Save failed');
      // modal NOT closed on the error path
      expect(doc.getElementById('platform-modal').style.display).toBe('flex');
    });
  });

  // -------------------------------------------------------------------------
  // closePlatformModal (window global)
  // -------------------------------------------------------------------------
  describe('closePlatformModal (window global)', () => {
    it('hides #platform-modal', () => {
      const { win, doc } = boot();
      doc.getElementById('platform-modal').style.display = 'flex';
      win.closePlatformModal();
      expect(doc.getElementById('platform-modal').style.display).toBe('none');
    });
  });
});
