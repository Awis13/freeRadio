/**
 * tests/dashboard/restreamStatusUI.test.js
 *
 * Characterization pins for the restream-STATUS widget cluster, currently inline
 * in the app.js IIFE (updateRestreamStatus + loadRestreamStatusFallback, plus the
 * owned var lastRtmpHealth). These tests pin the AS-IS observable contract before
 * extraction into dashboard/public/restreamStatus.js (window.FRRestreamStatus).
 *
 * They were authored in C1 against app.js via the test-only window.__appRestreamStatus
 * hook, and will be re-pointed in C2 to the extracted module (hook-object rename only,
 * assertions unchanged) to prove behavioural equivalence.
 *
 * This is the restream-STATUS widget — per-platform LED status rendered from
 * rtmp-health WebSocket data, with a /api/stream-keys fallback. It is DISTINCT from
 * the already-extracted restream-SETTINGS (window.FRRestreamSettings).
 *
 * The cluster fns use the REAL deps (authFetch -> win.fetch, escapeHtml ->
 * FRUtils.escapeHtml). The widget is mostly fed by WS data, so updateRestreamStatus
 * is driven directly with rtmpHealth fixtures; the fallback path is driven by
 * swapping the boot's never-resolving win.fetch for a recording makeFetchStub.
 *
 * AS-IS quirks pinned here (flagged for the C2 extraction):
 *   - updateRestreamStatus stores its arg into lastRtmpHealth (write-only dead state)
 *     and never reads it back — proven via get/setLastRtmpHealth.
 *   - empty/missing outputs (keys.length===0) routes the WS path to
 *     loadRestreamStatusFallback() -> GET /api/stream-keys (a fetch fires even on WS).
 *   - WS path renders the platform name RAW via textContent (NOT escaped); the
 *     fallback path escapeHtml's the name.
 *   - WS dot classes are live/error/off; fallback dot classes are only on/off.
 *   - fallback text span class is ALWAYS 'restream-status-text off' (READY/OFF text);
 *     WS text span class is 'restream-status-text ' + raw status.
 *   - status==='error' && info.error sets div.title.
 *   - fallback accepts {platforms:{...}} OR a bare object map (data.platforms || data).
 *   - fallback empty map -> 'No platforms' empty-state; its error path is a silent
 *     swallowing .catch (no banner, no log).
 */

import { describe, it, expect } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, flush } from './appBoot.js';

/**
 * Boot a fresh window and grab the restream-status hook. No init/deps to inject —
 * the hook fns are the real closure fns; tests control only win.fetch.
 */
function boot() {
  const { win, doc } = bootWindow();
  const rs = win.FRRestreamStatus;
  return { win, doc, rs };
}

/** Install a recording fetch stub (replacing the never-resolving boot fetch). */
function withFetch(win, routes) {
  const stub = makeFetchStub(routes);
  win.fetch = stub.fetch;
  return stub;
}

describe('restream-status UI characterization (window.FRRestreamStatus)', () => {
  it('exposes the 2 fns + lastRtmpHealth getter/setter', () => {
    const { rs } = boot();
    expect(rs).toBeTruthy();
    for (const fn of [
      'updateRestreamStatus', 'loadRestreamStatusFallback',
      'getLastRtmpHealth', 'setLastRtmpHealth',
    ]) {
      expect(typeof rs[fn]).toBe('function');
    }
  });

  // -------------------------------------------------------------------------
  // updateRestreamStatus — WS happy path (non-empty outputs): pure render, no fetch
  // -------------------------------------------------------------------------
  describe('updateRestreamStatus (WS path)', () => {
    it('renders one .restream-status-item per output with live/error/off dot + text', () => {
      const { win, doc, rs } = boot();
      // record any fetch to prove the happy path makes NONE
      const stub = withFetch(win, []);

      rs.updateRestreamStatus({
        outputs: {
          YouTube: { status: 'live' },
          Twitch: { status: 'error', error: 'auth failed' },
          Mixcloud: { status: 'offline' },
        },
      });

      const container = doc.getElementById('restream-status-list');
      const items = container.querySelectorAll('.restream-status-item');
      expect(items.length).toBe(3);
      // happy path = pure render, zero backend calls
      expect(stub.calls.length).toBe(0);

      // --- YouTube: live ---
      const yt = items[0];
      expect(yt.className).toBe('restream-status-item');
      const ytSpans = yt.querySelectorAll('span');
      expect(ytSpans[0].className).toBe('restream-status-dot live');
      expect(ytSpans[1].textContent).toBe('YouTube');
      expect(ytSpans[2].className).toBe('restream-status-text live');
      expect(ytSpans[2].textContent).toBe('LIVE');
      // no title on a non-error item
      expect(yt.title).toBe('');

      // --- Twitch: error (+ title from info.error) ---
      const tw = items[1];
      const twSpans = tw.querySelectorAll('span');
      expect(twSpans[0].className).toBe('restream-status-dot error');
      expect(twSpans[1].textContent).toBe('Twitch');
      expect(twSpans[2].className).toBe('restream-status-text error');
      expect(twSpans[2].textContent).toBe('ERROR');
      expect(tw.title).toBe('auth failed');

      // --- Mixcloud: offline -> off / OFF ---
      const mx = items[2];
      const mxSpans = mx.querySelectorAll('span');
      expect(mxSpans[0].className).toBe('restream-status-dot off');
      expect(mxSpans[1].textContent).toBe('Mixcloud');
      expect(mxSpans[2].className).toBe('restream-status-text offline');
      expect(mxSpans[2].textContent).toBe('OFF');
    });

    it('AS-IS: missing/falsy info.status defaults to "offline" -> off / OFF', () => {
      const { doc, rs } = boot();
      rs.updateRestreamStatus({ outputs: { Kick: {} } });
      const item = doc.getElementById('restream-status-list').querySelector('.restream-status-item');
      const spans = item.querySelectorAll('span');
      expect(spans[0].className).toBe('restream-status-dot off');
      // status defaults to 'offline', appended raw to the text span class
      expect(spans[2].className).toBe('restream-status-text offline');
      expect(spans[2].textContent).toBe('OFF');
    });

    it('AS-IS: error status WITHOUT info.error sets no title', () => {
      const { doc, rs } = boot();
      rs.updateRestreamStatus({ outputs: { X: { status: 'error' } } });
      const item = doc.getElementById('restream-status-list').querySelector('.restream-status-item');
      expect(item.querySelector('span').className).toBe('restream-status-dot error');
      expect(item.title).toBe('');
    });

    it('AS-IS: name is rendered RAW via textContent (NOT escaped) on the WS path', () => {
      const { doc, rs } = boot();
      rs.updateRestreamStatus({ outputs: { '<b>Y</b>': { status: 'live' } } });
      const nameSpan = doc.getElementById('restream-status-list')
        .querySelector('.restream-status-item').querySelectorAll('span')[1];
      // textContent assignment -> the literal string, no child elements injected
      expect(nameSpan.textContent).toBe('<b>Y</b>');
      expect(nameSpan.querySelector('b')).toBeNull();
    });

    it('clears the container before re-render (innerHTML reset)', () => {
      const { doc, rs } = boot();
      rs.updateRestreamStatus({ outputs: { A: { status: 'live' } } });
      rs.updateRestreamStatus({ outputs: { B: { status: 'error', error: 'e' } } });
      const items = doc.getElementById('restream-status-list').querySelectorAll('.restream-status-item');
      expect(items.length).toBe(1);
      expect(items[0].querySelectorAll('span')[1].textContent).toBe('B');
    });

    it('stores its arg into lastRtmpHealth (write-only dead state)', () => {
      const { win, rs } = boot();
      withFetch(win, []);
      const fixture = { outputs: { A: { status: 'live' } } };
      rs.updateRestreamStatus(fixture);
      expect(rs.getLastRtmpHealth()).toBe(fixture);
    });

    it('setLastRtmpHealth round-trips through the accessor', () => {
      const { rs } = boot();
      const sentinel = { outputs: {}, marker: 1 };
      rs.setLastRtmpHealth(sentinel);
      expect(rs.getLastRtmpHealth()).toBe(sentinel);
    });
  });

  // -------------------------------------------------------------------------
  // updateRestreamStatus — empty/missing outputs routes to the fallback fetch
  // -------------------------------------------------------------------------
  describe('updateRestreamStatus empty-outputs routing', () => {
    it('keys.length===0 -> calls loadRestreamStatusFallback -> GET /api/stream-keys', async () => {
      const { win, doc, rs } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/stream-keys', {
          platforms: { YouTube: { enabled: true }, Twitch: { enabled: false } },
        }),
      ]);
      rs.updateRestreamStatus({ outputs: {} });
      await flush();

      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/stream-keys')).toBe(true);
      expect(stub.calls.every((c) => c.method === 'GET')).toBe(true);
      // and it stored the (empty-outputs) arg too
      const items = doc.getElementById('restream-status-list').querySelectorAll('.restream-status-item');
      expect(items.length).toBe(2);
    });

    it('AS-IS: missing outputs key (healthData with no .outputs) also routes to fallback', async () => {
      const { win, rs } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/stream-keys', { platforms: {} }),
      ]);
      rs.updateRestreamStatus({});
      await flush();
      expect(stub.calls.some((c) => c.url === '/api/stream-keys')).toBe(true);
    });

    it('AS-IS: null healthData routes to fallback (outputs defaults to {})', async () => {
      const { win, rs } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/stream-keys', { platforms: {} }),
      ]);
      rs.updateRestreamStatus(null);
      await flush();
      expect(stub.calls.some((c) => c.url === '/api/stream-keys')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // loadRestreamStatusFallback — GET /api/stream-keys -> on/off render
  // -------------------------------------------------------------------------
  describe('loadRestreamStatusFallback', () => {
    it('renders on/off dot + READY/OFF text from {platforms:{...}}', async () => {
      const { win, doc, rs } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/stream-keys', {
          platforms: { YouTube: { enabled: true }, Twitch: { enabled: false } },
        }),
      ]);
      rs.loadRestreamStatusFallback();
      await flush();

      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/stream-keys')).toBe(true);

      const items = doc.getElementById('restream-status-list').querySelectorAll('.restream-status-item');
      expect(items.length).toBe(2);

      // YouTube enabled -> on / READY
      const ytSpans = items[0].querySelectorAll('span');
      expect(ytSpans[0].className).toBe('restream-status-dot on');
      expect(ytSpans[1].textContent).toBe('YouTube');
      expect(ytSpans[2].className).toBe('restream-status-text off');
      expect(ytSpans[2].textContent).toBe('READY');

      // Twitch disabled -> off / OFF (text span class STILL 'off')
      const twSpans = items[1].querySelectorAll('span');
      expect(twSpans[0].className).toBe('restream-status-dot off');
      expect(twSpans[2].className).toBe('restream-status-text off');
      expect(twSpans[2].textContent).toBe('OFF');
    });

    it('AS-IS: accepts a bare object map (no .platforms wrapper) via data.platforms || data', async () => {
      const { win, doc, rs } = boot();
      withFetch(win, [
        routeExact('GET', '/api/stream-keys', { YouTube: { enabled: true } }),
      ]);
      rs.loadRestreamStatusFallback();
      await flush();

      const items = doc.getElementById('restream-status-list').querySelectorAll('.restream-status-item');
      expect(items.length).toBe(1);
      const spans = items[0].querySelectorAll('span');
      expect(spans[0].className).toBe('restream-status-dot on');
      expect(spans[1].textContent).toBe('YouTube');
      expect(spans[2].textContent).toBe('READY');
    });

    it('AS-IS: name IS escapeHtml\'d on the fallback path', async () => {
      const { win, doc, rs } = boot();
      withFetch(win, [
        routeExact('GET', '/api/stream-keys', { platforms: { '<b>Y</b>': { enabled: true } } }),
      ]);
      rs.loadRestreamStatusFallback();
      await flush();

      const nameSpan = doc.getElementById('restream-status-list')
        .querySelector('.restream-status-item').querySelectorAll('span')[1];
      // escaped -> no real <b> child injected; the literal text is preserved
      expect(nameSpan.querySelector('b')).toBeNull();
      expect(nameSpan.textContent).toBe('<b>Y</b>');
    });

    it('AS-IS: empty platforms map -> "No platforms" empty-state', async () => {
      const { win, doc, rs } = boot();
      withFetch(win, [
        routeExact('GET', '/api/stream-keys', { platforms: {} }),
      ]);
      rs.loadRestreamStatusFallback();
      await flush();

      const container = doc.getElementById('restream-status-list');
      expect(container.querySelectorAll('.restream-status-item').length).toBe(0);
      expect(container.querySelector('.empty-state').textContent).toBe('No platforms');
    });

    it('AS-IS: empty bare object ({}) -> "No platforms" empty-state', async () => {
      const { win, doc, rs } = boot();
      withFetch(win, [
        routeExact('GET', '/api/stream-keys', {}),
      ]);
      rs.loadRestreamStatusFallback();
      await flush();
      expect(doc.getElementById('restream-status-list').querySelector('.empty-state').textContent)
        .toBe('No platforms');
    });

    it('AS-IS: fetch rejection is swallowed silently (no banner, no throw)', async () => {
      const { win, doc, rs } = boot();
      win.fetch = () => Promise.reject(new Error('boom'));
      rs.loadRestreamStatusFallback();
      await flush();
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(false);
    });
  });
});
