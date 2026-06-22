/**
 * tests/dashboard/appBoot.js
 *
 * Shared jsdom boot helper for the dashboard app.js characterization tests.
 *
 * app.js is a ~5900-LOC browser IIFE that runs heavy init immediately on load
 * (WebSocket connect, fetch, setInterval, canvas, HLS). Its functions are
 * trapped in the IIFE closure. The foundation exposes test-only guarded hooks
 * (window.__appHelpers, window.__appDrift, window.__appPlaylists) under the
 * window.__APP_TEST__ flag so tests can reach in and drive them.
 *
 * This helper boots ONE jsdom window from the REAL dashboard/public/index.html,
 * installs the minimal browser-global stubs app.js touches on boot, then
 * evaluates the REAL utils.js + app.js (the same files the browser ships) in
 * load order, with __APP_TEST__ = true.
 *
 * By default `win.fetch` is a never-resolving pending promise (matching the
 * load-smoke), so no async handler runs during the synchronous boot. Tests that
 * need to characterize CRUD/render behavior install their own controllable
 * `win.fetch` AFTER boot (see makeFetchStub).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../../dashboard/public');
const indexHtml = readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const utilsSrc = readFileSync(path.join(publicDir, 'utils.js'), 'utf8');
const playlistsSrc = readFileSync(path.join(publicDir, 'playlists.js'), 'utf8');
const appSrc = readFileSync(path.join(publicDir, 'app.js'), 'utf8');

/**
 * Install the browser-global stubs app.js touches during its synchronous init,
 * so it can evaluate top-to-bottom without a real browser. Each stub is the
 * minimal shape app.js calls on boot. Mirrors appLoad.test.js's installStubs.
 */
function installStubs(win) {
  // Mark this as a test load so app.js exposes its guarded test hooks.
  win.__APP_TEST__ = true;

  // WebSocket — app.js opens one on boot (connectWs).
  win.WebSocket = class {
    constructor() { this.readyState = 0; }
    send() {}
    close() {}
    addEventListener() {}
  };

  // fetch — auth check + initial data loads. Never resolves (stays pending) so
  // no async handler runs during the synchronous load. Tests override this.
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

/**
 * Boot one jsdom window with the real index.html + utils.js + app.js loaded in
 * order, with __APP_TEST__ = true. Returns { win, doc, loadError }.
 *
 * loadError is null on success; if app.js threw during its synchronous load it
 * is captured (so the load-smoke can still assert against it instead of the
 * whole suite blowing up).
 */
export function bootWindow() {
  const virtualConsole = new VirtualConsole();
  // Swallow page console noise; we only care about thrown errors.
  virtualConsole.on('error', () => {});

  const dom = new JSDOM(indexHtml, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://localhost/',
    virtualConsole,
  });
  const win = dom.window;
  installStubs(win);

  // Load order mirrors index.html: utils.js (window.FRUtils), playlists.js
  // (window.FRPlaylists), then app.js (which calls FRPlaylists.init on boot).
  dom.window.eval(utilsSrc);
  dom.window.eval(playlistsSrc);
  let loadError = null;
  try {
    dom.window.eval(appSrc);
  } catch (err) {
    loadError = err;
  }

  return { win, doc: win.document, loadError };
}

/**
 * Build a controllable fetch stub for post-boot characterization.
 *
 * `routes` maps a matcher to a canned JSON response (or a function
 * (url, opts) => response). A matcher is either an exact pathname string or a
 * { method, test } pair where `test(url)` returns true. The first matching
 * route wins, in insertion order.
 *
 * Every call is recorded in `calls` as { method, url, body } — body is the
 * parsed JSON when the request body is a JSON string, otherwise the raw value
 * (e.g. a FormData for multipart). Responses resolve with a minimal Response
 * shape: { ok, status, json() }.
 *
 * Returns { fetch, calls } — assign `win.fetch = fetch` after boot.
 */
export function makeFetchStub(routes) {
  const calls = [];
  const list = Array.isArray(routes) ? routes : [];

  function parseBody(body) {
    if (body == null) return undefined;
    if (typeof body === 'string') {
      try { return JSON.parse(body); } catch { return body; }
    }
    return body; // FormData, Blob, etc. — keep raw for inspection
  }

  function fetch(url, opts) {
    opts = opts || {};
    const method = (opts.method || 'GET').toUpperCase();
    const record = { method, url, body: parseBody(opts.body) };
    calls.push(record);

    let payload;
    for (const route of list) {
      if (route.match(method, url)) {
        payload = typeof route.respond === 'function' ? route.respond(url, opts) : route.respond;
        break;
      }
    }
    if (payload === undefined) payload = {};

    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload),
      text: () => Promise.resolve(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    });
  }

  return { fetch, calls };
}

/**
 * Route helper: matches on method + a substring of the URL pathname.
 * Pass `respond` as a value or a (url, opts) => value function.
 */
export function route(method, urlIncludes, respond) {
  const m = method.toUpperCase();
  return {
    respond,
    match(reqMethod, url) {
      return reqMethod === m && String(url).indexOf(urlIncludes) !== -1;
    },
  };
}

/**
 * Route helper that matches an EXACT pathname (ignores query string), method-aware.
 */
export function routeExact(method, pathname, respond) {
  const m = method.toUpperCase();
  return {
    respond,
    match(reqMethod, url) {
      if (reqMethod !== m) return false;
      const p = String(url).split('?')[0];
      return p === pathname;
    },
  };
}

/** Flush pending microtasks/promise chains so .then() handlers run. */
export async function flush(times = 5) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}
