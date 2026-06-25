/**
 * tests/dashboard/fileMgmtUI.test.js
 *
 * Equivalence baseline for the C2 extraction of the file-management UI out of the
 * app.js IIFE. These tests pin the AS-IS observable contract of the file-mgmt
 * functions. They were authored against the guarded window.__appFileMgmt hook in
 * C1 (while the code still lived in app.js) and re-pointed in C2 to drive the
 * extracted module window.FRFileMgmt — the SAME contract, now asserted against the
 * extracted code. Green here is the proof the extraction preserved behavior.
 *
 * app.js init's window.FRFileMgmt on boot with its own deps; each test then
 * re-init's window.FRFileMgmt with its OWN controllable deps (a recording
 * authFetch built from win.fetch, a renderTrackSelector spy, a getBpmMap getter
 * returning a test-controlled bpmMap, plus the real showLoginOverlay / showError /
 * loadOverlayAssets / getAuthToken so the overlay + error-banner + auth-header
 * observables still flow through app.js). State is driven via the module's
 * setMusicFiles / setVisualFiles / setBpmMap surface (setBpmMap re-pointed to the
 * test-controlled state the injected getBpmMap reads).
 *
 * The functions pinned (current app.js lines ~879-1085):
 *   - refreshBpmInList — re-writes each music .file-bpm from bpmMap.
 *   - loadFileList(type) — GET /api/<type>, sets musicFiles/visualFiles, renders,
 *     and (music only) calls renderTrackSelector.
 *   - renderFileList(type, files) — builds the .file-item rows + count.
 *   - deleteFile(type, name) — confirm() then DELETE /api/<type>/<encoded>, reload.
 *   - initDropZone(el) — wires drag/drop + file-input change, extension-filters,
 *     calls uploadOneFile per accepted file.
 *   - uploadOneFile(type, file, queueEl) — XHR multipart POST + progress bar +
 *     success/401/error/overlay branches.
 *
 * How the backend is controlled:
 *   - fetch (loadFileList / deleteFile / loadOverlayAssets) — a recording
 *     makeFetchStub installed AS win.fetch after boot.
 *   - XHR (uploadOneFile) — installXhrStub replaces win.XMLHttpRequest with a
 *     recording stub; each upload is captured as a handle whose .fireProgress /
 *     .complete / .fail the test drives to exercise progress + the onload/onerror
 *     branches. See appBoot.js for the stub shape.
 *
 * AS-IS quirks pinned here (flagged for the C2 extraction):
 *   - index.html ships #music-list / #visuals-list / #music-count / #visuals-count
 *     TWICE (Studio tab + dedicated tabs); app.js binds via getElementById, i.e.
 *     the FIRST instance. doc.getElementById returns that same first node, so the
 *     assertions target the bound element by construction.
 *   - deleteFile encodes the name with encodeURIComponent (space -> %20).
 *   - BPM is rounded (Math.round) and suffixed ' BPM'; absent BPM => ''.
 *   - the boot already ran initDropZone over every real .drop-zone, so the
 *     drop-zone tests build a FRESH standalone .drop-zone to avoid double-binding.
 *   - uploadOneFile success calls loadFileList(type) (a reload fetch); the overlay
 *     branch posts field 'file' to /api/overlays/assets and reloads via
 *     loadOverlayAssets (GET /api/overlays/assets), and passes null to
 *     loadFileList (which early-returns).
 *   - 401 -> showLoginOverlay (observable: #login-overlay display becomes 'flex'),
 *     badge 'AUTH'; non-2xx and onerror -> badge 'ERROR' + showError (errorBanner).
 */

import { describe, it, expect } from 'vitest';
import {
  bootWindow, makeFetchStub, installXhrStub, routeExact, flush,
} from './appBoot.js';

/**
 * Boot a fresh window and re-init window.FRFileMgmt with test-controlled deps.
 *
 * Returns { win, doc, fm } where `fm` is window.FRFileMgmt re-init'd so that:
 *   - authFetch routes through win.fetch (the per-test makeFetchStub),
 *   - renderTrackSelector is a recording spy (fm.trackSelectorCalls) — the music
 *     load's call into it is observable as a spy call,
 *   - getBpmMap reads a test-controlled bpmMap; fm.setBpmMap re-pointed to mutate
 *     it (so the injected getter sees what the test sets),
 *   - showLoginOverlay / showError / loadOverlayAssets are doubles that reproduce
 *     the exact observable app.js produces (login-overlay display:flex,
 *     error-banner visible+text, GET /api/overlays/assets),
 *   - getAuthToken returns '' (no auth header on uploads, as in the boot session).
 */
function boot() {
  const { win, doc } = bootWindow();
  const fm = win.FRFileMgmt;

  const state = { bpmMap: {} };
  const trackSelectorCalls = [];

  fm.init({
    authFetch: (url, opts) => win.fetch(url, opts),
    log: () => {},
    showError: (msg) => {
      const banner = doc.getElementById('error-banner');
      banner.textContent = msg;
      banner.classList.add('visible');
    },
    showLoginOverlay: () => {
      doc.getElementById('login-overlay').style.display = 'flex';
    },
    renderTrackSelector: (filter) => { trackSelectorCalls.push(filter); },
    loadOverlayAssets: () => win.fetch('/api/overlays/assets'),
    getBpmMap: () => state.bpmMap,
    getAuthToken: () => '',
  });

  // Re-point setBpmMap to the test-controlled state the injected getter reads.
  fm.setBpmMap = (o) => { state.bpmMap = o; };
  fm.trackSelectorCalls = trackSelectorCalls;

  return { win, doc, fm };
}

/** Install a recording fetch stub and return { calls }. */
function withFetch(win, routes) {
  const stub = makeFetchStub(routes);
  win.fetch = stub.fetch;
  return stub;
}

/**
 * Build a FRESH standalone .drop-zone element (NOT one of the boot-wired ones, to
 * avoid double-binding), append it, and initDropZone it. Returns the element.
 */
function freshDropZone(doc, fm, { type, accept }) {
  const dz = doc.createElement('div');
  dz.className = 'drop-zone';
  dz.dataset.type = type;
  if (accept != null) dz.dataset.accept = accept;
  dz.innerHTML =
    '<input class="drop-zone-input" type="file" multiple>' +
    '<button class="drop-zone-browse" type="button"></button>' +
    '<div class="drop-zone-prompt"></div>' +
    '<div class="drop-zone-queue"></div>';
  doc.body.appendChild(dz);
  fm.initDropZone(dz);
  return dz;
}

/** Dispatch a non-bubbling drop event carrying the given File list. */
function dispatchDrop(win, el, files) {
  const evt = new win.Event('drop', { bubbles: false, cancelable: true });
  evt.dataTransfer = { files };
  el.dispatchEvent(evt);
}

describe('file-management UI characterization (window.FRFileMgmt)', () => {
  it('exposes the 6 fns + state getters/setters', () => {
    const { fm } = boot();
    expect(fm).toBeTruthy();
    for (const fn of [
      'refreshBpmInList', 'loadFileList', 'renderFileList',
      'deleteFile', 'initDropZone', 'uploadOneFile',
      'getMusicFiles', 'setMusicFiles', 'getVisualFiles', 'setVisualFiles', 'setBpmMap',
    ]) {
      expect(typeof fm[fn]).toBe('function');
    }
  });

  // -------------------------------------------------------------------------
  // loadFileList — fetch + render + state
  // -------------------------------------------------------------------------
  describe('loadFileList', () => {
    it('GET /api/music -> populates musicFiles, renders rows + count + bpm + size', async () => {
      const { win, doc, fm } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/music', [
          { name: 'song one.mp3', size: 1048576 },
          { name: 'two.mp3', size: 2048 },
        ]),
      ]);
      fm.setBpmMap({ 'song one.mp3': 128.4 });
      fm.loadFileList('music');
      await flush();

      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/music')).toBe(true);
      // state owned here
      expect(fm.getMusicFiles().length).toBe(2);

      const list = doc.getElementById('music-list');
      const items = list.querySelectorAll('.file-item');
      expect(items.length).toBe(2);

      const first = items[0];
      expect(first.dataset.name).toBe('song one.mp3');
      expect(first.querySelector('.file-name').textContent).toBe('song one.mp3');
      // bpm via bpmMap, rounded + ' BPM'
      expect(first.querySelector('.file-bpm').textContent).toBe('128 BPM');
      // size via FRU.fmtSize (1048576 bytes -> "1.0 MB")
      expect(first.querySelector('.file-size').textContent).toBe('1.0 MB');
      // a track with no bpm renders empty bpm text
      expect(items[1].querySelector('.file-bpm').textContent).toBe('');

      expect(doc.getElementById('music-count').textContent).toBe('2 files');
    });

    it('music load calls renderTrackSelector (observable via the injected spy)', async () => {
      const { win, fm } = boot();
      withFetch(win, [
        routeExact('GET', '/api/music', [{ name: 'pick.mp3', size: 10 }]),
      ]);
      fm.loadFileList('music');
      await flush();
      // The music branch of loadFileList calls renderTrackSelector after setting
      // musicFiles. Pin that call via the injected spy; the loaded file is now
      // reachable through getMusicFiles for the real selector to render.
      expect(fm.trackSelectorCalls.length).toBe(1);
      expect(fm.getMusicFiles().map((f) => f.name)).toContain('pick.mp3');
    });

    it('GET /api/visuals -> populates visualFiles + renders #visuals-list (no bpm column)', async () => {
      const { win, doc, fm } = boot();
      withFetch(win, [
        routeExact('GET', '/api/visuals', [{ name: 'clip.mp4', size: 5000 }]),
      ]);
      fm.loadFileList('visuals');
      await flush();

      expect(fm.getVisualFiles().length).toBe(1);
      const list = doc.getElementById('visuals-list');
      const item = list.querySelector('.file-item');
      expect(item.querySelector('.file-name').textContent).toBe('clip.mp4');
      // visuals branch does NOT add a .file-bpm span
      expect(item.querySelector('.file-bpm')).toBeNull();
      expect(doc.getElementById('visuals-count').textContent).toBe('1 files');
    });

    it('AS-IS: empty/missing type -> early return, no fetch', async () => {
      const { win, fm } = boot();
      const stub = withFetch(win, []);
      fm.loadFileList('');
      fm.loadFileList();
      await flush();
      expect(stub.calls.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // renderFileList — DOM shape, driven directly
  // -------------------------------------------------------------------------
  describe('renderFileList', () => {
    it('builds one .file-item per file with name, size, delete button', () => {
      const { doc, fm } = boot();
      fm.renderFileList('music', [
        { name: 'a.mp3', size: 1024 },
        { name: 'b.mp3', size: 2048 },
      ]);
      const items = doc.getElementById('music-list').querySelectorAll('.file-item');
      expect(items.length).toBe(2);
      const f = items[0];
      expect(f.querySelector('.file-name').textContent).toBe('a.mp3');
      expect(f.querySelector('.file-size').textContent).toBe('1.0 KB');
      expect(f.querySelector('.file-del')).toBeTruthy();
      expect(doc.getElementById('music-count').textContent).toBe('2 files');
    });

    it('clicking a row delete button routes through deleteFile (confirm + DELETE fetch)', async () => {
      const { win, doc, fm } = boot();
      const stub = withFetch(win, [
        routeExact('DELETE', '/api/music/a.mp3', { ok: true }),
        routeExact('GET', '/api/music', []),
      ]);
      win.confirm = () => true;
      fm.renderFileList('music', [{ name: 'a.mp3', size: 10 }]);
      doc.getElementById('music-list')
        .querySelector('.file-del')
        .dispatchEvent(new win.Event('click'));
      await flush();
      expect(stub.calls.some((c) => c.method === 'DELETE' && c.url === '/api/music/a.mp3')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // deleteFile — confirm gate + encodeURIComponent + reload
  // -------------------------------------------------------------------------
  describe('deleteFile', () => {
    it('confirm=true -> DELETE /api/music/<encoded> then reload GET /api/music', async () => {
      const { win, fm } = boot();
      const stub = withFetch(win, [
        routeExact('DELETE', '/api/music/song%20one.mp3', { ok: true }),
        routeExact('GET', '/api/music', []),
      ]);
      win.confirm = () => true;
      fm.deleteFile('music', 'song one.mp3');
      await flush();
      const del = stub.calls.find((c) => c.method === 'DELETE');
      // space encoded as %20 (encodeURIComponent), NOT '+'
      expect(del.url).toBe('/api/music/song%20one.mp3');
      // reload re-fetches the list
      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/music')).toBe(true);
    });

    it('confirm=false -> no fetch at all', async () => {
      const { win, fm } = boot();
      const stub = withFetch(win, []);
      win.confirm = () => false;
      fm.deleteFile('music', 'x.mp3');
      await flush();
      expect(stub.calls.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // refreshBpmInList — re-write .file-bpm from bpmMap
  // -------------------------------------------------------------------------
  describe('refreshBpmInList', () => {
    it('updates each music row .file-bpm from the current bpmMap (rounded + " BPM")', () => {
      const { doc, fm } = boot();
      // render a music list with no bpm yet
      fm.setBpmMap({});
      fm.renderFileList('music', [{ name: 't.mp3', size: 10 }]);
      expect(doc.getElementById('music-list').querySelector('.file-bpm').textContent).toBe('');
      // now a bpm arrives and we refresh
      fm.setBpmMap({ 't.mp3': 90.7 });
      fm.refreshBpmInList();
      expect(doc.getElementById('music-list').querySelector('.file-bpm').textContent).toBe('91 BPM');
    });

    it('AS-IS: a row whose name has no bpm entry is set to empty text', () => {
      const { doc, fm } = boot();
      fm.setBpmMap({ 'has.mp3': 120 });
      fm.renderFileList('music', [{ name: 'has.mp3', size: 1 }, { name: 'none.mp3', size: 1 }]);
      fm.setBpmMap({ 'has.mp3': 120 }); // none.mp3 absent
      fm.refreshBpmInList();
      const bpms = doc.getElementById('music-list').querySelectorAll('.file-bpm');
      expect(bpms[0].textContent).toBe('120 BPM');
      expect(bpms[1].textContent).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // initDropZone — drag/drop + file-input change, extension filter
  // -------------------------------------------------------------------------
  describe('initDropZone', () => {
    it('drop with a mix of files: accepted extension uploaded, rejected one filtered', () => {
      const { win, doc, fm } = boot();
      withFetch(win, []);
      const xhr = installXhrStub(win);
      const dz = freshDropZone(doc, fm, { type: 'music', accept: '.mp3,.wav' });

      const ok = new win.File(['x'], 'good.mp3');
      const bad = new win.File(['y'], 'bad.txt');
      dispatchDrop(win, dz, [ok, bad]);

      // exactly ONE upload (the .mp3); the .txt was extension-filtered
      expect(xhr.calls.length).toBe(1);
      expect(xhr.calls[0].body.get('files').name).toBe('good.mp3');
      // and exactly one upload-item row was created in the queue
      expect(dz.querySelector('.drop-zone-queue').querySelectorAll('.upload-item').length).toBe(1);
    });

    it('file-input change uploads accepted files too', () => {
      const { win, doc, fm } = boot();
      withFetch(win, []);
      const xhr = installXhrStub(win);
      const dz = freshDropZone(doc, fm, { type: 'music', accept: '.mp3' });
      const input = dz.querySelector('.drop-zone-input');
      // jsdom: define files getter, then fire change
      Object.defineProperty(input, 'files', {
        value: [new win.File(['x'], 'pick.mp3')],
        configurable: true,
      });
      input.dispatchEvent(new win.Event('change'));
      expect(xhr.calls.length).toBe(1);
      expect(xhr.calls[0].body.get('files').name).toBe('pick.mp3');
    });
  });

  // -------------------------------------------------------------------------
  // uploadOneFile — XHR multipart + progress + onload/onerror branches
  // -------------------------------------------------------------------------
  describe('uploadOneFile (XHR)', () => {
    function queueEl(doc) {
      const q = doc.createElement('div');
      doc.body.appendChild(q);
      return q;
    }

    it('POSTs FormData "files" to /api/music and drives the progress bar', () => {
      const { win, doc, fm } = boot();
      withFetch(win, [routeExact('GET', '/api/music', [])]);
      const xhr = installXhrStub(win);
      const q = queueEl(doc);
      fm.uploadOneFile('music', new win.File(['x'], 'a.mp3'), q);

      const call = xhr.calls[xhr.calls.length - 1];
      expect(call.method).toBe('POST');
      expect(call.url).toBe('/api/music');
      expect(call.body.get('files').name).toBe('a.mp3');

      const fill = q.querySelector('.upload-item-progress-fill');
      const badge = q.querySelector('.upload-item-status');
      // 50/200 -> 25%
      call.fireProgress({ lengthComputable: true, loaded: 50, total: 200 });
      expect(fill.style.width).toBe('25%');
      expect(badge.textContent).toBe('25%');
    });

    it('status 200 -> fill 100% + "OK"/ready badge AND reloads via GET /api/music', () => {
      const { win, doc, fm } = boot();
      const stub = withFetch(win, [routeExact('GET', '/api/music', [])]);
      const xhr = installXhrStub(win);
      const q = queueEl(doc);
      fm.uploadOneFile('music', new win.File(['x'], 'a.mp3'), q);
      const call = xhr.calls[xhr.calls.length - 1];
      call.complete(200, '{}');

      const fill = q.querySelector('.upload-item-progress-fill');
      const badge = q.querySelector('.upload-item-status');
      expect(fill.style.width).toBe('100%');
      expect(badge.textContent).toBe('OK');
      expect(badge.className).toBe('upload-item-status ready');
      // success reloads the list
      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/music')).toBe(true);
    });

    it('status 401 -> badge "AUTH" + showLoginOverlay (#login-overlay becomes visible)', () => {
      const { win, doc, fm } = boot();
      withFetch(win, []);
      const xhr = installXhrStub(win);
      const q = queueEl(doc);
      fm.uploadOneFile('music', new win.File(['x'], 'a.mp3'), q);
      xhr.calls[xhr.calls.length - 1].complete(401, 'Unauthorized');

      const badge = q.querySelector('.upload-item-status');
      expect(badge.textContent).toBe('AUTH');
      expect(badge.className).toBe('upload-item-status error');
      // showLoginOverlay flips the overlay to display:flex
      expect(doc.getElementById('login-overlay').style.display).toBe('flex');
    });

    it('non-2xx status -> badge "ERROR" + showError (errorBanner visible)', () => {
      const { win, doc, fm } = boot();
      withFetch(win, []);
      const xhr = installXhrStub(win);
      const q = queueEl(doc);
      fm.uploadOneFile('music', new win.File(['x'], 'a.mp3'), q);
      xhr.calls[xhr.calls.length - 1].complete(500, 'Server Error');

      expect(q.querySelector('.upload-item-status').textContent).toBe('ERROR');
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);
      expect(banner.textContent).toContain('Upload failed');
    });

    it('network error (onerror) -> badge "ERROR" + showError', () => {
      const { win, doc, fm } = boot();
      withFetch(win, []);
      const xhr = installXhrStub(win);
      const q = queueEl(doc);
      fm.uploadOneFile('music', new win.File(['x'], 'a.mp3'), q);
      xhr.calls[xhr.calls.length - 1].fail();

      expect(q.querySelector('.upload-item-status').textContent).toBe('ERROR');
      expect(doc.getElementById('error-banner').classList.contains('visible')).toBe(true);
    });

    it('overlay-assets -> POSTs FormData "file" to /api/overlays/assets; success reloads via loadOverlayAssets', () => {
      const { win, doc, fm } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/overlays/assets', []),
      ]);
      const xhr = installXhrStub(win);
      const q = queueEl(doc);
      fm.uploadOneFile('overlay-assets', new win.File(['x'], 'logo.png'), q);

      const call = xhr.calls[xhr.calls.length - 1];
      expect(call.url).toBe('/api/overlays/assets');
      // overlay uses field 'file', NOT 'files'
      expect(call.body.get('file').name).toBe('logo.png');
      expect(call.body.has('files')).toBe(false);

      call.complete(200, '{}');
      // overlay success reloads via loadOverlayAssets (GET /api/overlays/assets)
      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/overlays/assets')).toBe(true);
    });
  });
});
