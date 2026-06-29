/**
 * tests/dashboard/appLoad.test.js
 *
 * jsdom LOAD-SMOKE for dashboard/public/app.js.
 *
 * app.js is a ~5900-LOC browser IIFE that runs heavy init immediately on load
 * (WebSocket connect, fetch, setInterval, canvas, HLS). Its functions are
 * trapped in the IIFE closure and cannot be called from outside. So instead of
 * unit-testing them, this smoke proves two things:
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
 * The real shipped utils.js + app.js are loaded (the same files the browser
 * ships) into one jsdom window, after stubbing the browser globals app.js
 * touches during init. The DOM is the real dashboard/public/index.html so every
 * getElementById() app.js runs on boot finds its element.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../../dashboard/public');
const indexHtml = readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const utilsSrc = readFileSync(path.join(publicDir, 'utils.js'), 'utf8');
const playlistsSrc = readFileSync(path.join(publicDir, 'playlists.js'), 'utf8');
const analyticsSrc = readFileSync(path.join(publicDir, 'analytics.js'), 'utf8');
const fileMgmtSrc = readFileSync(path.join(publicDir, 'filemgmt.js'), 'utf8');
const visualProfilesSrc = readFileSync(path.join(publicDir, 'visualprofiles.js'), 'utf8');
const scheduleSrc = readFileSync(path.join(publicDir, 'schedule.js'), 'utf8');
const videoPlaylistsSrc = readFileSync(path.join(publicDir, 'videoplaylists.js'), 'utf8');
const platformsSrc = readFileSync(path.join(publicDir, 'platforms.js'), 'utf8');
const overlaysSrc = readFileSync(path.join(publicDir, 'overlays.js'), 'utf8');
const qualitySrc = readFileSync(path.join(publicDir, 'quality.js'), 'utf8');
const enhanceSettingsSrc = readFileSync(path.join(publicDir, 'enhanceSettings.js'), 'utf8');
const restreamSettingsSrc = readFileSync(path.join(publicDir, 'restreamSettings.js'), 'utf8');
const appSrc = readFileSync(path.join(publicDir, 'app.js'), 'utf8');

/**
 * Install the browser-global stubs app.js touches during its synchronous init,
 * so it can evaluate top-to-bottom without a real browser. Each stub is the
 * minimal shape app.js calls on boot.
 */
function installStubs(win) {
  // Mark this as a test load so app.js exposes its guarded __appHelpers export.
  win.__APP_TEST__ = true;

  // WebSocket — app.js opens one on boot (connectWs).
  win.WebSocket = class {
    constructor() { this.readyState = 0; }
    send() {}
    close() {}
    addEventListener() {}
  };

  // fetch — auth check + initial data loads. Never resolves (stays pending) so
  // no async handler runs during the synchronous load we are measuring.
  win.fetch = () => new Promise(() => {});

  // HLS player library (normally /js/hls.min.js). app.js feature-detects it.
  win.Hls = function () {};
  win.Hls.isSupported = () => false;

  // Web Audio — FFT analyzer setup.
  win.AudioContext = class {
    createAnalyser() {
      return { fftSize: 0, frequencyBinCount: 0, connect() {}, getByteFrequencyData() {} };
    }
    createMediaElementSource() { return { connect() {} }; }
    createGain() { return { gain: {}, connect() {} }; }
  };
  win.webkitAudioContext = win.AudioContext;

  // rAF — animation loops. No-op (never actually paints in the smoke).
  win.requestAnimationFrame = () => 0;
  win.cancelAnimationFrame = () => {};

  // HTMLMediaElement.play() — jsdom leaves it returning undefined, but app.js
  // chains .then()/.catch() on it during player init. Return a settled promise.
  win.HTMLMediaElement.prototype.play = () => Promise.resolve();
  win.HTMLMediaElement.prototype.pause = () => {};
  win.HTMLMediaElement.prototype.load = () => {};

  // navigator.mediaDevices — PTT mic access (feature-detected only on boot).
  if (!win.navigator.mediaDevices) {
    Object.defineProperty(win.navigator, 'mediaDevices', {
      value: { getUserMedia: () => new Promise(() => {}) },
      configurable: true,
    });
  }

  // Canvas 2D context — analyzer / waveform drawing.
  win.HTMLCanvasElement.prototype.getContext = () => ({
    fillRect() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() {}, fill() {}, arc() {}, save() {}, restore() {}, translate() {},
    scale() {}, createLinearGradient() { return { addColorStop() {} }; },
    fillText() {}, measureText() { return { width: 0 }; },
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {}, set font(_v) {},
  });
}

/** Evaluate a script source string in the jsdom window's global scope. */
function runScript(dom, src, label) {
  dom.window.eval(src);
  return label;
}

describe('app.js jsdom load-smoke (C2 FRUtils cutover)', () => {
  let win;
  let loadError = null;

  beforeAll(() => {
    const virtualConsole = new VirtualConsole();
    // Swallow page console noise; we only care about thrown errors.
    virtualConsole.on('error', () => {});

    const dom = new JSDOM(indexHtml, {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      url: 'http://localhost/',
      virtualConsole,
    });
    win = dom.window;
    installStubs(win);

    // Load order mirrors index.html: utils.js (window.FRUtils), playlists.js
    // (window.FRPlaylists), analytics.js (window.FRAnalytics), filemgmt.js
    // (window.FRFileMgmt), then app.js (which calls FRPlaylists.init /
    // FRAnalytics.init / FRFileMgmt.init on boot).
    runScript(dom, utilsSrc, 'utils.js');
    runScript(dom, playlistsSrc, 'playlists.js');
    runScript(dom, analyticsSrc, 'analytics.js');
    runScript(dom, fileMgmtSrc, 'filemgmt.js');
    runScript(dom, visualProfilesSrc, 'visualprofiles.js');
    runScript(dom, scheduleSrc, 'schedule.js');
    runScript(dom, videoPlaylistsSrc, 'videoplaylists.js');
    runScript(dom, platformsSrc, 'platforms.js');
    runScript(dom, overlaysSrc, 'overlays.js');
    runScript(dom, qualitySrc, 'quality.js');
    runScript(dom, enhanceSettingsSrc, 'enhanceSettings.js');
    runScript(dom, restreamSettingsSrc, 'restreamSettings.js');
    try {
      runScript(dom, appSrc, 'app.js');
    } catch (err) {
      loadError = err;
    }
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
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('error', () => {});

    const dom = new JSDOM(indexHtml, {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      url: 'http://localhost/',
      virtualConsole,
    });
    win = dom.window;
    installStubs(win);

    runScript(dom, utilsSrc, 'utils.js');
    runScript(dom, playlistsSrc, 'playlists.js');
    runScript(dom, analyticsSrc, 'analytics.js');
    runScript(dom, fileMgmtSrc, 'filemgmt.js');
    runScript(dom, visualProfilesSrc, 'visualprofiles.js');
    runScript(dom, scheduleSrc, 'schedule.js');
    runScript(dom, videoPlaylistsSrc, 'videoplaylists.js');
    runScript(dom, platformsSrc, 'platforms.js');
    runScript(dom, overlaysSrc, 'overlays.js');
    runScript(dom, qualitySrc, 'quality.js');
    runScript(dom, enhanceSettingsSrc, 'enhanceSettings.js');
    runScript(dom, restreamSettingsSrc, 'restreamSettings.js');
    runScript(dom, appSrc, 'app.js');
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
