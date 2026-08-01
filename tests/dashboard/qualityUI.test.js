/**
 * tests/dashboard/qualityUI.test.js
 *
 * Characterization pins for the quality-settings UI cluster in the app.js IIFE.
 * These pin the AS-IS observable contract of the quality domain before it is
 * extracted (C2) into dashboard/public/quality.js (window.FRQuality). They are
 * authored (C1) against the code in app.js via the window.__appQuality hook and
 * the REAL #quality-select DOM element, and will be re-pointed in C2 to the
 * extracted module with assertions UNCHANGED to prove behavioural equivalence.
 *
 * This domain has NO init/dependency-injection surface at C1: window.__appQuality
 * holds the REAL loadQuality fn, which uses the REAL deps (authFetch -> win.fetch,
 * log, showError). The onchange handler is bound on the REAL #quality-select
 * element during boot, so it is driven via doc.getElementById('quality-select')
 * .onchange(). The only "state" is qualitySelect.value, DOM-observable via doc.
 * The only backend control is replacing the boot's never-resolving win.fetch with
 * a recording makeFetchStub AFTER boot (or a rejecting fetch for the error paths).
 *
 * Cluster pinned (current app.js lines ~2147-2176):
 *   - loadQuality()        GET /api/quality -> sets #quality-select.value to
 *                          data.current.preset (guarded), log() only.
 *   - #quality-select.onchange  POST /api/quality body {preset} -> log() on
 *                          data.success (deref data.settings.name inside guard),
 *                          showError() on reject.
 *
 * AS-IS quirks pinned here (flagged for the C2 extraction):
 *   - loadQuality only sets value when `data.current && data.current.preset`
 *     truthy; a missing/falsy preset leaves value UNCHANGED with no throw.
 *   - loadQuality's error path uses log() (NO #error-banner).
 *   - onchange only logs 'changed' when `data.success` truthy (and only then
 *     dereferences data.settings.name); a false/absent success is a silent no-op.
 *   - onchange's error path uses showError() (#error-banner .visible).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, flush, closeAllWindows } from './appBoot.js';

// Close every jsdom window this file booted (rationale in appBoot.js).
afterAll(closeAllWindows);

/**
 * Boot a fresh window and grab the quality hook. No init/deps to inject — the
 * hook fn is the real closure fn; the onchange is bound on the real DOM element.
 */
function boot() {
  const { win, doc } = bootWindow();
  const q = win.FRQuality;
  return { win, doc, q };
}

/** Install a recording fetch stub (replacing the never-resolving boot fetch). */
function withFetch(win, routes) {
  const stub = makeFetchStub(routes);
  win.fetch = stub.fetch;
  return stub;
}

describe('quality-settings UI characterization (window.FRQuality)', () => {
  it('exposes loadQuality', () => {
    const { q } = boot();
    expect(q).toBeTruthy();
    expect(typeof q.loadQuality).toBe('function');
  });

  // -------------------------------------------------------------------------
  // loadQuality
  // -------------------------------------------------------------------------
  describe('loadQuality', () => {
    it('GET /api/quality (no body) -> sets #quality-select.value to data.current.preset', async () => {
      const { win, doc, q } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/quality', { current: { preset: 'ultra' } }),
      ]);
      q.loadQuality();
      await flush();

      const get = stub.calls.find((c) => c.method === 'GET' && c.url === '/api/quality');
      expect(get).toBeTruthy();
      expect(get.body).toBeUndefined();
      expect(doc.getElementById('quality-select').value).toBe('ultra');
      // log() only — no #error-banner
      expect(doc.getElementById('error-banner').classList.contains('visible')).toBe(false);
    });

    it('AS-IS: data.current missing -> value UNCHANGED, no throw', async () => {
      const { win, doc, q } = boot();
      const before = doc.getElementById('quality-select').value;
      withFetch(win, [routeExact('GET', '/api/quality', {})]);
      q.loadQuality();
      await flush();
      expect(doc.getElementById('quality-select').value).toBe(before);
    });

    it('AS-IS: data.current.preset falsy -> value UNCHANGED, no throw', async () => {
      const { win, doc, q } = boot();
      const before = doc.getElementById('quality-select').value;
      withFetch(win, [routeExact('GET', '/api/quality', { current: { preset: '' } })]);
      q.loadQuality();
      await flush();
      expect(doc.getElementById('quality-select').value).toBe(before);
    });

    it('AS-IS: load error path uses log() (no #error-banner)', async () => {
      const { win, doc, q } = boot();
      // fetch rejects -> the .catch uses log(), which writes no DOM banner
      win.fetch = () => Promise.reject(new Error('boom'));
      q.loadQuality();
      await flush();
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // #quality-select.onchange — driven on the REAL DOM element
  // -------------------------------------------------------------------------
  describe('#quality-select.onchange', () => {
    it('POSTs exactly one /api/quality with body {preset} + Content-Type json; success -> log only, no DOM mutation', async () => {
      const { win, doc, q } = boot();
      // ensure loadQuality is part of the hook (cluster sanity)
      expect(typeof q.loadQuality).toBe('function');
      const stub = withFetch(win, [
        routeExact('POST', '/api/quality', { success: true, settings: { name: 'Low' } }),
      ]);
      const sel = doc.getElementById('quality-select');
      sel.value = 'low';
      sel.onchange();
      await flush();

      const posts = stub.calls.filter((c) => c.method === 'POST' && c.url === '/api/quality');
      expect(posts.length).toBe(1);
      expect(posts[0].body).toEqual({ preset: 'low' });
      // value untouched by the handler
      expect(sel.value).toBe('low');
      // no banner on the success path
      expect(doc.getElementById('error-banner').classList.contains('visible')).toBe(false);
    });

    it('sends Content-Type application/json header', async () => {
      const { win, doc } = boot();
      const headers = [];
      win.fetch = (url, opts) => {
        headers.push(opts && opts.headers);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: false }) });
      };
      const sel = doc.getElementById('quality-select');
      sel.value = 'high';
      sel.onchange();
      await flush();
      expect(headers[0]).toEqual({ 'Content-Type': 'application/json' });
    });

    it('AS-IS: success:false -> no throw, no banner (silent no-op)', async () => {
      const { win, doc } = boot();
      withFetch(win, [routeExact('POST', '/api/quality', { success: false })]);
      const sel = doc.getElementById('quality-select');
      sel.value = 'medium';
      sel.onchange();
      await flush();
      expect(doc.getElementById('error-banner').classList.contains('visible')).toBe(false);
      expect(sel.value).toBe('medium');
    });

    it('error path -> showError writes #error-banner with "Quality change failed"', async () => {
      const { win, doc } = boot();
      win.fetch = () => Promise.reject(new Error('nope'));
      const sel = doc.getElementById('quality-select');
      sel.value = 'kick';
      sel.onchange();
      await flush();
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);
      expect(banner.textContent).toContain('Quality change failed');
    });
  });
});
