/**
 * tests/dashboard/analyticsUI.test.js
 *
 * Equivalence baseline for the C2 extraction of the analytics UI out of the
 * app.js IIFE. These tests pin the AS-IS observable contract of the analytics
 * functions WHILE they still live in app.js, driven via the guarded
 * window.__appAnalytics hook. After C2 the SAME contract is asserted against the
 * extracted module — green here is the proof the extraction preserved behavior.
 *
 * What is observable (and therefore pinned):
 *   - loadHistoryStats: the fetch endpoint it hits (GET /api/history/stats) and
 *     the stat-span text it writes (total/unique/peak + formatted uptime),
 *     including the error-catch fallback.
 *   - uptime formatting math (hrs + 'h ' + mins + 'm').
 *   - drawTopTracksChart slice(0,10) + guard branches.
 *   - drawListenerChart empty-state (<2 points) vs draw branch.
 *   - loadAnalytics: fires both the chart draw and the stats fetch.
 *
 * Canvas caveat: jsdom's getContext('2d') is a no-op mock — nothing is drawn to
 * an inspectable surface, so canvas rendering is NOT pixel-observable. Where a
 * behavior is ONLY expressible through canvas calls (e.g. the "Collecting
 * data..." placeholder is drawn via ctx.fillText, the top-10 bars via fillRect),
 * we install a RECORDING ctx (overriding getContext on the canvas elements) and
 * assert on the recorded calls. Otherwise we assert DOM side-effects (canvas
 * width/height set) + no-throw.
 *
 * How the backend is controlled: loadHistoryStats calls deps.authFetch. Each test
 * that needs stats builds a recording authFetch (makeFetchStub) that records every
 * { method, url, body } and resolves canned JSON mirroring the real
 * /api/history/stats shape. app.js init's window.FRAnalytics on boot with its own
 * deps; the test then re-init's window.FRAnalytics with its OWN controllable deps
 * — the recording authFetch plus getListenerHistory/getPeakListeners getters that
 * return test-controlled local vars (replacing the old setListenerHistory/
 * setPeakListeners setters). We drive the 4 functions on window.FRAnalytics,
 * flush() the microtasks, then assert DOM text + recorded fetch calls.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, flush, closeAllWindows } from './appBoot.js';

// Tear down every jsdom window this file booted: each one keeps ~13 real
// timers alive for the rest of the process otherwise.
afterAll(closeAllWindows);

/**
 * Boot a fresh window and re-init window.FRAnalytics with test-controlled deps:
 * a recording authFetch built from `routes`, and getters returning local vars the
 * test can set. Returns the module (`an`) plus the recorded fetch calls and the
 * state setters (which mutate the local vars the getters read at call time).
 */
function bootWithFetch(routes) {
  const { win, doc } = bootWindow();
  const stub = makeFetchStub(routes);
  win.fetch = stub.fetch;

  // Local, test-controlled read-only state. The injected getters read these at
  // call time (mirroring how app.js feeds listenerHistory/peakListeners live).
  const state = { listenerHistory: [], peakListeners: 0 };
  const an = win.FRAnalytics;
  an.init({
    authFetch: (url, opts) => win.fetch(url, opts),
    getListenerHistory: () => state.listenerHistory,
    getPeakListeners: () => state.peakListeners,
  });
  // Adapter so the existing assertions keep their setListenerHistory/
  // setPeakListeners driving calls unchanged.
  an.setListenerHistory = (arr) => { state.listenerHistory = arr; };
  an.setPeakListeners = (n) => { state.peakListeners = n; };

  return { win, doc, an, calls: stub.calls };
}

/**
 * Install a recording 2D context on a specific canvas element, so canvas-only
 * behaviors (fillText / fillRect counts and args) become observable. Mirrors the
 * no-op shape the boot stub uses, but records every fillText/fillRect call.
 * Returns the record object.
 */
function recordCanvas(canvas) {
  const rec = { fillText: [], fillRect: [], clearRect: [] };
  const ctx = {
    fillRect(...a) { rec.fillRect.push(a); },
    clearRect(...a) { rec.clearRect.push(a); },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
    arc() {}, save() {}, restore() {}, translate() {}, scale() {},
    closePath() {},
    createLinearGradient() { return { addColorStop() {} }; },
    fillText(...a) { rec.fillText.push(a); },
    measureText() { return { width: 0 }; },
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {}, set font(_v) {},
  };
  canvas.getContext = () => ctx;
  return rec;
}

describe('analytics UI characterization (window.FRAnalytics)', () => {
  it('window.FRAnalytics exposes init + the 4 analytics fns', () => {
    const { win } = bootWindow();
    const an = win.FRAnalytics;
    expect(an).toBeTruthy();
    for (const fn of [
      'init',
      'loadAnalytics', 'drawListenerChart', 'loadHistoryStats', 'drawTopTracksChart',
    ]) {
      expect(typeof an[fn]).toBe('function');
    }
  });

  // -------------------------------------------------------------------------
  // loadHistoryStats — fetch wiring + stat-span text
  // -------------------------------------------------------------------------
  describe('loadHistoryStats', () => {
    it('GETs /api/history/stats and fills total / unique / peak spans', async () => {
      const { doc, an, calls } = bootWithFetch([
        routeExact('GET', '/api/history/stats', {
          totalPlayed: 42,
          uniqueTracks: 17,
          topTracks: [],
          uptimeMs: 0,
        }),
      ]);
      an.setPeakListeners(9);
      an.loadHistoryStats();
      await flush();

      const get = calls.find((c) => c.method === 'GET' && c.url === '/api/history/stats');
      expect(get).toBeTruthy();
      expect(doc.getElementById('analytics-total-tracks').textContent).toBe('42');
      expect(doc.getElementById('analytics-unique-tracks').textContent).toBe('17');
      // peak comes from the in-closure peakListeners state, not the payload
      expect(doc.getElementById('analytics-peak-listeners').textContent).toBe('9');
    });

    it('formats uptime as "<h>h <m>m" from uptimeMs (3661000 -> "1h 1m")', async () => {
      const { doc, an } = bootWithFetch([
        routeExact('GET', '/api/history/stats', {
          totalPlayed: 0, uniqueTracks: 0, topTracks: [], uptimeMs: 3661000,
        }),
      ]);
      an.loadHistoryStats();
      await flush();
      // 3661000ms = 1h (3600000) + 61000ms -> 1m (60000) remainder 1000ms dropped
      expect(doc.getElementById('analytics-uptime-value').textContent).toBe('1h 1m');
    });

    it('uptime with zero hours renders "0h <m>m" (90000ms -> "0h 1m")', async () => {
      const { doc, an } = bootWithFetch([
        routeExact('GET', '/api/history/stats', {
          totalPlayed: 0, uniqueTracks: 0, topTracks: [], uptimeMs: 90000,
        }),
      ]);
      an.loadHistoryStats();
      await flush();
      expect(doc.getElementById('analytics-uptime-value').textContent).toBe('0h 1m');
    });

    it('AS-IS: falsy uptimeMs (0) leaves the uptime span untouched at its initial "--"', async () => {
      const { doc, an } = bootWithFetch([
        routeExact('GET', '/api/history/stats', {
          totalPlayed: 1, uniqueTracks: 1, topTracks: [], uptimeMs: 0,
        }),
      ]);
      // index.html ships the uptime span as "--"; the code only writes it when
      // uptimeMs is truthy, so a 0 value never overwrites it.
      expect(doc.getElementById('analytics-uptime-value').textContent).toBe('--');
      an.loadHistoryStats();
      await flush();
      expect(doc.getElementById('analytics-uptime-value').textContent).toBe('--');
    });

    it('AS-IS: missing totalPlayed / uniqueTracks coerce to numeric 0 via `|| 0`', async () => {
      const { doc, an } = bootWithFetch([
        routeExact('GET', '/api/history/stats', { topTracks: [] }),
      ]);
      an.setPeakListeners(0);
      an.loadHistoryStats();
      await flush();
      expect(doc.getElementById('analytics-total-tracks').textContent).toBe('0');
      expect(doc.getElementById('analytics-unique-tracks').textContent).toBe('0');
      expect(doc.getElementById('analytics-peak-listeners').textContent).toBe('0');
    });

    it('error fallback: rejected fetch sets total/unique to "0" and peak to peakListeners', async () => {
      const { win, doc, an } = bootWithFetch([]);
      // override fetch with a rejecting one to exercise the .catch branch
      win.fetch = () => Promise.reject(new Error('network down'));
      an.setPeakListeners(5);
      an.loadHistoryStats();
      await flush();
      expect(doc.getElementById('analytics-total-tracks').textContent).toBe('0');
      expect(doc.getElementById('analytics-unique-tracks').textContent).toBe('0');
      expect(doc.getElementById('analytics-peak-listeners').textContent).toBe('5');
    });

    it('error fallback does NOT touch the uptime span (stays at "--")', async () => {
      const { win, doc, an } = bootWithFetch([]);
      win.fetch = () => Promise.reject(new Error('boom'));
      an.loadHistoryStats();
      await flush();
      expect(doc.getElementById('analytics-uptime-value').textContent).toBe('--');
    });

    it('calls drawTopTracksChart with the payload topTracks (no throw on render)', async () => {
      const { doc, an } = bootWithFetch([
        routeExact('GET', '/api/history/stats', {
          totalPlayed: 3, uniqueTracks: 2,
          topTracks: [{ track: 'a.mp3', count: 5 }, { track: 'b.mp3', count: 2 }],
          uptimeMs: 0,
        }),
      ]);
      const rec = recordCanvas(doc.getElementById('tracks-chart'));
      await expect((async () => { an.loadHistoryStats(); await flush(); })()).resolves.toBeUndefined();
      // 2 tracks -> 2 bg fillRect + 2 fg fillRect (one pair per track)
      expect(rec.fillRect.length).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // drawListenerChart — empty-state vs draw branch
  // -------------------------------------------------------------------------
  describe('drawListenerChart', () => {
    it('empty history (<2 points) takes the "Collecting data..." placeholder branch', () => {
      const { doc, an } = bootWithFetch([]);
      const rec = recordCanvas(doc.getElementById('listeners-chart'));
      an.setListenerHistory([]);
      expect(() => an.drawListenerChart()).not.toThrow();
      // the placeholder is the ONLY fillText in this branch (the draw branch
      // would emit 5 axis labels). Observable proof the <2 branch was taken.
      expect(rec.fillText.length).toBe(1);
      expect(rec.fillText[0][0]).toBe('Collecting data...');
      // canvas was sized (DOM side-effect) and cleared once
      const canvas = doc.getElementById('listeners-chart');
      expect(canvas.height).toBe(200);
      expect(rec.clearRect.length).toBe(1);
    });

    it('single point (length 1) is still the placeholder branch', () => {
      const { doc, an } = bootWithFetch([]);
      const rec = recordCanvas(doc.getElementById('listeners-chart'));
      an.setListenerHistory([{ ts: 1, count: 3 }]);
      an.drawListenerChart();
      expect(rec.fillText.length).toBe(1);
      expect(rec.fillText[0][0]).toBe('Collecting data...');
    });

    it('>=2 points takes the draw branch (no placeholder, axis labels emitted, no throw)', () => {
      const { doc, an } = bootWithFetch([]);
      const rec = recordCanvas(doc.getElementById('listeners-chart'));
      an.setListenerHistory([
        { ts: 1, count: 2 }, { ts: 2, count: 5 }, { ts: 3, count: 3 },
      ]);
      expect(() => an.drawListenerChart()).not.toThrow();
      // draw branch emits 5 grid-line axis labels (i=0..4) and NO placeholder
      expect(rec.fillText.length).toBe(5);
      expect(rec.fillText.some((a) => a[0] === 'Collecting data...')).toBe(false);
    });

    it('no canvas in the DOM -> early return, no throw', () => {
      const { doc, an } = bootWithFetch([]);
      doc.getElementById('listeners-chart').remove();
      an.setListenerHistory([{ ts: 1, count: 1 }, { ts: 2, count: 2 }]);
      expect(() => an.drawListenerChart()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // drawTopTracksChart — slice(0,10) + guard branches
  // -------------------------------------------------------------------------
  describe('drawTopTracksChart', () => {
    it('slice(0,10): given 12 tracks, only 10 are rendered (10 bar pairs)', () => {
      const { doc, an } = bootWithFetch([]);
      const rec = recordCanvas(doc.getElementById('tracks-chart'));
      const tracks = [];
      for (let i = 0; i < 12; i++) tracks.push({ track: 't' + i + '.mp3', count: 12 - i });
      an.drawTopTracksChart(tracks);
      // each rendered track => 2 fillRect (bg + fg). 10 tracks => 20.
      expect(rec.fillRect.length).toBe(20);
      // each rendered track => 2 fillText (name + count). 10 tracks => 20.
      expect(rec.fillText.length).toBe(20);
    });

    it('truncates track names longer than 28 chars with an ellipsis', () => {
      const { doc, an } = bootWithFetch([]);
      const rec = recordCanvas(doc.getElementById('tracks-chart'));
      const longName = 'x'.repeat(40) + '.mp3';
      an.drawTopTracksChart([{ track: longName, count: 1 }]);
      // first fillText per track is the (possibly truncated) name
      const nameDrawn = rec.fillText[0][0];
      expect(nameDrawn).toBe(longName.substr(0, 28) + '...');
    });

    it('empty tracks -> guard early return, no throw, nothing drawn', () => {
      const { doc, an } = bootWithFetch([]);
      const rec = recordCanvas(doc.getElementById('tracks-chart'));
      expect(() => an.drawTopTracksChart([])).not.toThrow();
      expect(rec.fillRect.length).toBe(0);
      expect(rec.fillText.length).toBe(0);
    });

    it('no canvas in the DOM -> early return, no throw', () => {
      const { doc, an } = bootWithFetch([]);
      doc.getElementById('tracks-chart').remove();
      expect(() => an.drawTopTracksChart([{ track: 'a.mp3', count: 1 }])).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // loadAnalytics — fires both the chart draw and the stats fetch
  // -------------------------------------------------------------------------
  describe('loadAnalytics', () => {
    it('draws the listener chart AND fetches /api/history/stats', async () => {
      const { doc, an, calls } = bootWithFetch([
        routeExact('GET', '/api/history/stats', {
          totalPlayed: 1, uniqueTracks: 1, topTracks: [], uptimeMs: 0,
        }),
      ]);
      const rec = recordCanvas(doc.getElementById('listeners-chart'));
      an.setListenerHistory([]);
      expect(() => an.loadAnalytics()).not.toThrow();
      await flush();
      // chart draw happened (placeholder branch, empty history)
      expect(rec.fillText.some((a) => a[0] === 'Collecting data...')).toBe(true);
      // stats fetch fired
      expect(calls.some((c) => c.method === 'GET' && c.url === '/api/history/stats')).toBe(true);
    });
  });
});
