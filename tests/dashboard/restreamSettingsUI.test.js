/**
 * tests/dashboard/restreamSettingsUI.test.js
 *
 * Characterization pins for the restream-settings autostart control (the single
 * #restream-autostart-checkbox in the Stream Platforms panel; NOT the WS-fed
 * restream-status widget). These pin the AS-IS observable contract of the
 * cluster currently living in the app.js IIFE (app.js:1361-1392):
 *   - var restreamAutoStartCheckbox = getElementById('restream-autostart-checkbox')
 *   - loadRestreamSettings()  GET /api/restream/settings -> .checked = !!data.autoStart
 *   - restreamAutoStartCheckbox.onchange  POST {autoStart: checkbox.checked}
 *
 * Authored in C1 against the unmodified app.js via the window.__appRestreamSettings
 * hook + REAL DOM (the onchange is bound at module-scope load). In C2 they will be
 * re-pointed to window.FRRestreamSettings with assertions UNCHANGED, proving the
 * extraction is behaviour-preserving.
 *
 * AS-IS quirks pinned here:
 *   - no `checked` HTML attribute -> initial unchecked (false).
 *   - load reads data.autoStart with !!coercion (missing/falsy -> false).
 *   - load error path uses log() (NO #error-banner).
 *   - onchange POST body is exactly { autoStart: <bool> } (single key).
 *   - the logged ON/OFF text is driven by RESPONSE data.autoStart, not the checkbox.
 *   - onchange success requires data.success truthy, else it throws
 *     (data.error||'save failed') -> showError #error-banner.
 *   - any save fetch reject -> showError #error-banner.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, flush, closeAllWindows } from './appBoot.js';

// Close every jsdom window this file booted (rationale in appBoot.js).
afterAll(closeAllWindows);

/** Boot a fresh window and grab the restream-settings hook. */
function boot() {
  const { win, doc } = bootWindow();
  const rs = win.FRRestreamSettings;
  return { win, doc, rs };
}

/** Install a recording fetch stub (replacing the never-resolving boot fetch). */
function withFetch(win, routes) {
  const stub = makeFetchStub(routes);
  win.fetch = stub.fetch;
  return stub;
}

/** The single autostart checkbox, driven via REAL DOM. */
function checkbox(doc) {
  return doc.getElementById('restream-autostart-checkbox');
}

describe('restream-settings UI characterization (window.FRRestreamSettings)', () => {
  it('exposes loadRestreamSettings + getAutoStart/setAutoStart', () => {
    const { rs } = boot();
    expect(rs).toBeTruthy();
    expect(typeof rs.loadRestreamSettings).toBe('function');
    expect(typeof rs.getAutoStart).toBe('function');
    expect(typeof rs.setAutoStart).toBe('function');
  });

  it('AS-IS: checkbox starts unchecked (no `checked` attribute in HTML)', () => {
    const { doc, rs } = boot();
    expect(checkbox(doc).checked).toBe(false);
    expect(rs.getAutoStart()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // loadRestreamSettings — GET /api/restream/settings -> .checked = !!autoStart
  // -------------------------------------------------------------------------
  describe('loadRestreamSettings', () => {
    it('GET /api/restream/settings, autoStart:true -> checkbox checked', async () => {
      const { win, doc, rs } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/restream/settings', { autoStart: true }),
      ]);
      rs.loadRestreamSettings();
      await flush();

      const get = stub.calls.find((c) => c.method === 'GET' && c.url === '/api/restream/settings');
      expect(get).toBeTruthy();
      expect(get.body).toBeUndefined();
      expect(checkbox(doc).checked).toBe(true);
      expect(rs.getAutoStart()).toBe(true);
    });

    it('AS-IS: autoStart missing/falsy -> !!coercion leaves checkbox unchecked', async () => {
      const { win, doc, rs } = boot();
      // pre-set checked to prove load actively writes false
      rs.setAutoStart(true);
      const stub = withFetch(win, [
        routeExact('GET', '/api/restream/settings', { autoStart: false }),
      ]);
      rs.loadRestreamSettings();
      await flush();
      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/restream/settings')).toBe(true);
      expect(checkbox(doc).checked).toBe(false);
    });

    it('AS-IS: load error path uses log() (no #error-banner)', async () => {
      const { win, doc, rs } = boot();
      win.fetch = () => Promise.reject(new Error('boom'));
      rs.loadRestreamSettings();
      await flush();
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // onchange — POST {autoStart: checkbox.checked}, driven via REAL DOM
  // -------------------------------------------------------------------------
  describe('checkbox.onchange', () => {
    it('checked=true -> POSTs { autoStart: true } (single key, no banner)', async () => {
      const { win, doc } = boot();
      const stub = withFetch(win, [
        routeExact('POST', '/api/restream/settings', { success: true, autoStart: true }),
      ]);
      const cb = checkbox(doc);
      cb.checked = true;
      cb.onchange();
      await flush();

      const post = stub.calls.find((c) => c.method === 'POST' && c.url === '/api/restream/settings');
      expect(post).toBeTruthy();
      expect(post.body).toEqual({ autoStart: true });
      expect(doc.getElementById('error-banner').classList.contains('visible')).toBe(false);
    });

    it('checked=false -> POSTs { autoStart: false } (no banner)', async () => {
      const { win, doc } = boot();
      const stub = withFetch(win, [
        routeExact('POST', '/api/restream/settings', { success: true, autoStart: false }),
      ]);
      const cb = checkbox(doc);
      cb.checked = false;
      cb.onchange();
      await flush();

      const post = stub.calls.find((c) => c.method === 'POST' && c.url === '/api/restream/settings');
      expect(post).toBeTruthy();
      expect(post.body).toEqual({ autoStart: false });
      expect(doc.getElementById('error-banner').classList.contains('visible')).toBe(false);
    });

    it('AS-IS: success:true -> no banner; ON/OFF log is driven by response.autoStart', async () => {
      // checkbox says false but response says autoStart:true -> still a success, no banner.
      const { win, doc } = boot();
      const stub = withFetch(win, [
        routeExact('POST', '/api/restream/settings', { success: true, autoStart: true }),
      ]);
      const cb = checkbox(doc);
      cb.checked = false;
      cb.onchange();
      await flush();

      const post = stub.calls.find((c) => c.method === 'POST' && c.url === '/api/restream/settings');
      expect(post.body).toEqual({ autoStart: false });
      expect(doc.getElementById('error-banner').classList.contains('visible')).toBe(false);
    });

    it('AS-IS: !data.success -> throws -> showError #error-banner', async () => {
      const { win, doc } = boot();
      withFetch(win, [
        routeExact('POST', '/api/restream/settings', { success: false, error: 'nope' }),
      ]);
      const cb = checkbox(doc);
      cb.checked = true;
      cb.onchange();
      await flush();

      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);
      expect(banner.textContent).toContain('Restream autostart save failed');
    });

    it('AS-IS: fetch reject on save -> showError #error-banner', async () => {
      const { win, doc } = boot();
      win.fetch = () => Promise.reject(new Error('down'));
      const cb = checkbox(doc);
      cb.checked = true;
      cb.onchange();
      await flush();

      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);
      expect(banner.textContent).toContain('Restream autostart save failed');
    });
  });
});
