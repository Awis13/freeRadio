/**
 * tests/dashboard/trackHistoryUI.test.js
 *
 * Characterization pins for the track-history sidebar cluster, currently living
 * inside the app.js IIFE and exposed (C1) via the window.__APP_TEST__-guarded
 * window.__appTrackHistory hook. In C2 this cluster is extracted into
 * dashboard/public/trackhistory.js (window.FRTrackHistory) and this file is
 * re-pointed to win.FRTrackHistory with assertions UNCHANGED, proving
 * behavioural equivalence.
 *
 * The cluster owns ZERO state. Two functions:
 *   - loadTrackHistory()        GET /api/history?limit=10 -> renderTrackHistory
 *   - renderTrackHistory(entries) renders #track-history-list rows
 *
 * Backend control is the same as the other UI pins: replace the boot's
 * never-resolving win.fetch with a recording makeFetchStub AFTER boot, then call
 * the hook fns and assert DOM (in `doc`) + recorded fetches (stub.calls).
 *
 * AS-IS quirks pinned here (flagged for the C2 extraction):
 *   - loadTrackHistory's .catch is EMPTY: on fetch rejection NO log/showError/DOM
 *     happens (#track-history-list untouched, #error-banner not visible).
 *   - renderTrackHistory does entries.slice().reverse(): the LAST input element
 *     renders as row 0 (the NOW row).
 *   - row 0 gets a .now-badge ('NOW') and NO .track-history-time; rows >0 get a
 *     .track-history-time (timeAgo) and NO .now-badge.
 *   - cleanTrackName: 'music/Foo_Bar.mp3' -> 'Foo Bar'; also set as the span title.
 *   - entry.bpm truthy -> .track-history-bpm = String(Math.round(bpm)); falsey/0
 *     -> no .track-history-bpm span.
 *   - null / [] entries -> a single .empty-state 'No history yet'.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, flush, closeAllWindows } from './appBoot.js';

// Close every jsdom window this file booted (rationale in appBoot.js).
afterAll(closeAllWindows);

/**
 * Boot a fresh window and grab the track-history hook. No init/deps to inject —
 * the hook fns are the real closure fns; tests control only win.fetch.
 */
function boot() {
  const { win, doc } = bootWindow();
  const th = win.FRTrackHistory;
  return { win, doc, th };
}

/** Install a recording fetch stub (replacing the never-resolving boot fetch). */
function withFetch(win, routes) {
  const stub = makeFetchStub(routes);
  win.fetch = stub.fetch;
  return stub;
}

describe('track-history UI characterization (window.FRTrackHistory)', () => {
  it('exposes the 2 cluster fns', () => {
    const { th } = boot();
    expect(th).toBeTruthy();
    expect(typeof th.loadTrackHistory).toBe('function');
    expect(typeof th.renderTrackHistory).toBe('function');
  });

  // -------------------------------------------------------------------------
  // loadTrackHistory -> GET /api/history?limit=10 -> renderTrackHistory
  // -------------------------------------------------------------------------
  describe('loadTrackHistory', () => {
    it('GET /api/history?limit=10 (no body) -> renders the entries', async () => {
      const { win, doc, th } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/history', [
          { track: 'music/Older_Track.mp3', ts: Date.now() - 7200000 },
          { track: 'music/Now_Playing.mp3', ts: Date.now() },
        ]),
      ]);
      th.loadTrackHistory();
      await flush();

      // exact method + url (query retained in the recorded call) + no body
      const call = stub.calls.find((c) => c.url === '/api/history?limit=10');
      expect(call).toBeTruthy();
      expect(call.method).toBe('GET');
      expect(call.body).toBeUndefined();

      // last input element is the NOW row (row 0)
      const items = doc.getElementById('track-history-list').querySelectorAll('.track-history-item');
      expect(items.length).toBe(2);
      expect(items[0].querySelector('.track-history-name').textContent).toBe('Now Playing');
      expect(items[0].querySelector('.now-badge')).toBeTruthy();
    });

    it('AS-IS: fetch rejection is SILENT — list untouched, #error-banner not visible', async () => {
      const { win, doc, th } = boot();
      // pre-seed the container with a sentinel so we can prove it is NOT touched
      const container = doc.getElementById('track-history-list');
      container.innerHTML = '<div class="sentinel">keep-me</div>';

      win.fetch = () => Promise.reject(new Error('boom'));
      th.loadTrackHistory();
      await flush();

      // empty .catch -> no empty-state written, sentinel survives
      expect(container.querySelector('.sentinel')).toBeTruthy();
      expect(container.querySelector('.empty-state')).toBeNull();
      // no showError -> banner stays hidden
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // renderTrackHistory — driven directly
  // -------------------------------------------------------------------------
  describe('renderTrackHistory', () => {
    it('AS-IS: null entries -> single .empty-state "No history yet"', () => {
      const { doc, th } = boot();
      th.renderTrackHistory(null);
      const container = doc.getElementById('track-history-list');
      expect(container.querySelectorAll('.track-history-item').length).toBe(0);
      const empty = container.querySelector('.empty-state');
      expect(empty).toBeTruthy();
      expect(empty.textContent).toBe('No history yet');
    });

    it('AS-IS: empty array -> single .empty-state "No history yet"', () => {
      const { doc, th } = boot();
      th.renderTrackHistory([]);
      const container = doc.getElementById('track-history-list');
      expect(container.querySelectorAll('.track-history-item').length).toBe(0);
      expect(container.querySelector('.empty-state').textContent).toBe('No history yet');
    });

    it('AS-IS: reversal — LAST input element becomes row 0 (the NOW row)', () => {
      const { doc, th } = boot();
      th.renderTrackHistory([
        { track: 'a/First.mp3', ts: Date.now() - 7200000 },
        { track: 'a/Second.mp3', ts: Date.now() - 3600000 },
        { track: 'a/Third.mp3', ts: Date.now() },
      ]);
      const items = doc.getElementById('track-history-list').querySelectorAll('.track-history-item');
      expect(items.length).toBe(3);
      // input[2] -> row 0, input[1] -> row 1, input[0] -> row 2
      expect(items[0].querySelector('.track-history-name').textContent).toBe('Third');
      expect(items[1].querySelector('.track-history-name').textContent).toBe('Second');
      expect(items[2].querySelector('.track-history-name').textContent).toBe('First');
    });

    it('cleanTrackName: strips path + extension + underscores, and sets the span title', () => {
      const { doc, th } = boot();
      th.renderTrackHistory([{ track: 'music/Foo_Bar.mp3', ts: Date.now() }]);
      const nameEl = doc.getElementById('track-history-list')
        .querySelector('.track-history-item .track-history-name');
      expect(nameEl.textContent).toBe('Foo Bar');
      expect(nameEl.title).toBe('Foo Bar');
    });

    it('row 0 -> .now-badge "NOW" and NO .track-history-time', () => {
      const { doc, th } = boot();
      th.renderTrackHistory([{ track: 'x/Solo.mp3', ts: Date.now() }]);
      const row0 = doc.getElementById('track-history-list').querySelector('.track-history-item');
      const badge = row0.querySelector('.now-badge');
      expect(badge).toBeTruthy();
      expect(badge.textContent).toBe('NOW');
      expect(row0.querySelector('.track-history-time')).toBeNull();
    });

    it('rows >0 -> .track-history-time (timeAgo) and NO .now-badge', () => {
      const { doc, th } = boot();
      // input[0] is older -> renders as the LAST row (idx 1), ts = now-120s -> "2m ago"
      th.renderTrackHistory([
        { track: 'x/Old.mp3', ts: Date.now() - 120000 },
        { track: 'x/New.mp3', ts: Date.now() },
      ]);
      const items = doc.getElementById('track-history-list').querySelectorAll('.track-history-item');
      const olderRow = items[1];
      expect(olderRow.querySelector('.now-badge')).toBeNull();
      const timeEl = olderRow.querySelector('.track-history-time');
      expect(timeEl).toBeTruthy();
      expect(timeEl.textContent).toBe('2m ago');
    });

    it('bpm truthy -> .track-history-bpm = String(Math.round(bpm)); falsey -> no span', () => {
      const { doc, th } = boot();
      th.renderTrackHistory([
        { track: 'x/NoBpm.mp3', ts: Date.now() - 60000 },          // bpm undefined -> no span
        { track: 'x/ZeroBpm.mp3', ts: Date.now() - 30000, bpm: 0 }, // bpm 0 (falsey) -> no span
        { track: 'x/WithBpm.mp3', ts: Date.now(), bpm: 128.7 },     // -> "129", row 0
      ]);
      const items = doc.getElementById('track-history-list').querySelectorAll('.track-history-item');
      // row 0 = WithBpm
      const bpmEl = items[0].querySelector('.track-history-bpm');
      expect(bpmEl).toBeTruthy();
      expect(bpmEl.textContent).toBe('129');
      // row 1 = ZeroBpm (input[1]) -> no bpm span
      expect(items[1].querySelector('.track-history-bpm')).toBeNull();
      // row 2 = NoBpm (input[0]) -> no bpm span
      expect(items[2].querySelector('.track-history-bpm')).toBeNull();
    });

    it('item child order is name, then (now-badge|time), then bpm', () => {
      const { doc, th } = boot();
      th.renderTrackHistory([{ track: 'x/Track.mp3', ts: Date.now(), bpm: 100 }]);
      const row0 = doc.getElementById('track-history-list').querySelector('.track-history-item');
      const classes = Array.from(row0.children).map((c) => c.className);
      expect(classes).toEqual(['track-history-name', 'now-badge', 'track-history-bpm']);
    });

    it('always clears the container first (re-render replaces prior content)', () => {
      const { doc, th } = boot();
      const container = doc.getElementById('track-history-list');
      th.renderTrackHistory([{ track: 'x/One.mp3', ts: Date.now() }]);
      expect(container.querySelectorAll('.track-history-item').length).toBe(1);
      // second render with empty -> prior item cleared, empty-state shown
      th.renderTrackHistory([]);
      expect(container.querySelectorAll('.track-history-item').length).toBe(0);
      expect(container.querySelector('.empty-state').textContent).toBe('No history yet');
    });
  });
});
