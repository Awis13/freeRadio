/**
 * tests/dashboard/overlaysUI.test.js
 *
 * Characterization pins for the OVERLAYS config UI cluster, currently living in
 * the app.js IIFE (app.js:1320-1512). These tests pin the AS-IS observable
 * contract of the overlay domain functions. They are authored in C1 against the
 * code in app.js (driven via the window.__appOverlays test hook) and will be
 * re-pointed in C2 to the extracted module (window.FROverlays) with assertions
 * UNCHANGED to prove behavioural equivalence.
 *
 * This domain has NO init/dependency-injection surface in C1: window.__appOverlays
 * holds the REAL closure fns, which use the REAL deps (authFetch -> win.fetch,
 * log, showError, escapeHtml = FRUtils.escapeHtml, fmtSize = FRUtils.fmtSize,
 * openGenericModal/closeGenericModal). The only backend control is replacing the
 * boot's never-resolving win.fetch with a recording makeFetchStub AFTER boot,
 * then calling the hook fns / clicking the real DOM and asserting DOM (in `doc`)
 * + recorded fetches (stub.calls).
 *
 * Functions pinned (current app.js lines ~1320-1512):
 *   - loadOverlays()            GET /api/overlays -> set checkbox + renderOverlayLayers
 *   - renderOverlayLayers()     builds .overlay-layer rows from overlayConfig.layers
 *   - saveOverlays()            PUT /api/overlays body = JSON.stringify(overlayConfig)
 *   - loadOverlayAssets()       GET /api/overlays/assets -> .overlay-asset-item rows
 *   - window.toggleOverlayLayer / updateOverlayLayer / removeOverlayLayer
 *   - #add-overlay-btn          generic modal -> push typed layer + saveOverlays
 *
 * AS-IS quirks pinned here (flagged for the C2 extraction — NEVER normalize):
 *   - loadOverlays' error path uses log() only (NO #error-banner).
 *   - saveOverlays' error path uses showError() (#error-banner visible).
 *   - loadOverlayAssets' error path is a SILENT .catch(){} noop (no DOM surface).
 *   - GET /api/overlays returns an OBJECT {enabled,layers}; GET /api/overlays/assets
 *     returns a BARE ARRAY of {name,size}.
 *   - renderOverlayLayers re-adds container.addEventListener('change',...) on every
 *     call (listeners accumulate) — pin the update behaviour, not the listener count.
 *   - add-overlay-btn builds id 'ol_'+Date.now() (non-deterministic) — pin type +
 *     type-specific defaults, not the literal id.
 */

import { describe, it, expect } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, route, flush } from './appBoot.js';

/**
 * Boot a fresh window and grab the overlays hook. No init/deps to inject — the
 * hook fns are the real closure fns; tests control only win.fetch.
 */
function boot() {
  const { win, doc } = bootWindow();
  const ov = win.FROverlays;
  return { win, doc, ov };
}

/** Install a recording fetch stub (replacing the never-resolving boot fetch). */
function withFetch(win, routes) {
  const stub = makeFetchStub(routes);
  win.fetch = stub.fetch;
  return stub;
}

describe('overlays UI characterization (window.FROverlays)', () => {
  it('exposes the cluster fns + overlayConfig getter/setter', () => {
    const { ov } = boot();
    expect(ov).toBeTruthy();
    for (const fn of [
      'loadOverlays', 'renderOverlayLayers', 'saveOverlays', 'loadOverlayAssets',
      'toggleOverlayLayer', 'updateOverlayLayer', 'removeOverlayLayer',
      'getOverlayConfig', 'setOverlayConfig',
    ]) {
      expect(typeof ov[fn]).toBe('function');
    }
  });

  // -------------------------------------------------------------------------
  // loadOverlays -> checkbox + renderOverlayLayers
  // -------------------------------------------------------------------------
  describe('loadOverlays', () => {
    it('GET /api/overlays -> sets enabled checkbox, stores config, renders layers', async () => {
      const { win, doc, ov } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/overlays', {
          enabled: true,
          layers: [{ type: 'clock', enabled: true }],
        }),
      ]);
      ov.loadOverlays();
      await flush();

      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/overlays')).toBe(true);
      expect(doc.getElementById('overlays-enabled-check').checked).toBe(true);
      expect(ov.getOverlayConfig()).toEqual({ enabled: true, layers: [{ type: 'clock', enabled: true }] });
      expect(doc.getElementById('overlay-layers').querySelectorAll('.overlay-layer').length).toBe(1);
    });

    it('AS-IS: load error path uses log() (no #error-banner)', async () => {
      const { win, doc, ov } = boot();
      win.fetch = () => Promise.reject(new Error('boom'));
      ov.loadOverlays();
      await flush();
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // renderOverlayLayers — driven directly
  // -------------------------------------------------------------------------
  describe('renderOverlayLayers', () => {
    it('clears container and renders one .overlay-layer per layer with the type badge', () => {
      const { doc, ov } = boot();
      ov.setOverlayConfig({ enabled: false, layers: [
        { type: 'clock', enabled: true },
        { type: 'logo', enabled: true },
      ] });
      ov.renderOverlayLayers();
      const rows = doc.getElementById('overlay-layers').querySelectorAll('.overlay-layer');
      expect(rows.length).toBe(2);
      expect(rows[0].querySelector('.overlay-type-badge').textContent).toBe('clock');
      expect(rows[1].querySelector('.overlay-type-badge').textContent).toBe('logo');
    });

    it('disabled layer gets " disabled" class + unchecked checkbox; enabled does not', () => {
      const { doc, ov } = boot();
      ov.setOverlayConfig({ enabled: false, layers: [
        { type: 'clock', enabled: true },
        { type: 'clock', enabled: false },
      ] });
      ov.renderOverlayLayers();
      const rows = doc.getElementById('overlay-layers').querySelectorAll('.overlay-layer');
      expect(rows[0].className).toBe('overlay-layer');
      expect(rows[1].className).toBe('overlay-layer disabled');
      const checks = doc.getElementById('overlay-layers').querySelectorAll('.overlay-layer-header input[type="checkbox"]');
      expect(checks[0].checked).toBe(true);
      expect(checks[1].checked).toBe(false);
    });

    it('text-type body renders Text/Speed/Format conditionals + pos grid defaults', () => {
      const { doc, ov } = boot();
      ov.setOverlayConfig({ enabled: false, layers: [{ type: 'scrolling_text', enabled: true }] });
      ov.renderOverlayLayers();
      const body = doc.getElementById('overlay-layers').querySelector('.overlay-layer-body');
      const props = body.querySelector('.overlay-props');
      expect(props).toBeTruthy();
      // Text input present for scrolling_text
      const text = props.querySelector('input[data-prop="text"]');
      expect(text).toBeTruthy();
      // Speed input present (isScrolling) defaulting to 100
      const speed = props.querySelector('input[data-prop="speed"]');
      expect(speed).toBeTruthy();
      expect(speed.value).toBe('100');
      expect(speed.getAttribute('data-parse')).toBe('int');
      // pos grid defaults
      const grid = body.querySelector('.overlay-pos-grid');
      expect(grid.querySelector('input[data-prop="fontsize"]').value).toBe('28');
      expect(grid.querySelector('input[data-prop="fontcolor"]').value).toBe('white');
      expect(grid.querySelector('input[data-prop="x"]').value).toBe('20');
      expect(grid.querySelector('input[data-prop="y"]').value).toBe('20');
      // box color input with placeholder
      const box = body.querySelector('input[data-prop="boxcolor"]');
      expect(box.getAttribute('placeholder')).toBe('black@0.6');
    });

    it('clock body renders a Format input defaulting to %H:%M', () => {
      const { doc, ov } = boot();
      ov.setOverlayConfig({ enabled: false, layers: [{ type: 'clock', enabled: true }] });
      ov.renderOverlayLayers();
      const fmt = doc.getElementById('overlay-layers').querySelector('input[data-prop="format"]');
      expect(fmt).toBeTruthy();
      expect(fmt.value).toBe('%H:%M');
    });

    it('scrolling_now_playing body shows the "Current track (auto)" secondary span, no Text input', () => {
      const { doc, ov } = boot();
      ov.setOverlayConfig({ enabled: false, layers: [{ type: 'scrolling_now_playing', enabled: true }] });
      ov.renderOverlayLayers();
      const body = doc.getElementById('overlay-layers').querySelector('.overlay-layer-body');
      expect(body.querySelector('.text-secondary').textContent).toBe('Current track (auto)');
      expect(body.querySelector('input[data-prop="text"]')).toBeNull();
    });

    it('logo body renders an Asset input + X default W-w-20 / Y default 20', () => {
      const { doc, ov } = boot();
      ov.setOverlayConfig({ enabled: false, layers: [{ type: 'logo', enabled: true }] });
      ov.renderOverlayLayers();
      const body = doc.getElementById('overlay-layers').querySelector('.overlay-layer-body');
      const asset = body.querySelector('input[data-prop="asset"]');
      expect(asset).toBeTruthy();
      expect(asset.getAttribute('placeholder')).toBe('logo.png');
      expect(body.querySelector('input[data-prop="x"]').value).toBe('W-w-20');
      expect(body.querySelector('input[data-prop="y"]').value).toBe('20');
    });

    it('AS-IS: unknown layer type -> empty body', () => {
      const { doc, ov } = boot();
      ov.setOverlayConfig({ enabled: false, layers: [{ type: 'mystery', enabled: true }] });
      ov.renderOverlayLayers();
      const body = doc.getElementById('overlay-layers').querySelector('.overlay-layer-body');
      expect(body.innerHTML).toBe('');
    });

    it('escapes the layer type in the badge', () => {
      const { doc, ov } = boot();
      ov.setOverlayConfig({ enabled: false, layers: [{ type: '<x>', enabled: true }] });
      ov.renderOverlayLayers();
      const badge = doc.getElementById('overlay-layers').querySelector('.overlay-type-badge');
      expect(badge.textContent).toBe('<x>');
      expect(badge.innerHTML).toBe('&lt;x&gt;');
    });

    it('row checkbox change -> toggleOverlayLayer -> mutates config.enabled + PUTs', async () => {
      const { win, doc, ov } = boot();
      const stub = withFetch(win, [routeExact('PUT', '/api/overlays', {})]);
      ov.setOverlayConfig({ enabled: false, layers: [{ type: 'clock', enabled: true }] });
      ov.renderOverlayLayers();
      const check = doc.getElementById('overlay-layers').querySelector('.overlay-layer-header input[type="checkbox"]');
      check.checked = false;
      check.dispatchEvent(new win.Event('change'));
      await flush();
      expect(ov.getOverlayConfig().layers[0].enabled).toBe(false);
      const put = stub.calls.find((c) => c.method === 'PUT' && c.url === '/api/overlays');
      expect(put).toBeTruthy();
      expect(put.body.layers[0].enabled).toBe(false);
    });

    it('row .file-del click -> removeOverlayLayer -> splices, PUTs, re-renders', async () => {
      const { win, doc, ov } = boot();
      const stub = withFetch(win, [routeExact('PUT', '/api/overlays', {})]);
      ov.setOverlayConfig({ enabled: false, layers: [
        { type: 'clock', enabled: true },
        { type: 'logo', enabled: true },
      ] });
      ov.renderOverlayLayers();
      const delBtn = doc.getElementById('overlay-layers').querySelector('.overlay-layer-header button.file-del');
      delBtn.dispatchEvent(new win.Event('click'));
      await flush();
      expect(ov.getOverlayConfig().layers.length).toBe(1);
      expect(ov.getOverlayConfig().layers[0].type).toBe('logo');
      expect(stub.calls.some((c) => c.method === 'PUT' && c.url === '/api/overlays')).toBe(true);
      // re-rendered: now one row
      expect(doc.getElementById('overlay-layers').querySelectorAll('.overlay-layer').length).toBe(1);
    });

    it('input[data-layer] change delegation -> updateOverlayLayer with parsed value + PUT', async () => {
      const { win, doc, ov } = boot();
      const stub = withFetch(win, [routeExact('PUT', '/api/overlays', {})]);
      ov.setOverlayConfig({ enabled: false, layers: [{ type: 'clock', enabled: true }] });
      ov.renderOverlayLayers();
      // fontsize input carries data-parse="int"
      const fontsize = doc.getElementById('overlay-layers').querySelector('input[data-prop="fontsize"]');
      fontsize.value = '42';
      fontsize.dispatchEvent(new win.Event('change', { bubbles: true }));
      await flush();
      expect(ov.getOverlayConfig().layers[0].fontsize).toBe(42); // int-parsed
      // a non-int field stays a string
      const color = doc.getElementById('overlay-layers').querySelector('input[data-prop="fontcolor"]');
      color.value = 'red';
      color.dispatchEvent(new win.Event('change', { bubbles: true }));
      await flush();
      expect(ov.getOverlayConfig().layers[0].fontcolor).toBe('red');
      expect(stub.calls.filter((c) => c.method === 'PUT' && c.url === '/api/overlays').length).toBeGreaterThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------------
  // toggle / update / remove window globals — driven directly
  // -------------------------------------------------------------------------
  describe('toggle/update/remove globals', () => {
    it('toggleOverlayLayer sets enabled and PUTs', async () => {
      const { win, ov } = boot();
      const stub = withFetch(win, [routeExact('PUT', '/api/overlays', {})]);
      ov.setOverlayConfig({ enabled: false, layers: [{ type: 'clock', enabled: true }] });
      ov.toggleOverlayLayer(0, false);
      await flush();
      expect(ov.getOverlayConfig().layers[0].enabled).toBe(false);
      expect(stub.calls.some((c) => c.method === 'PUT' && c.url === '/api/overlays')).toBe(true);
    });

    it('updateOverlayLayer sets the prop and PUTs', async () => {
      const { win, ov } = boot();
      const stub = withFetch(win, [routeExact('PUT', '/api/overlays', {})]);
      ov.setOverlayConfig({ enabled: false, layers: [{ type: 'clock', enabled: true }] });
      ov.updateOverlayLayer(0, 'x', 'W-120');
      await flush();
      expect(ov.getOverlayConfig().layers[0].x).toBe('W-120');
      expect(stub.calls.some((c) => c.method === 'PUT' && c.url === '/api/overlays')).toBe(true);
    });

    it('removeOverlayLayer splices and PUTs', async () => {
      const { win, ov } = boot();
      const stub = withFetch(win, [routeExact('PUT', '/api/overlays', {})]);
      ov.setOverlayConfig({ enabled: false, layers: [
        { type: 'clock', enabled: true },
        { type: 'logo', enabled: true },
      ] });
      ov.removeOverlayLayer(0);
      await flush();
      expect(ov.getOverlayConfig().layers.length).toBe(1);
      expect(ov.getOverlayConfig().layers[0].type).toBe('logo');
      expect(stub.calls.some((c) => c.method === 'PUT' && c.url === '/api/overlays')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // overlays-enabled-check.onchange — real DOM checkbox
  // -------------------------------------------------------------------------
  describe('#overlays-enabled-check onchange', () => {
    it('toggling the master checkbox sets config.enabled and PUTs', async () => {
      const { win, doc, ov } = boot();
      const stub = withFetch(win, [routeExact('PUT', '/api/overlays', {})]);
      ov.setOverlayConfig({ enabled: false, layers: [] });
      const check = doc.getElementById('overlays-enabled-check');
      check.checked = true;
      check.onchange();
      await flush();
      expect(ov.getOverlayConfig().enabled).toBe(true);
      const put = stub.calls.find((c) => c.method === 'PUT' && c.url === '/api/overlays');
      expect(put).toBeTruthy();
      expect(put.body.enabled).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // saveOverlays — driven directly + error path
  // -------------------------------------------------------------------------
  describe('saveOverlays', () => {
    it('PUT /api/overlays with JSON content-type and the full overlayConfig body', async () => {
      const { win, ov } = boot();
      const stub = withFetch(win, [routeExact('PUT', '/api/overlays', {})]);
      ov.setOverlayConfig({ enabled: true, layers: [{ type: 'clock', enabled: true }] });
      ov.saveOverlays();
      await flush();
      const put = stub.calls.find((c) => c.method === 'PUT' && c.url === '/api/overlays');
      expect(put).toBeTruthy();
      expect(put.body).toEqual({ enabled: true, layers: [{ type: 'clock', enabled: true }] });
    });

    it('AS-IS: save error path -> showError writes #error-banner', async () => {
      const { win, doc, ov } = boot();
      win.fetch = () => Promise.reject(new Error('nope'));
      ov.setOverlayConfig({ enabled: true, layers: [] });
      ov.saveOverlays();
      await flush();
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);
      expect(banner.textContent).toContain('Save overlays failed');
    });
  });

  // -------------------------------------------------------------------------
  // #add-overlay-btn — generic modal -> push typed layer
  // -------------------------------------------------------------------------
  describe('add-overlay-btn flow (real #add-overlay-btn)', () => {
    it('opens the modal with the 6 type options', () => {
      const { doc } = boot();
      doc.getElementById('add-overlay-btn').onclick();
      expect(doc.getElementById('generic-modal').style.display).toBe('flex');
      expect(doc.getElementById('generic-modal-title').textContent).toBe('Add Overlay Layer');
      const sel = doc.getElementById('new-overlay-type');
      expect(sel).toBeTruthy();
      const values = Array.from(sel.querySelectorAll('option')).map((o) => o.value);
      expect(values).toEqual([
        'now_playing', 'scrolling_now_playing', 'static_text',
        'scrolling_text', 'clock', 'logo',
      ]);
    });

    it('onSave pushes a now_playing layer with its defaults, PUTs, closes modal, re-renders', async () => {
      const { win, doc, ov } = boot();
      const stub = withFetch(win, [routeExact('PUT', '/api/overlays', {})]);
      ov.setOverlayConfig({ enabled: false, layers: [] });
      doc.getElementById('add-overlay-btn').onclick();
      doc.getElementById('new-overlay-type').value = 'now_playing';
      doc.getElementById('generic-modal-save').onclick();
      await flush();

      const layers = ov.getOverlayConfig().layers;
      expect(layers.length).toBe(1);
      const layer = layers[0];
      expect(layer.type).toBe('now_playing');
      expect(layer.enabled).toBe(true);
      expect(layer.x).toBe('20');
      expect(layer.fontsize).toBe(28);
      expect(layer.fontcolor).toBe('white');
      expect(layer.y).toBe('H-60');
      expect(layer.boxcolor).toBe('black@0.6');
      expect(typeof layer.id).toBe('string');
      expect(layer.id.indexOf('ol_')).toBe(0);

      const put = stub.calls.find((c) => c.method === 'PUT' && c.url === '/api/overlays');
      expect(put).toBeTruthy();
      expect(doc.getElementById('generic-modal').style.display).toBe('none');
      expect(doc.getElementById('overlay-layers').querySelectorAll('.overlay-layer').length).toBe(1);
    });

    it('onSave for scrolling_text applies its text/speed/y/boxcolor defaults', async () => {
      const { win, doc, ov } = boot();
      withFetch(win, [routeExact('PUT', '/api/overlays', {})]);
      ov.setOverlayConfig({ enabled: false, layers: [] });
      doc.getElementById('add-overlay-btn').onclick();
      doc.getElementById('new-overlay-type').value = 'scrolling_text';
      doc.getElementById('generic-modal-save').onclick();
      await flush();
      const layer = ov.getOverlayConfig().layers[0];
      expect(layer.type).toBe('scrolling_text');
      expect(layer.text).toBe('STUDIO 23 RADIO - HARD TECHNO 24/7');
      expect(layer.fontsize).toBe(32);
      expect(layer.fontcolor).toBe('white');
      expect(layer.speed).toBe(150);
      expect(layer.y).toBe('H-80');
      expect(layer.boxcolor).toBe('black@0.5');
    });

    it('onSave for logo applies asset + x defaults', async () => {
      const { win, doc, ov } = boot();
      withFetch(win, [routeExact('PUT', '/api/overlays', {})]);
      ov.setOverlayConfig({ enabled: false, layers: [] });
      doc.getElementById('add-overlay-btn').onclick();
      doc.getElementById('new-overlay-type').value = 'logo';
      doc.getElementById('generic-modal-save').onclick();
      await flush();
      const layer = ov.getOverlayConfig().layers[0];
      expect(layer.type).toBe('logo');
      expect(layer.asset).toBe('logo.png');
      expect(layer.x).toBe('W-w-20');
    });

    it('onSave for clock applies format/fontsize/x defaults', async () => {
      const { win, doc, ov } = boot();
      withFetch(win, [routeExact('PUT', '/api/overlays', {})]);
      ov.setOverlayConfig({ enabled: false, layers: [] });
      doc.getElementById('add-overlay-btn').onclick();
      doc.getElementById('new-overlay-type').value = 'clock';
      doc.getElementById('generic-modal-save').onclick();
      await flush();
      const layer = ov.getOverlayConfig().layers[0];
      expect(layer.type).toBe('clock');
      expect(layer.format).toBe('%H:%M');
      expect(layer.fontsize).toBe(24);
      expect(layer.fontcolor).toBe('white');
      expect(layer.x).toBe('W-120');
    });

    it('onSave for static_text applies text/fontsize defaults', async () => {
      const { win, doc, ov } = boot();
      withFetch(win, [routeExact('PUT', '/api/overlays', {})]);
      ov.setOverlayConfig({ enabled: false, layers: [] });
      doc.getElementById('add-overlay-btn').onclick();
      doc.getElementById('new-overlay-type').value = 'static_text';
      doc.getElementById('generic-modal-save').onclick();
      await flush();
      const layer = ov.getOverlayConfig().layers[0];
      expect(layer.type).toBe('static_text');
      expect(layer.text).toBe('STUDIO 23');
      expect(layer.fontsize).toBe(18);
      expect(layer.fontcolor).toBe('white');
    });
  });

  // -------------------------------------------------------------------------
  // loadOverlayAssets — GET bare array -> rows / empty-state / silent error
  // -------------------------------------------------------------------------
  describe('loadOverlayAssets', () => {
    it('GET /api/overlays/assets bare array -> one .overlay-asset-item per asset (name + size)', async () => {
      const { win, doc, ov } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/overlays/assets', [
          { name: 'logo.png', size: 1048576 },
          { name: 'badge.png', size: 5000 },
        ]),
      ]);
      ov.loadOverlayAssets();
      await flush();

      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/overlays/assets')).toBe(true);
      const items = doc.getElementById('overlay-assets-list').querySelectorAll('.overlay-asset-item');
      expect(items.length).toBe(2);
      expect(items[0].querySelector('.file-name').textContent).toBe('logo.png');
      // 1048576 bytes -> "1.0 MB" (FRUtils.fmtSize)
      expect(items[0].querySelector('.file-size').textContent).toBe('1.0 MB');
      expect(items[1].querySelector('.file-size').textContent).toBe('4.9 KB');
    });

    it('AS-IS: empty asset array -> "No assets" empty-state', async () => {
      const { win, doc, ov } = boot();
      withFetch(win, [routeExact('GET', '/api/overlays/assets', [])]);
      ov.loadOverlayAssets();
      await flush();
      const container = doc.getElementById('overlay-assets-list');
      expect(container.querySelectorAll('.overlay-asset-item').length).toBe(0);
      expect(container.querySelector('.empty-state').textContent).toBe('No assets');
    });

    it('asset .file-del click -> DELETE /api/overlays/assets/<name> then reloads', async () => {
      const { win, doc, ov } = boot();
      let assets = [{ name: 'logo.png', size: 10 }];
      const stub = withFetch(win, [
        route('DELETE', '/api/overlays/assets/', {}),
        // GET re-reads from the mutable `assets` so the reload renders the empty-state
        routeExact('GET', '/api/overlays/assets', () => assets),
      ]);
      ov.loadOverlayAssets();
      await flush();

      const delBtn = doc.getElementById('overlay-assets-list').querySelector('.overlay-asset-item button');
      // simulate the backend removing it before the reload GET
      assets = [];
      delBtn.onclick();
      await flush(10);

      const del = stub.calls.find((c) => c.method === 'DELETE');
      expect(del).toBeTruthy();
      expect(del.url).toBe('/api/overlays/assets/logo.png');
      // reload happened -> now empty-state
      expect(doc.getElementById('overlay-assets-list').querySelector('.empty-state').textContent).toBe('No assets');
    });

    it('encodes the asset name in the DELETE path', async () => {
      const { win, doc, ov } = boot();
      const stub = withFetch(win, [
        route('DELETE', '/api/overlays/assets/', {}),
        routeExact('GET', '/api/overlays/assets', [{ name: 'a b.png', size: 1 }]),
      ]);
      ov.loadOverlayAssets();
      await flush();
      doc.getElementById('overlay-assets-list').querySelector('.overlay-asset-item button').onclick();
      await flush();
      const del = stub.calls.find((c) => c.method === 'DELETE');
      expect(del.url).toBe('/api/overlays/assets/a%20b.png');
    });

    it('AS-IS: load error path is a silent noop (no #error-banner, no rows)', async () => {
      const { win, doc, ov } = boot();
      win.fetch = () => Promise.reject(new Error('down'));
      ov.loadOverlayAssets();
      await flush();
      expect(doc.getElementById('error-banner').classList.contains('visible')).toBe(false);
      expect(doc.getElementById('overlay-assets-list').querySelectorAll('.overlay-asset-item').length).toBe(0);
    });
  });
});
