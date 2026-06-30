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
const authSrc = readFileSync(path.join(publicDir, 'auth.js'), 'utf8');
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
const channelStripSrc = readFileSync(path.join(publicDir, 'channelstrip.js'), 'utf8');
const pttSrc = readFileSync(path.join(publicDir, 'ptt.js'), 'utf8');
const restreamStatusSrc = readFileSync(path.join(publicDir, 'restreamStatus.js'), 'utf8');
const trackHistorySrc = readFileSync(path.join(publicDir, 'trackhistory.js'), 'utf8');
const navigationSrc = readFileSync(path.join(publicDir, 'navigation.js'), 'utf8');
const genericModalSrc = readFileSync(path.join(publicDir, 'genericModal.js'), 'utf8');
const notifySrc = readFileSync(path.join(publicDir, 'notify.js'), 'utf8');
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
  // (window.FRPlaylists), analytics.js (window.FRAnalytics), filemgmt.js
  // (window.FRFileMgmt), visualprofiles.js (window.FRVisualProfiles), then app.js
  // (which calls FRPlaylists.init / FRAnalytics.init / FRFileMgmt.init /
  // FRVisualProfiles.init on boot).
  dom.window.eval(utilsSrc);
  dom.window.eval(authSrc);
  dom.window.eval(playlistsSrc);
  dom.window.eval(analyticsSrc);
  dom.window.eval(fileMgmtSrc);
  dom.window.eval(visualProfilesSrc);
  dom.window.eval(scheduleSrc);
  dom.window.eval(videoPlaylistsSrc);
  dom.window.eval(platformsSrc);
  dom.window.eval(overlaysSrc);
  dom.window.eval(qualitySrc);
  dom.window.eval(enhanceSettingsSrc);
  dom.window.eval(restreamSettingsSrc);
  dom.window.eval(channelStripSrc);
  dom.window.eval(pttSrc);
  dom.window.eval(restreamStatusSrc);
  dom.window.eval(trackHistorySrc);
  dom.window.eval(navigationSrc);
  dom.window.eval(genericModalSrc);
  dom.window.eval(notifySrc);
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

/**
 * Install a controllable XMLHttpRequest stub on the jsdom `win`.
 *
 * The harness only stubs `fetch`; `uploadOneFile` uses raw XHR for its multipart
 * upload + progress bar, so without this nothing drives that path. This mirrors
 * makeFetchStub's "record every call, let the test drive the result" style.
 *
 * Each `new win.XMLHttpRequest()` is recorded in `calls` as an instance handle:
 *   { method, url, async, headers, body, upload, fireProgress(),
 *     complete(status, statusText, responseText), fail() }
 * where:
 *   - method/url/async  — captured by `.open(method, url, async)`
 *   - headers           — map captured by `.setRequestHeader(k, v)`
 *   - body              — the argument passed to `.send(body)` (a FormData)
 *   - upload            — the object app code attaches `.onprogress` to
 *   - fireProgress({loaded,total,lengthComputable}) — invokes upload.onprogress
 *   - complete(status, statusText, responseText) — sets status/statusText/responseText
 *     and invokes `.onload` (the success / 401 / non-2xx branches all run here)
 *   - fail()            — invokes `.onerror` (network-error branch)
 *
 * `.send()` does NOT auto-resolve — the test decides when/how the request ends,
 * exactly like the never-resolving fetch default. Returns { calls } — the array
 * is populated as instances are constructed (one per upload).
 */
export function installXhrStub(win) {
  const calls = [];

  class StubXHR {
    constructor() {
      this.method = null;
      this.url = null;
      this.async = true;
      this.headers = {};
      this.body = undefined;
      this.status = 0;
      this.statusText = '';
      this.responseText = '';
      this.onload = null;
      this.onerror = null;
      // app code does `xhr.upload.onprogress = ...`
      this.upload = { onprogress: null };
      calls.push(this);
    }

    open(method, url, async) {
      this.method = String(method || 'GET').toUpperCase();
      this.url = url;
      this.async = async !== false;
    }

    setRequestHeader(key, value) {
      this.headers[key] = value;
    }

    send(body) {
      this.body = body;
    }

    // --- test drivers (not part of the real XHR API) ---

    fireProgress(evt) {
      if (typeof this.upload.onprogress === 'function') {
        this.upload.onprogress(evt || {});
      }
    }

    complete(status, statusText, responseText) {
      this.status = status;
      this.statusText = statusText != null ? String(statusText) : '';
      this.responseText = responseText != null ? String(responseText) : '';
      if (typeof this.onload === 'function') this.onload();
    }

    fail() {
      if (typeof this.onerror === 'function') this.onerror();
    }
  }

  win.XMLHttpRequest = StubXHR;
  return { calls };
}

/** Flush pending microtasks/promise chains so .then() handlers run. */
export async function flush(times = 5) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}
