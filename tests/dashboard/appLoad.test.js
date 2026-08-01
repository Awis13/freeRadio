/**
 * tests/dashboard/appLoad.test.js
 *
 * jsdom LOAD-SMOKE for dashboard/public/app.js.
 *
 * app.js is a ~580-LOC browser IIFE of boot substrate (the domain code now lives
 * in the sibling FR* modules index.html lists) that runs heavy init immediately
 * on load (WebSocket connect, fetch, setInterval, canvas, HLS). What is left in
 * the IIFE is trapped in its closure and cannot be called from outside. So
 * instead of unit-testing it, this smoke proves two things:
 *
 *   1. app.js evaluates top-to-bottom in a real DOM WITHOUT throwing — which
 *      only happens if window.FRUtils is present and the `var pad = FRU.pad`
 *      alias region resolved cleanly (a missing FRUtils or a typo'd alias would
 *      throw at the top of the IIFE before any DOM work).
 *
 *   2. The 7 helpers cut over in C2 (pad, fmtSize, cleanTrackName, escapeHtml,
 *      timeAgo, formatTime, pttFormatTime) now point at the SAME function
 *      objects exposed by window.FRUtils — asserted via the guarded
 *      window.__APP_TEST__ export (identity, ===), proving the cutover.
 *
 * The window comes from the shared harness (appBoot.bootWindow): the real
 * shipped modules + app.js, in the order index.html itself lists them, with the
 * browser globals app.js touches during init stubbed. The DOM is the real
 * dashboard/public/index.html so every getElementById() app.js runs on boot
 * finds its element. The module list is NOT restated here — appBoot derives it
 * from index.html, and moduleManifest exposes it for the load-contract pins.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { bootWindow, moduleManifest } from './appBoot.js';

describe('app.js jsdom load-smoke (C2 FRUtils cutover)', () => {
  let win;
  let loadError = null;

  beforeAll(() => {
    ({ win, loadError } = bootWindow());
  });

  it('the index.html manifest is 27 modules, each registering a distinct FR* global', () => {
    // Two independent facts the harness itself cannot catch.
    //
    // No duplicates: bootWindow only checks that each expected global is
    // PRESENT, so if two modules registered the same FR* name, the second would
    // overwrite the first and the missing-check would still be satisfied — one
    // module would silently not be loaded.
    const seen = moduleManifest.globals.filter(
      (name, i) => moduleManifest.globals.indexOf(name) !== i,
    );
    expect(seen, `duplicate FR* globals: ${seen.join(', ')}`).toEqual([]);

    // Exact count: the deliberate tripwire against the parser silently dropping
    // live <script> tags (the HTML-comment strip, or any future parse change).
    // Every other assertion in the suite is derived FROM the manifest, so only a
    // literal pins its size. Bump it consciously when a module is added or
    // removed from index.html.
    expect(moduleManifest.files.length).toBe(27);
  });

  it('utils.js exposes window.FRUtils with the 7 cut-over helpers', () => {
    expect(win.FRUtils).toBeTruthy();
    for (const name of ['pad', 'fmtSize', 'cleanTrackName', 'escapeHtml', 'timeAgo', 'formatTime', 'pttFormatTime']) {
      expect(typeof win.FRUtils[name]).toBe('function');
    }
  });

  it('app.js evaluates top-to-bottom without throwing (aliases resolved)', () => {
    // If FRUtils were missing or an alias were typo'd, the IIFE would have
    // thrown at the alias region before any DOM init.
    expect(loadError).toBeNull();
  });

  it('exposes the guarded __appHelpers test export (window.__APP_TEST__ on)', () => {
    expect(win.__appHelpers).toBeTruthy();
  });

  it('the 7 app.js helpers are the SAME objects as window.FRUtils.* (cutover proven)', () => {
    const names = ['pad', 'fmtSize', 'cleanTrackName', 'escapeHtml', 'timeAgo', 'formatTime', 'pttFormatTime'];
    for (const name of names) {
      expect(win.__appHelpers[name]).toBe(win.FRUtils[name]);
    }
  });
});

/**
 * C3 drift-gate characterization: the 4 helpers that DIVERGED from their FRUtils
 * twins (computeMixDur, getBroadcastPhase, uniquePlatformName, deriveUiMode) were
 * cut over to thin delegations that pass the closure value. The canonical LOGIC
 * is already pinned in utils.test.js against FRUtils. These tests pin the WIRING
 * through the REAL app.js: that each delegation forwards the right closure value,
 * and that deriveUiMode keeps mutating broadcastState in place (AS-IS).
 *
 * Driven via the guarded window.__appDrift hook (inert in production).
 */
describe('app.js drift-gate (C3 FRUtils delegation of the 4 diverged helpers)', () => {
  let win;
  let drift;

  beforeAll(() => {
    // A second, independent window: the delegation tests mutate broadcastState
    // and swap FRUtils members, so they must not run against the smoke's window.
    // This block asserts app.js loaded by reaching through __appDrift, so an
    // app.js load failure surfaces there rather than being captured here.
    ({ win } = bootWindow());
    drift = win.__appDrift;
  });

  it('the guarded __appDrift hook populated (all 4 functions + handles present)', () => {
    expect(drift).toBeTruthy();
    expect(typeof drift.computeMixDur).toBe('function');
    expect(typeof drift.getBroadcastPhase).toBe('function');
    expect(typeof drift.uniquePlatformName).toBe('function');
    expect(typeof drift.deriveUiMode).toBe('function');
    expect(drift.broadcastState).toBeTruthy();
    expect(typeof drift.setMixMode).toBe('function');
    expect(typeof drift.setPlatformNames).toBe('function');
  });

  it('getBroadcastState seam returns the live broadcastState (no-op getter, stable identity)', () => {
    expect(typeof drift.getBroadcastState).toBe('function');
    expect(drift.getBroadcastState()).toBe(drift.broadcastState);
  });

  it('getMixMode seam returns smart on boot (matches currentMixMode initial value)', () => {
    expect(typeof drift.getMixMode).toBe('function');
    expect(drift.getMixMode()).toBe('smart');
  });

  it('getMixMode seam reflects the live var — after setMixMode cut, getMixMode returns cut', () => {
    drift.setMixMode('cut');
    expect(drift.getMixMode()).toBe('cut');
    drift.setMixMode('smart'); // restore for sibling tests
  });

  describe('computeMixDur (delegates with currentMixMode)', () => {
    it("mixMode 'cut' → 0", () => {
      drift.setMixMode('cut');
      expect(drift.computeMixDur(128)).toBe(0);
    });

    it("mixMode 'crossfade' → 5.0", () => {
      drift.setMixMode('crossfade');
      expect(drift.computeMixDur(128)).toBe(5.0);
    });

    it('smart mode with a bpm → matches the FRUtils computation', () => {
      drift.setMixMode('smart');
      expect(drift.computeMixDur(120)).toBe(win.FRUtils.computeMixDur(120, 'smart'));
    });

    it('smart mode with no bpm → 10.0 default', () => {
      drift.setMixMode('smart');
      expect(drift.computeMixDur(0)).toBe(10.0);
    });

    it('forwards currentMixMode as the 2nd arg to FRUtils.computeMixDur', () => {
      drift.setMixMode('cut');
      const orig = win.FRUtils.computeMixDur;
      const calls = [];
      win.FRUtils.computeMixDur = (bpm, mode) => { calls.push([bpm, mode]); return 42; };
      try {
        const out = drift.computeMixDur(99);
        expect(out).toBe(42);
        expect(calls).toEqual([[99, 'cut']]);
      } finally {
        win.FRUtils.computeMixDur = orig;
      }
    });
  });

  describe('getBroadcastPhase (delegates with broadcastState) — full phase table AS-IS', () => {
    function setState(patch) {
      Object.assign(drift.broadcastState, {
        arming: false, streamMode: 'standby', broadcast: false,
      }, patch);
    }

    it("arming → 'arming'", () => {
      setState({ arming: true });
      expect(drift.getBroadcastPhase()).toBe('arming');
    });

    it("armed + !broadcast → 'armed'", () => {
      setState({ streamMode: 'armed', broadcast: false });
      expect(drift.getBroadcastPhase()).toBe('armed');
    });

    it("armed + broadcast → 'broadcasting'", () => {
      setState({ streamMode: 'armed', broadcast: true });
      expect(drift.getBroadcastPhase()).toBe('broadcasting');
    });

    it("live + !broadcast → 'playing'", () => {
      setState({ streamMode: 'live', broadcast: false });
      expect(drift.getBroadcastPhase()).toBe('playing');
    });

    it("live + broadcast → 'live'", () => {
      setState({ streamMode: 'live', broadcast: true });
      expect(drift.getBroadcastPhase()).toBe('live');
    });

    it("else (standby) → 'idle'", () => {
      setState({ streamMode: 'standby' });
      expect(drift.getBroadcastPhase()).toBe('idle');
    });
  });

  describe('uniquePlatformName (delegates with currentPlatformNames)', () => {
    it('empty names → base unchanged', () => {
      drift.setPlatformNames([]);
      expect(drift.uniquePlatformName('YouTube')).toBe('YouTube');
    });

    it("collision → 'base 2'", () => {
      drift.setPlatformNames(['YouTube']);
      expect(drift.uniquePlatformName('YouTube')).toBe('YouTube 2');
    });

    it("base + 2..99 all taken → 'base <timestamp>' (prefix only, ts not pinned)", () => {
      const names = ['YouTube'];
      for (let i = 2; i <= 99; i++) names.push('YouTube ' + i);
      drift.setPlatformNames(names);
      expect(drift.uniquePlatformName('YouTube')).toMatch(/^YouTube \d+$/);
    });
  });

  describe('deriveUiMode (delegates, then MUTATES broadcastState AS-IS)', () => {
    it("visualMode 'live' → mutates to {uiMode:'takeover', uiSubMode:'obs'} and returns undefined", () => {
      drift.broadcastState.visualMode = 'live';
      drift.broadcastState.uiMode = 'dirty';
      drift.broadcastState.uiSubMode = 'dirty';
      const ret = drift.deriveUiMode();
      expect(ret).toBeUndefined();
      expect(drift.broadcastState.uiMode).toBe('takeover');
      expect(drift.broadcastState.uiSubMode).toBe('obs');
    });

    it("other visualMode → mutates to {uiMode:'radio', uiSubMode: vm}", () => {
      drift.broadcastState.visualMode = 'video-playlist';
      drift.deriveUiMode();
      expect(drift.broadcastState.uiMode).toBe('radio');
      expect(drift.broadcastState.uiSubMode).toBe('video-playlist');
    });

    it("falsy visualMode → uiSubMode falls back to 'visual-radio'", () => {
      drift.broadcastState.visualMode = '';
      drift.deriveUiMode();
      expect(drift.broadcastState.uiMode).toBe('radio');
      expect(drift.broadcastState.uiSubMode).toBe('visual-radio');
    });
  });
});
