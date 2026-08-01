/**
 * tests/dashboard/appBoot.js
 *
 * Shared jsdom boot helper for the dashboard characterization tests.
 *
 * app.js is a browser IIFE (~580 LOC of boot substrate after the extraction
 * track, with the sibling FR* modules index.html lists alongside it) that runs
 * heavy init on load (WebSocket connect, fetch, setInterval, canvas, HLS). What is left in the
 * IIFE is trapped in its closure, so app.js exposes test-only guarded hooks
 * (window.__appHelpers, __appDrift, __appPlaylists, __appWs, __appAudio,
 * __appStudio) under the window.__APP_TEST__ flag so tests can reach in and
 * drive them. The extracted modules need no hooks — their APIs are public.
 *
 * This helper boots ONE jsdom window from the REAL dashboard/public/index.html,
 * installs the minimal browser-global stubs app.js touches on boot, then
 * evaluates the REAL sibling modules and app.js (the same files the browser
 * ships) in index.html load order, with __APP_TEST__ = true. The module list is
 * parsed out of index.html's own <script src=...> tags (see
 * parseModuleManifest), so it cannot drift from the page.
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

/** The page entry point — evaluated last, after every sibling module. */
const APP_ENTRY = 'app.js';

/**
 * Vendored third-party bundles the harness never evaluates; installStubs
 * provides their globals instead (window.Hls).
 */
const VENDOR_SRC = new Set(['/js/hls.min.js']);

/**
 * Derive the browser module manifest from the REAL index.html <script src=...>
 * tags, so the harness can never drift from what the page actually ships:
 * adding a module to index.html registers it here automatically.
 *
 * Returns file names relative to dashboard/public in index.html order, with the
 * query string (app.js?v=NNN) stripped and vendored bundles excluded. APP_ENTRY
 * is not part of the returned list — it is loaded separately, last.
 *
 * Fails loudly rather than returning an empty/entry-less manifest: booting no
 * modules would make every characterization pin pass vacuously.
 */
export function parseModuleManifest(html) {
  // Commented-out markup must not register a module. index.html escapes nested
  // comments inside its PHASE 2/3 blocks (<!~~ ... ~~>), so no comment contains
  // a literal "-->" and a non-greedy strip cannot swallow live markup.
  const live = html.replace(/<!--[\s\S]*?-->/g, '');

  const files = [];
  const scriptTag = /<script\b[^>]*\bsrc\s*=\s*["']([^"']*)["']/gi;
  let match;
  while ((match = scriptTag.exec(live)) !== null) {
    const src = match[1].split('?')[0].split('#')[0];
    if (VENDOR_SRC.has(src)) continue;
    files.push(src.replace(/^\//, ''));
  }

  const entryAt = files.indexOf(APP_ENTRY);
  if (entryAt === -1) {
    throw new Error(
      `appBoot: no <script src="/${APP_ENTRY}"> tag found in index.html — ` +
      'the entry point was renamed or the manifest parse is broken',
    );
  }
  if (entryAt !== files.length - 1) {
    throw new Error(
      `appBoot: ${APP_ENTRY} is not the last <script> tag in index.html ` +
      `(${files.length - 1 - entryAt} tag(s) follow it) — the harness evaluates ` +
      'it last, so boot order would diverge from the browser',
    );
  }

  const modules = files.slice(0, entryAt);
  if (modules.length === 0) {
    throw new Error(
      'appBoot: index.html yielded zero sibling modules — booting app.js alone ' +
      'would make the characterization pins pass vacuously',
    );
  }
  return modules;
}

/**
 * Read the global a module registers straight out of its own UMD prologue:
 *
 *     if (typeof window !== 'undefined') { window.FRUtils = api; }
 *
 * The file name is NOT a usable source for that name — filemgmt.js registers
 * FRFileMgmt, visualprofiles.js registers FRVisualProfiles, and
 * enhanceSettings.js registers FREnhance — so the module's own assignment is the
 * only honest rule. Reads (window.FRUtils.pad) do not match; only assignments do.
 */
function registeredGlobal(file, src) {
  const assignment = /window\.(FR[A-Za-z0-9_]*)\s*=[^=]/g;
  const names = new Set();
  let match;
  while ((match = assignment.exec(src)) !== null) names.add(match[1]);

  if (names.size === 0) {
    throw new Error(
      `appBoot: ${file} assigns no window.FR* global — it is listed in index.html ` +
      'but registers nothing, so nothing that depends on it could work',
    );
  }
  if (names.size > 1) {
    throw new Error(
      `appBoot: ${file} assigns more than one window.FR* global ` +
      `(${[...names].join(', ')}) — cannot tell which one proves it loaded`,
    );
  }
  return [...names][0];
}

const moduleFiles = parseModuleManifest(indexHtml);
const moduleSources = moduleFiles.map((file) => readFileSync(path.join(publicDir, file), 'utf8'));
const appSrc = readFileSync(path.join(publicDir, APP_ENTRY), 'utf8');

/**
 * The window.FR* global each manifest module is expected to publish, in the same
 * order as moduleFiles. bootWindow asserts every one of them is on the window
 * after the eval loop.
 */
const moduleGlobals = moduleFiles.map((file, i) => registeredGlobal(file, moduleSources[i]));

/**
 * The browser module manifest, exported for tests that pin the load contract
 * itself (appLoad.test.js): `files` are the index.html script sources relative
 * to dashboard/public, `globals` the window.FR* name each one registers, same
 * order, entry point excluded.
 */
export const moduleManifest = Object.freeze({
  files: Object.freeze([...moduleFiles]),
  globals: Object.freeze([...moduleGlobals]),
  entry: APP_ENTRY,
});

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
 * Boot one jsdom window with the real index.html, every manifest module and
 * app.js evaluated in index.html order, with __APP_TEST__ = true. Returns
 * { win, doc, loadError }.
 *
 * loadError is null on success; if app.js threw during its synchronous load it
 * is captured (so the load-smoke can still assert against it instead of the
 * whole suite blowing up). A module that fails to load is NOT captured — it
 * throws out of bootWindow, because every pin downstream would be meaningless.
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

  // Load order mirrors index.html tag order: every sibling FR* module first
  // (utils.js -> window.FRUtils, playlists.js -> window.FRPlaylists, ...), then
  // app.js, which calls FRPlaylists.init / FRAnalytics.init / FRFileMgmt.init /
  // FRVisualProfiles.init on boot.
  for (const src of moduleSources) {
    dom.window.eval(src);
  }

  // Every manifest module must have published its API before app.js runs: a file
  // that evaluates but registers nothing would leave app.js reading undefined,
  // and pins that never touch that module would still pass.
  const missing = moduleGlobals.filter((name) => win[name] == null);
  if (missing.length > 0) {
    throw new Error(
      `appBoot: ${missing.length} of ${moduleGlobals.length} manifest modules did not ` +
      `register their global after eval (missing: ${missing.join(', ')})`,
    );
  }

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
