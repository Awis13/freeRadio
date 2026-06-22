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

    // Load order mirrors index.html: utils.js (defines window.FRUtils) then app.js.
    runScript(dom, utilsSrc, 'utils.js');
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
