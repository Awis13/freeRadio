/**
 * tests/dashboard/enhanceUI.test.js
 *
 * Characterization pins for the audio/video enhancement-settings cluster — two
 * structural-twin domains still inline in the app.js IIFE (current app.js
 * ~2210-2278). These tests pin the AS-IS observable contract so the C2
 * extraction into dashboard/public/enhanceSettings.js (window.FREnhance) can be
 * proven behaviourally equivalent: authored in C1 against app.js via the
 * window.__appEnhance hook, re-pointed in C2 to the module with assertions
 * UNCHANGED.
 *
 * Cluster (twins, byte-identical except the audio/video word):
 *   - loadAudioSettings()  GET /api/audio -> #audio-enhance.checked = (data.enhanced===true)
 *   - #audio-enhance.onchange POST /api/audio body {enhanced:<checked>} -> log on data.success
 *   - loadVideoSettings()  GET /api/video -> #video-enhance.checked = (data.enhanced===true)
 *   - #video-enhance.onchange POST /api/video body {enhanced:<checked>} -> log on data.success
 *
 * AS-IS quirks pinned here (flagged for the C2 extraction):
 *   - GET checkbox set is STRICT data.enhanced===true; a truthy-but-non-true
 *     value (e.g. "true", 1) yields checked=false.
 *   - POST body key is exactly {enhanced:<boolean>} (the local var is named
 *     `enabled`, but the JSON key is `enhanced`), Content-Type application/json.
 *   - the ENABLED/DISABLED log line is gated on data.success (truthy); onchange
 *     success has NO DOM/banner effect, only a log line (#log).
 *   - the LOAD failure path uses log() only (no #error-banner); the ONCHANGE
 *     failure path uses showError() (#error-banner visible).
 *   - if the checkbox is absent the loader is a no-op and onchange is never bound.
 *
 * The hook (window.__appEnhance) holds the REAL closure fns + the REAL deps
 * (authFetch -> win.fetch, log -> #log, showError -> #error-banner). The only
 * backend control is replacing the boot's never-resolving win.fetch with a
 * recording makeFetchStub AFTER boot, then driving the loaders / the real DOM
 * checkbox onchange and asserting DOM (in `doc`) + recorded fetches (stub.calls).
 */

import { describe, it, expect } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, flush } from './appBoot.js';

/** Boot a fresh window and grab the enhancement hook. */
function boot() {
  const { win, doc } = bootWindow();
  const enh = win.__appEnhance;
  return { win, doc, enh };
}

/** Install a recording fetch stub (replacing the never-resolving boot fetch). */
function withFetch(win, routes) {
  const stub = makeFetchStub(routes);
  win.fetch = stub.fetch;
  return stub;
}

// Each twin is exercised by the same matrix, parameterized only by the
// audio/video word, endpoint, checkbox id, and log prefix.
const TWINS = [
  {
    label: 'audio',
    load: 'loadAudioSettings',
    getCheck: 'getAudioEnhanceCheck',
    path: '/api/audio',
    checkboxId: 'audio-enhance',
    failMsg: 'Audio settings change failed:',
  },
  {
    label: 'video',
    load: 'loadVideoSettings',
    getCheck: 'getVideoEnhanceCheck',
    path: '/api/video',
    checkboxId: 'video-enhance',
    failMsg: 'Video settings change failed:',
  },
];

describe('enhancement-settings UI characterization (window.__appEnhance)', () => {
  it('exposes the two loaders + the two checkbox accessors', () => {
    const { enh } = boot();
    expect(enh).toBeTruthy();
    for (const fn of [
      'loadAudioSettings', 'loadVideoSettings',
      'getAudioEnhanceCheck', 'getVideoEnhanceCheck',
    ]) {
      expect(typeof enh[fn]).toBe('function');
    }
  });

  it('the accessors return the exact #audio-enhance / #video-enhance nodes app.js bound', () => {
    const { doc, enh } = boot();
    expect(enh.getAudioEnhanceCheck()).toBe(doc.getElementById('audio-enhance'));
    expect(enh.getVideoEnhanceCheck()).toBe(doc.getElementById('video-enhance'));
  });

  for (const t of TWINS) {
    describe(`${t.label} twin`, () => {
      // -------------------------------------------------------------------
      // GET loader -> checkbox.checked
      // -------------------------------------------------------------------
      describe(`${t.load} (GET ${t.path})`, () => {
        it(`enhanced:true -> #${t.checkboxId}.checked = true`, async () => {
          const { win, doc, enh } = boot();
          const stub = withFetch(win, [
            routeExact('GET', t.path, { enhanced: true }),
          ]);
          enh[t.load]();
          await flush();

          expect(stub.calls.some((c) => c.method === 'GET' && c.url === t.path)).toBe(true);
          expect(doc.getElementById(t.checkboxId).checked).toBe(true);
        });

        it(`enhanced:false -> #${t.checkboxId}.checked = false`, async () => {
          const { win, doc, enh } = boot();
          // pre-set the box on so we can observe it being cleared
          doc.getElementById(t.checkboxId).checked = true;
          withFetch(win, [routeExact('GET', t.path, { enhanced: false })]);
          enh[t.load]();
          await flush();
          expect(doc.getElementById(t.checkboxId).checked).toBe(false);
        });

        it('AS-IS: strict ===true — a truthy-but-non-true enhanced yields checked=false', async () => {
          const { win, doc, enh } = boot();
          doc.getElementById(t.checkboxId).checked = true;
          // string "true" is truthy but !== true
          withFetch(win, [routeExact('GET', t.path, { enhanced: 'true' })]);
          enh[t.load]();
          await flush();
          expect(doc.getElementById(t.checkboxId).checked).toBe(false);
        });

        it('AS-IS: load error path uses log() (no #error-banner)', async () => {
          const { win, doc, enh } = boot();
          win.fetch = () => Promise.reject(new Error('boom'));
          enh[t.load]();
          await flush();
          const banner = doc.getElementById('error-banner');
          expect(banner.classList.contains('visible')).toBe(false);
        });
      });

      // -------------------------------------------------------------------
      // checkbox.onchange -> POST
      // -------------------------------------------------------------------
      describe(`#${t.checkboxId}.onchange (POST ${t.path})`, () => {
        it(`checked=true -> POST body {enhanced:true} with Content-Type application/json`, async () => {
          const { win, doc } = boot();
          const stub = withFetch(win, [routeExact('POST', t.path, { success: true })]);
          const box = doc.getElementById(t.checkboxId);
          box.checked = true;
          box.onchange();
          await flush();

          const post = stub.calls.find((c) => c.method === 'POST' && c.url === t.path);
          expect(post).toBeTruthy();
          // body key is exactly `enhanced` (NOT `enabled`), mirroring the checkbox
          expect(post.body).toEqual({ enhanced: true });
        });

        it('checked=false -> POST body {enhanced:false}', async () => {
          const { win, doc } = boot();
          const stub = withFetch(win, [routeExact('POST', t.path, { success: true })]);
          const box = doc.getElementById(t.checkboxId);
          box.checked = false;
          box.onchange();
          await flush();

          const post = stub.calls.find((c) => c.method === 'POST' && c.url === t.path);
          expect(post).toBeTruthy();
          expect(post.body).toEqual({ enhanced: false });
        });

        it('success log gated on data.success — success:true logs ENABLED, no banner', async () => {
          const { win, doc } = boot();
          withFetch(win, [routeExact('POST', t.path, { success: true })]);
          const box = doc.getElementById(t.checkboxId);
          box.checked = true;
          box.onchange();
          await flush();

          // log line lands in #log; no banner on success
          expect(doc.getElementById('log').textContent).toContain(t.label + ': enhancement ENABLED');
          expect(doc.getElementById('error-banner').classList.contains('visible')).toBe(false);
        });

        it('success:false -> POST fired but NO ENABLED/DISABLED log line', async () => {
          const { win, doc } = boot();
          const stub = withFetch(win, [routeExact('POST', t.path, { success: false })]);
          const box = doc.getElementById(t.checkboxId);
          box.checked = true;
          box.onchange();
          await flush();

          expect(stub.calls.some((c) => c.method === 'POST' && c.url === t.path)).toBe(true);
          expect(doc.getElementById('log').textContent).not.toContain(t.label + ': enhancement ENABLED');
        });

        it('onchange error path -> showError writes #error-banner', async () => {
          const { win, doc } = boot();
          win.fetch = () => Promise.reject(new Error('nope'));
          const box = doc.getElementById(t.checkboxId);
          box.checked = true;
          box.onchange();
          await flush();

          const banner = doc.getElementById('error-banner');
          expect(banner.classList.contains('visible')).toBe(true);
          expect(banner.textContent).toContain(t.failMsg);
        });
      });
    });
  }
});
