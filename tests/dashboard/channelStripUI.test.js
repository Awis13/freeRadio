/**
 * tests/dashboard/channelStripUI.test.js
 *
 * Characterization pins for the channel-strip DSP UI cluster, which now lives in
 * dashboard/public/channelstrip.js (window.FRChannelStrip). These tests pinned
 * the AS-IS observable contract while the cluster was inline in the app.js IIFE,
 * and were carried onto the extracted module with the assertions unchanged.
 *
 * The cluster has NO init/dependency-injection surface: the test hook
 * window.__appChannelStrip holds the REAL closure functions, which use the REAL
 * deps (authFetch -> win.fetch, log, showError). So the only backend control is
 * replacing the boot's never-resolving win.fetch with a recording makeFetchStub
 * AFTER boot, then calling the cluster fns and asserting DOM (in `doc`) +
 * recorded fetches (stub.calls).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AS-IS REALITY (verified, NOT what a naive read of index.html suggests):
 * The whole Channel Strip markup in index.html (from the "PHASE 2 — Channel
 * Strip" line) is wrapped in an HTML COMMENT, so none of #strip-* exist as live
 * nodes. Therefore the refs the cluster CAPTURES ONCE AT BOOT are all null:
 *     stripBypass, stripPreset, stripBypassBadge, stripGateLed, stripCompGr.
 * Consequences pinned below (these are the contract C2 must preserve byte-for-
 * byte by resolving the same refs inside init() against the same absent DOM):
 *   - stripUpdateBadge() is a permanent NO-OP (early-returns on null badge).
 *   - the #strip-bypass / #strip-preset onchange handlers and the slider
 *     oninput handlers are NEVER WIRED (their `if (el)` boot guards see null).
 *   - the boot block `if (stripBypass) { stripLoadConfig(); setTimeout(2000) }`
 *     NEVER RUNS: at boot stripLoaded stays false and no 2s auto-start timer is
 *     scheduled, so metering never auto-starts.
 *   - in stripStartMetering the GR/gate-LED updates guarded by the captured
 *     stripGateLed / stripCompGr refs are skipped; only the DYNAMIC
 *     getElementById lookups (#strip-compact-gate, #strip-compact-gr) and, in
 *     stripStopMetering, #strip-gr-value, run.
 * The functions that read the DOM via DYNAMIC document.getElementById at
 * call-time (stripUpdateVal, the param-apply loop in stripLoadConfig, the
 * compact metering updates, the stop resets) ARE reachable — tests inject the
 * matching elements into `doc` and drive them, mirroring how the visual-profiles
 * pins hand-build grid markup.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * TIMERS ARE THE CARE ITEM. The reachable timers are:
 *   - setTimeout(50)   send debounce (stripSendConfig)
 *   - setInterval(300) metering poll (stripStartMetering)
 * flush() drains microtasks but NOT timers, so every timer-dependent pin uses
 * vi.useFakeTimers() (installed before boot) + vi.advanceTimersByTime(...)
 * interleaved with flush() to drain the .then(r=>r.json()) chains the timers
 * schedule. vi.useRealTimers() runs in afterEach to prevent leakage.
 *
 * Endpoints pinned:
 *   - GET  /api/channel-strip          stripLoadConfig
 *   - POST /api/channel-strip          stripSendConfig (debounced, last-wins)
 *   - GET  /api/channel-strip/metering stripStartMetering interval
 *   (POST /api/channel-strip/preset is unreachable here — its onchange handler
 *    is never wired because #strip-preset is absent at boot.)
 */

import { describe, it, expect, afterEach, vi, afterAll } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, flush, closeAllWindows } from './appBoot.js';

// Close every jsdom window this file booted (rationale in appBoot.js).
afterAll(closeAllWindows);

/**
 * Boot a fresh window and grab the channel-strip hook. No init/deps to inject —
 * the hook fns are the real closure fns; tests control only win.fetch.
 */
function boot() {
  const { win, doc } = bootWindow();
  const cs = win.FRChannelStrip;
  return { win, doc, cs };
}

/**
 * Boot under fake timers. Installs vi.useFakeTimers() BEFORE bootWindow() so the
 * setTimeout(50)/setInterval(300) the cluster schedules after boot land on the
 * fake clock and can be advanced deterministically (and are discarded by
 * useRealTimers in afterEach, so nothing leaks).
 */
function bootFake() {
  vi.useFakeTimers();
  return boot();
}

/** Install a recording fetch stub (replacing the never-resolving boot fetch). */
function withFetch(win, routes) {
  const stub = makeFetchStub(routes);
  win.fetch = stub.fetch;
  return stub;
}

/**
 * Inject the strip DOM nodes that the cluster reads via DYNAMIC
 * document.getElementById at call time (the live page comments these out, so
 * they must be added post-boot — after the cluster's captured refs are already
 * null-bound, exactly as C2's init() will re-bind them).
 */
function injectStripDom(doc) {
  const c = doc.createElement('div');
  c.id = '__strip-inject';
  c.innerHTML = [
    '<input id="strip-gate-threshold">',
    '<span id="strip-gate-threshold-val"></span>',
    '<input id="strip-eq-mid-q">',
    '<span id="strip-eq-mid-q-val"></span>',
    '<input id="strip-output-gain">',
    '<span id="strip-output-gain-val"></span>',
    '<span id="strip-bypass-badge">orig</span>',
    '<div id="channel-strip-grid"></div>',
    '<span id="strip-compact-gate" class="strip-led"></span>',
    '<span id="strip-compact-gr">0 dB</span>',
    '<span id="strip-gr-value">0 dB</span>',
  ].join('');
  doc.body.appendChild(c);
  return c;
}

afterEach(() => {
  // Always restore real timers so fake-timer state never leaks into other suites.
  vi.useRealTimers();
});

describe('channel-strip UI characterization (window.FRChannelStrip)', () => {
  it('exposes the 7 cluster fns + the 3 state accessors + STRIP_PARAMS (17 entries)', () => {
    const { cs } = boot();
    expect(cs).toBeTruthy();
    for (const fn of [
      'stripUpdateVal', 'stripLoadConfig', 'stripUpdateBadge', 'stripSendConfig',
      'stripStartMetering', 'stripStopMetering',
      'getMeteringInterval', 'getStripLoaded', 'setStripLoaded',
    ]) {
      expect(typeof cs[fn]).toBe('function');
    }
    expect(Array.isArray(cs.STRIP_PARAMS)).toBe(true);
    expect(cs.STRIP_PARAMS.length).toBe(17);
  });

  it('AS-IS: with the strip DOM commented out, boot neither loads config nor schedules auto-start', async () => {
    // `if (stripBypass)` is false (#strip-bypass absent) -> stripLoadConfig is
    // not called at boot and no 2s timer is scheduled.
    const { cs } = bootFake();
    expect(cs.getStripLoaded()).toBe(false);
    expect(cs.getMeteringInterval()).toBeNull();
    // advancing well past the would-be 2s gate does nothing (no timer exists)
    vi.advanceTimersByTime(5000);
    await flush();
    expect(cs.getMeteringInterval()).toBeNull();
  });

  it('setStripLoaded/getStripLoaded round-trip the gate flag', () => {
    const { cs } = boot();
    expect(cs.getStripLoaded()).toBe(false);
    cs.setStripLoaded(true);
    expect(cs.getStripLoaded()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // stripUpdateVal — slider value display formatting (dynamic getElementById)
  // -------------------------------------------------------------------------
  describe('stripUpdateVal', () => {
    function paramById(cs, id) {
      return cs.STRIP_PARAMS.find((p) => p.id === id);
    }

    it('plain param: writes value + unit into #<id>-val', () => {
      const { doc, cs } = boot();
      injectStripDom(doc);
      doc.getElementById('strip-gate-threshold').value = '-24';
      cs.stripUpdateVal(paramById(cs, 'strip-gate-threshold')); // unit ' dB', no fmt
      expect(doc.getElementById('strip-gate-threshold-val').textContent).toBe('-24 dB');
    });

    it('fmt param strip-eq-mid-q: toFixed(1) with empty unit ("2" -> "2.0")', () => {
      const { doc, cs } = boot();
      injectStripDom(doc);
      doc.getElementById('strip-eq-mid-q').value = '2';
      cs.stripUpdateVal(paramById(cs, 'strip-eq-mid-q'));
      expect(doc.getElementById('strip-eq-mid-q-val').textContent).toBe('2.0');
    });

    it('fmt param strip-output-gain: 20*log10(max(0.001,v)) toFixed(1) + " dB" ("1" -> "0.0 dB")', () => {
      const { doc, cs } = boot();
      injectStripDom(doc);
      doc.getElementById('strip-output-gain').value = '1';
      cs.stripUpdateVal(paramById(cs, 'strip-output-gain'));
      expect(doc.getElementById('strip-output-gain-val').textContent).toBe('0.0 dB');
    });

    it('fmt param strip-output-gain: value "0" floors to max(0.001) -> "-60.0 dB"', () => {
      const { doc, cs } = boot();
      injectStripDom(doc);
      doc.getElementById('strip-output-gain').value = '0';
      cs.stripUpdateVal(paramById(cs, 'strip-output-gain'));
      expect(doc.getElementById('strip-output-gain-val').textContent).toBe('-60.0 dB');
    });

    it('null-guards a param whose elements are absent (no throw)', () => {
      const { cs } = boot();
      // bogus id -> el/valEl null -> early return, no throw.
      expect(() => cs.stripUpdateVal({ id: 'nope', key: 'x', unit: ' dB' })).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // stripUpdateBadge — AS-IS NO-OP (captured stripBypassBadge is null)
  // -------------------------------------------------------------------------
  describe('stripUpdateBadge', () => {
    it('is a no-op because the badge ref captured at boot is null (even with a live #strip-bypass-badge)', () => {
      const { doc, cs } = boot();
      injectStripDom(doc);
      const badge = doc.getElementById('strip-bypass-badge');
      const grid = doc.getElementById('channel-strip-grid');
      cs.stripUpdateBadge(true);
      cs.stripUpdateBadge(false);
      // unchanged: early `if (!stripBypassBadge) return` short-circuits both calls
      expect(badge.textContent).toBe('orig');
      expect(grid.classList.contains('bypassed')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // stripLoadConfig — GET /api/channel-strip
  // -------------------------------------------------------------------------
  describe('stripLoadConfig', () => {
    it('GETs the config, sets stripLoaded, and applies params to (dynamically looked-up) sliders', async () => {
      const { win, doc, cs } = boot();
      injectStripDom(doc);
      const stub = withFetch(win, [
        routeExact('GET', '/api/channel-strip', {
          bypass: false,
          gate_threshold: -30,
          eq_mid_q: 2,
          output_gain: 1,
        }),
      ]);
      cs.stripLoadConfig();
      await flush();

      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/channel-strip')).toBe(true);
      expect(cs.getStripLoaded()).toBe(true);

      // params copied to the sliders + their -val displays formatted
      expect(doc.getElementById('strip-gate-threshold').value).toBe('-30');
      expect(doc.getElementById('strip-gate-threshold-val').textContent).toBe('-30 dB');
      expect(doc.getElementById('strip-eq-mid-q').value).toBe('2');
      expect(doc.getElementById('strip-eq-mid-q-val').textContent).toBe('2.0');
      expect(doc.getElementById('strip-output-gain').value).toBe('1');
      expect(doc.getElementById('strip-output-gain-val').textContent).toBe('0.0 dB');
    });

    it('AS-IS: the bypass-badge update is skipped (captured badge null) — badge stays untouched', async () => {
      const { win, doc, cs } = boot();
      injectStripDom(doc);
      withFetch(win, [routeExact('GET', '/api/channel-strip', { bypass: true })]);
      cs.stripLoadConfig();
      await flush();
      // stripUpdateBadge(data.bypass) ran but no-op'd -> injected badge unchanged
      expect(doc.getElementById('strip-bypass-badge').textContent).toBe('orig');
      expect(doc.getElementById('channel-strip-grid').classList.contains('bypassed')).toBe(false);
    });

    it('AS-IS: load error path uses log() (no #error-banner)', async () => {
      const { win, doc, cs } = boot();
      win.fetch = () => Promise.reject(new Error('boom'));
      cs.stripLoadConfig();
      await flush();
      expect(doc.getElementById('error-banner').classList.contains('visible')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // stripSendConfig — POST /api/channel-strip, 50ms debounce, last-write-wins
  // -------------------------------------------------------------------------
  describe('stripSendConfig (debounce)', () => {
    it('coalesces two rapid calls into ONE POST carrying the LAST params', async () => {
      const { win, cs } = bootFake();
      const stub = withFetch(win, [routeExact('POST', '/api/channel-strip', { ok: true })]);

      cs.stripSendConfig({ gate_threshold: -10 });
      cs.stripSendConfig({ gate_threshold: -20 }); // supersedes the first

      vi.advanceTimersByTime(50);
      await flush();

      const posts = stub.calls.filter((c) => c.method === 'POST' && c.url === '/api/channel-strip');
      expect(posts.length).toBe(1);
      expect(posts[0].body).toEqual({ gate_threshold: -20 });
    });

    it('does not fire before 50ms elapse, fires exactly once at 50ms', async () => {
      const { win, cs } = bootFake();
      const stub = withFetch(win, [routeExact('POST', '/api/channel-strip', { ok: true })]);
      cs.stripSendConfig({ bypass: true });
      vi.advanceTimersByTime(49);
      await flush();
      expect(stub.calls.some((c) => c.method === 'POST' && c.url === '/api/channel-strip')).toBe(false);
      vi.advanceTimersByTime(1);
      await flush();
      const posts = stub.calls.filter((c) => c.method === 'POST' && c.url === '/api/channel-strip');
      expect(posts.length).toBe(1);
      expect(posts[0].body).toEqual({ bypass: true });
    });
  });

  // -------------------------------------------------------------------------
  // stripStartMetering — GET /api/channel-strip/metering every 300ms, idempotent
  // -------------------------------------------------------------------------
  describe('stripStartMetering', () => {
    it('polls every 300ms and updates the DYNAMIC compact LED/GR DOM (captured gate-LED/GR skipped)', async () => {
      const { win, doc, cs } = bootFake();
      injectStripDom(doc);
      const stub = withFetch(win, [
        routeExact('GET', '/api/channel-strip/metering', { gate: 1, comp_gain: -10 }),
      ]);

      cs.stripStartMetering();
      expect(cs.getMeteringInterval()).not.toBeNull();

      vi.advanceTimersByTime(300);
      await flush();

      const polls = stub.calls.filter((c) => c.method === 'GET' && c.url === '/api/channel-strip/metering');
      expect(polls.length).toBe(1);

      // gate > 0.5 -> compact gate LED gains ' open' (dynamic lookup)
      expect(doc.getElementById('strip-compact-gate').className).toBe('strip-led open');
      // comp_gain -10 clamped to [-20,0] -> "-10.0 dB" (dynamic lookup)
      expect(doc.getElementById('strip-compact-gr').textContent).toBe('-10.0 dB');
      // #strip-gr-value lives INSIDE the captured-null stripCompGr guard -> NOT updated
      expect(doc.getElementById('strip-gr-value').textContent).toBe('0 dB');
    });

    it('advancing 900ms yields 3 polls', async () => {
      const { win, cs } = bootFake();
      const stub = withFetch(win, [
        routeExact('GET', '/api/channel-strip/metering', { gate: 0, comp_gain: 0 }),
      ]);
      cs.stripStartMetering();
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(300);
        await flush();
      }
      const polls = stub.calls.filter((c) => c.method === 'GET' && c.url === '/api/channel-strip/metering');
      expect(polls.length).toBe(3);
    });

    it('is idempotent: a second call does NOT create a second interval handle', async () => {
      const { win, cs } = bootFake();
      withFetch(win, [routeExact('GET', '/api/channel-strip/metering', { gate: 0, comp_gain: 0 })]);
      cs.stripStartMetering();
      const handle = cs.getMeteringInterval();
      expect(handle).not.toBeNull();
      cs.stripStartMetering(); // no-op (early return on existing handle)
      expect(cs.getMeteringInterval()).toBe(handle);
    });

    it('AS-IS: a metering fetch error is swallowed (empty catch, no #error-banner)', async () => {
      const { win, doc, cs } = bootFake();
      win.fetch = () => Promise.reject(new Error('meter down'));
      cs.stripStartMetering();
      vi.advanceTimersByTime(300);
      await flush();
      expect(doc.getElementById('error-banner').classList.contains('visible')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // stripStopMetering — clears interval + resets the DYNAMIC compact/GR DOM
  // -------------------------------------------------------------------------
  describe('stripStopMetering', () => {
    it('nulls the interval handle and resets the dynamically looked-up DOM to defaults', async () => {
      const { win, doc, cs } = bootFake();
      injectStripDom(doc);
      withFetch(win, [routeExact('GET', '/api/channel-strip/metering', { gate: 1, comp_gain: -10 })]);
      cs.stripStartMetering();
      vi.advanceTimersByTime(300);
      await flush();
      // sanity: metering set the 'open' class first
      expect(doc.getElementById('strip-compact-gate').className).toBe('strip-led open');

      cs.stripStopMetering();

      expect(cs.getMeteringInterval()).toBeNull();
      expect(doc.getElementById('strip-compact-gate').className).toBe('strip-led');
      expect(doc.getElementById('strip-compact-gr').textContent).toBe('0 dB');
      // strip-gr-value IS reset here (top-level dynamic lookup, not guarded by stripCompGr)
      expect(doc.getElementById('strip-gr-value').textContent).toBe('0 dB');
    });
  });
});
