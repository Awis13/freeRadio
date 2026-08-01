/**
 * tests/dashboard/playlistsUI.test.js
 *
 * Equivalence baseline for the C2 extraction of the music-playlists UI out of
 * the app.js IIFE into dashboard/public/playlists.js (window.FRPlaylists).
 *
 * These tests originally pinned the AS-IS contract of the code WHILE it still
 * lived in app.js (driven via the guarded window.__appPlaylists hook). After
 * C2 the SAME contract is asserted against the extracted module — only the
 * DRIVING handle changed (now window.FRPlaylists). The assertions are
 * unchanged, so green here is the proof the extraction preserved behavior:
 *   - the DOM each render function produces (shape, classes, text)
 *   - the backend endpoints each action hits (method + path + body)
 *   - the selection / branch behavior (manual vs smart, highlight, etc.)
 *
 * How the backend is controlled: FRPlaylists calls its injected authFetch,
 * which (via app.js boot init) wraps the global fetch. The shared boot stubs
 * fetch as a never-resolving promise; here each test installs a controllable
 * win.fetch (makeFetchStub) that RECORDS every { method, url, body } and
 * resolves canned JSON mirroring the real backend shapes. Functions are driven
 * via window.FRPlaylists; after each drive we flush() microtasks then assert
 * DOM + recorded fetch calls.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { bootWindow, makeFetchStub, route, routeExact, flush, closeAllWindows } from './appBoot.js';

// Close every jsdom window this file booted (rationale in appBoot.js).
afterAll(closeAllWindows);

/**
 * Boot a fresh window and swap in a controllable fetch built from `routes`.
 *
 * app.js calls FRPlaylists.init(...) on boot, wiring the real authFetch / log /
 * showError / openGenericModal / closeGenericModal / loadQueue closures (all of
 * which funnel through win.fetch) plus live getters for the app's musicFiles /
 * bpmMap. We re-init here with getMusicFiles/getBpmMap cleared to null so the
 * module falls back to its internal music state — letting the tests drive it
 * through pl.setMusicFiles()/setBpmMap() exactly as before. The host services
 * stay wired (init merges, untouched keys preserved), so authFetch/loadQueue/
 * etc. still route through the freshly-installed win.fetch.
 */
function bootWithFetch(routes) {
  const { win, doc } = bootWindow();
  const stub = makeFetchStub(routes);
  win.fetch = stub.fetch;
  win.FRPlaylists.init({ getMusicFiles: null, getBpmMap: null });
  return { win, doc, pl: win.FRPlaylists, calls: stub.calls };
}

describe('playlists UI characterization (window.FRPlaylists)', () => {
  it('window.FRPlaylists exposes all 13 fns + state handles', () => {
    const { win } = bootWindow();
    const pl = win.FRPlaylists;
    expect(pl).toBeTruthy();
    for (const fn of [
      'loadPlaylists', 'renderPlaylistsList', 'selectPlaylist', 'renderPlaylistDetail',
      'renderPlaylistTrackLibrary', 'addTrackToPlaylist', 'removeTrackFromPlaylist',
      'reorderPlaylistTrack', 'loadForSelect', 'updateSmartRules',
      'setPlaylists', 'getPlaylists', 'setSelectedPlaylistId', 'getSelectedPlaylistId',
      'setMusicFiles', 'setBpmMap',
    ]) {
      expect(typeof pl[fn]).toBe('function');
    }
  });

  // -------------------------------------------------------------------------
  // renderPlaylistsList
  // -------------------------------------------------------------------------
  describe('renderPlaylistsList', () => {
    it('renders one .playlist-item per playlist with name, type badge and count', () => {
      const { doc, pl } = bootWithFetch([]);
      pl.setPlaylists([
        { id: 'a', name: 'Chill', type: 'manual', trackCount: 3 },
        { id: 'b', name: 'Bangers', type: 'smart', trackCount: 12 },
      ]);
      pl.setSelectedPlaylistId(null);
      pl.renderPlaylistsList();

      const items = doc.querySelectorAll('#playlists-list .playlist-item');
      expect(items.length).toBe(2);

      const first = items[0];
      expect(first.querySelector('.playlist-item-name').textContent).toBe('Chill');
      const badge = first.querySelector('.playlist-badge');
      expect(badge.textContent).toBe('manual');
      expect(badge.className).toContain('manual');
      expect(first.querySelector('.playlist-count').textContent).toBe('3 tracks');

      // smart badge carries its type class too
      expect(items[1].querySelector('.playlist-badge').className).toContain('smart');
    });

    it('missing trackCount renders as "0 tracks"', () => {
      const { doc, pl } = bootWithFetch([]);
      pl.setPlaylists([{ id: 'a', name: 'X', type: 'manual' }]);
      pl.renderPlaylistsList();
      expect(doc.querySelector('#playlists-list .playlist-count').textContent).toBe('0 tracks');
    });

    it('empty list renders the empty-state placeholder', () => {
      const { doc, pl } = bootWithFetch([]);
      pl.setPlaylists([]);
      pl.renderPlaylistsList();
      const container = doc.getElementById('playlists-list');
      expect(container.querySelector('.empty-state')).toBeTruthy();
      expect(container.querySelector('.playlist-item')).toBeNull();
    });

    it('selected playlist gets the .selected highlight class', () => {
      const { doc, pl } = bootWithFetch([]);
      pl.setPlaylists([
        { id: 'a', name: 'A', type: 'manual', trackCount: 0 },
        { id: 'b', name: 'B', type: 'manual', trackCount: 0 },
      ]);
      pl.setSelectedPlaylistId('b');
      pl.renderPlaylistsList();
      const items = doc.querySelectorAll('#playlists-list .playlist-item');
      expect(items[0].className).not.toContain('selected');
      expect(items[1].className).toContain('selected');
    });

    it('clicking an item triggers selectPlaylist → GET /api/playlists/:id', async () => {
      const { doc, pl, calls } = bootWithFetch([
        route('GET', '/api/playlists/a', { id: 'a', name: 'A', type: 'manual', tracks: [] }),
      ]);
      pl.setPlaylists([{ id: 'a', name: 'A', type: 'manual', trackCount: 0 }]);
      pl.renderPlaylistsList();

      doc.querySelector('#playlists-list .playlist-item').click();
      await flush();

      const get = calls.find((c) => c.method === 'GET' && c.url === '/api/playlists/a');
      expect(get).toBeTruthy();
      // selectPlaylist also marks the clicked one selected and re-renders the list
      expect(pl.getSelectedPlaylistId()).toBe('a');
    });
  });

  // -------------------------------------------------------------------------
  // renderPlaylistDetail — manual vs smart branch
  // -------------------------------------------------------------------------
  describe('renderPlaylistDetail', () => {
    it('manual playlist: tracks with remove + grip, track-library panel shown', () => {
      const { doc, pl } = bootWithFetch([]);
      pl.setMusicFiles([{ name: 'one.mp3' }, { name: 'two.mp3' }]);
      pl.renderPlaylistDetail({ id: 'm', name: 'Manual', type: 'manual', tracks: ['one.mp3'] });

      expect(doc.getElementById('playlist-detail-title').textContent).toBe('Manual (manual)');
      expect(doc.getElementById('playlist-detail-actions').style.display).toBe('flex');

      const tracks = doc.querySelectorAll('#playlist-detail-content .playlist-track-item');
      expect(tracks.length).toBe(1);
      expect(tracks[0].querySelector('.drag-grip')).toBeTruthy();
      expect(tracks[0].querySelector('.file-del')).toBeTruthy();
      expect(tracks[0].getAttribute('draggable')).toBe('true');

      // library panel is visible for manual
      expect(doc.getElementById('track-library-panel').style.display).toBe('block');
    });

    it('manual playlist with no tracks shows the empty-state hint', () => {
      const { doc, pl } = bootWithFetch([]);
      pl.setMusicFiles([]);
      pl.renderPlaylistDetail({ id: 'm', name: 'Empty', type: 'manual', tracks: [] });
      expect(doc.querySelector('#playlist-detail-content .empty-state')).toBeTruthy();
      expect(doc.getElementById('track-library-panel').style.display).toBe('block');
    });

    it('smart playlist: rules form + resolved tracks, track-library hidden', () => {
      const { doc, pl } = bootWithFetch([]);
      pl.renderPlaylistDetail({
        id: 's', name: 'Smart', type: 'smart',
        rules: { bpmMin: 120, bpmMax: 140, namePattern: 'techno', tags: ['dark'], tagMode: 'all' },
        resolvedTracks: ['x.mp3', 'y.mp3'],
      });

      expect(doc.getElementById('playlist-detail-title').textContent).toBe('Smart (smart)');
      // rules form fields present and pre-filled from rules
      expect(doc.getElementById('smart-bpm-min').value).toBe('120');
      expect(doc.getElementById('smart-bpm-max').value).toBe('140');
      expect(doc.getElementById('smart-name-pattern').value).toBe('techno');
      expect(doc.getElementById('smart-tags').value).toBe('dark');
      expect(doc.getElementById('smart-tag-mode').value).toBe('all');

      // resolved tracks rendered
      const resolved = doc.querySelectorAll('#playlist-detail-content .playlist-tracks .playlist-track-item');
      expect(resolved.length).toBe(2);

      // smart hides the library panel — the branch difference vs manual
      expect(doc.getElementById('track-library-panel').style.display).toBe('none');
    });

    it('smart "Update Rules" button wires to window.updateSmartRules for the id', async () => {
      const { doc, pl, calls } = bootWithFetch([
        route('PUT', '/api/playlists/s', {}),
        route('GET', '/api/playlists/s', { id: 's', name: 'S', type: 'smart', rules: {}, resolvedTracks: [] }),
        route('GET', '/api/playlists', []),
      ]);
      pl.renderPlaylistDetail({ id: 's', name: 'S', type: 'smart', rules: {}, resolvedTracks: [] });
      const btn = doc.querySelector('#playlist-detail-content [data-action="updateSmartRules"]');
      expect(btn).toBeTruthy();
      btn.click();
      await flush();
      // updateSmartRules issues a PUT to /api/playlists/s
      expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/playlists/s')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // renderPlaylistTrackLibrary
  // -------------------------------------------------------------------------
  describe('renderPlaylistTrackLibrary', () => {
    it('renders the music library, marks existing tracks added/disabled, shows bpm', () => {
      const { doc, pl } = bootWithFetch([]);
      pl.setMusicFiles([{ name: 'alpha.mp3' }, { name: 'beta.mp3' }]);
      pl.setBpmMap({ 'alpha.mp3': 128.4 });
      pl.renderPlaylistTrackLibrary('p1', ['beta.mp3']);

      const items = doc.querySelectorAll('#playlist-track-library .selector-item');
      expect(items.length).toBe(2);

      const alpha = items[0];
      expect(alpha.querySelector('.selector-name').textContent).toBe('alpha.mp3');
      // bpm rounded, shown from bpmMap
      expect(alpha.querySelector('.selector-bpm').textContent).toBe('128 BPM');
      // alpha not yet in playlist → add button enabled, label '+'
      expect(alpha.querySelector('.btn-add-queue').disabled).toBe(false);
      expect(alpha.querySelector('.btn-add-queue').textContent).toBe('+');

      // beta already in playlist → checkmark, disabled
      const beta = items[1];
      expect(beta.querySelector('.btn-add-queue').disabled).toBe(true);
      expect(beta.querySelector('.btn-add-queue').textContent).toBe('✓');
      // beta has no bpm entry → no bpm span
      expect(beta.querySelector('.selector-bpm')).toBeNull();
    });

    it('typing in #playlist-track-search filters the library by name (case-insensitive)', () => {
      const { doc, pl } = bootWithFetch([]);
      pl.setMusicFiles([{ name: 'House.mp3' }, { name: 'Techno.mp3' }]);
      pl.setBpmMap({});
      pl.renderPlaylistTrackLibrary('p1', []);
      expect(doc.querySelectorAll('#playlist-track-library .selector-item').length).toBe(2);

      const search = doc.getElementById('playlist-track-search');
      search.value = 'tech';
      search.dispatchEvent(new doc.defaultView.Event('input'));

      const items = doc.querySelectorAll('#playlist-track-library .selector-item');
      expect(items.length).toBe(1);
      expect(items[0].querySelector('.selector-name').textContent).toBe('Techno.mp3');
    });

    it('clicking the add button on a library track calls addTrackToPlaylist (GET then PUT)', async () => {
      const { doc, pl, calls } = bootWithFetch([
        route('GET', '/api/playlists/p1', { id: 'p1', name: 'P', type: 'manual', tracks: [] }),
        route('PUT', '/api/playlists/p1', {}),
      ]);
      pl.setMusicFiles([{ name: 'add-me.mp3' }]);
      pl.setBpmMap({});
      pl.renderPlaylistTrackLibrary('p1', []);
      doc.querySelector('#playlist-track-library .btn-add-queue').click();
      await flush();
      expect(calls.some((c) => c.method === 'GET' && c.url === '/api/playlists/p1')).toBe(true);
      const put = calls.find((c) => c.method === 'PUT' && c.url === '/api/playlists/p1');
      expect(put).toBeTruthy();
      expect(put.body).toEqual({ tracks: ['add-me.mp3'] });
    });
  });

  // -------------------------------------------------------------------------
  // CRUD wiring — method + path + body
  // -------------------------------------------------------------------------
  describe('CRUD wiring (endpoint + method + body)', () => {
    it('addTrackToPlaylist: GET /api/playlists/:id then PUT with appended track', async () => {
      const { pl, calls } = bootWithFetch([
        route('GET', '/api/playlists/p1', { id: 'p1', type: 'manual', tracks: ['old.mp3'] }),
        route('PUT', '/api/playlists/p1', {}),
        route('GET', '/api/playlists/p1', {}),
      ]);
      pl.addTrackToPlaylist('p1', 'new.mp3');
      await flush();
      expect(calls[0]).toMatchObject({ method: 'GET', url: '/api/playlists/p1' });
      const put = calls.find((c) => c.method === 'PUT');
      expect(put.url).toBe('/api/playlists/p1');
      expect(put.body).toEqual({ tracks: ['old.mp3', 'new.mp3'] });
    });

    it('removeTrackFromPlaylist: GET then PUT with the track spliced out by index', async () => {
      const { pl, calls } = bootWithFetch([
        route('GET', '/api/playlists/p1', { id: 'p1', type: 'manual', tracks: ['a', 'b', 'c'] }),
        route('PUT', '/api/playlists/p1', {}),
      ]);
      pl.removeTrackFromPlaylist('p1', 1);
      await flush();
      const put = calls.find((c) => c.method === 'PUT');
      expect(put.body).toEqual({ tracks: ['a', 'c'] });
    });

    it('reorderPlaylistTrack: POST /api/playlists/:id/reorder with {from,to}', async () => {
      const { pl, calls } = bootWithFetch([
        route('POST', '/api/playlists/p1/reorder', {}),
        route('GET', '/api/playlists/p1', {}),
      ]);
      pl.reorderPlaylistTrack('p1', 0, 2);
      await flush();
      const post = calls.find((c) => c.method === 'POST');
      expect(post.url).toBe('/api/playlists/p1/reorder');
      expect(post.body).toEqual({ from: 0, to: 2 });
    });

    it('create handler (#create-playlist-btn → modal save): POST /api/playlists {name,type}', async () => {
      const { doc, calls } = bootWithFetch([
        route('POST', '/api/playlists', { id: 'newid', name: 'Fresh' }),
        route('GET', '/api/playlists', []),
        route('GET', '/api/playlists/newid', { id: 'newid', type: 'manual', tracks: [] }),
      ]);
      // open the create modal, fill fields, confirm via the generic modal save button
      doc.getElementById('create-playlist-btn').click();
      doc.getElementById('new-playlist-name').value = 'Fresh';
      doc.getElementById('new-playlist-type').value = 'smart';
      doc.getElementById('generic-modal-save').click();
      await flush();

      const post = calls.find((c) => c.method === 'POST' && c.url === '/api/playlists');
      expect(post).toBeTruthy();
      expect(post.body).toEqual({ name: 'Fresh', type: 'smart' });
    });

    it('create handler ignores an empty name (no POST)', async () => {
      const { doc, calls } = bootWithFetch([]);
      doc.getElementById('create-playlist-btn').click();
      doc.getElementById('new-playlist-name').value = '   ';
      doc.getElementById('generic-modal-save').click();
      await flush();
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/playlists')).toBe(false);
    });

    it('delete handler (#playlist-delete-btn): DELETE /api/playlists/:id when confirmed', async () => {
      const { win, doc, pl, calls } = bootWithFetch([
        route('DELETE', '/api/playlists/p9', {}),
        route('GET', '/api/playlists', []),
      ]);
      win.confirm = () => true;
      pl.setSelectedPlaylistId('p9');
      doc.getElementById('playlist-delete-btn').click();
      await flush();
      expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/playlists/p9')).toBe(true);
    });

    it('delete handler does nothing when not confirmed', async () => {
      const { win, doc, pl, calls } = bootWithFetch([]);
      win.confirm = () => false;
      pl.setSelectedPlaylistId('p9');
      doc.getElementById('playlist-delete-btn').click();
      await flush();
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    });

    it('import handler (#import-m3u-input change with a File): POST /api/playlists/import (multipart)', async () => {
      const { win, doc, calls } = bootWithFetch([
        route('POST', '/api/playlists/import', { id: 'imp', importedCount: 2, totalParsed: 3 }),
        route('GET', '/api/playlists', []),
        route('GET', '/api/playlists/imp', { id: 'imp', type: 'manual', tracks: [] }),
      ]);
      const input = doc.getElementById('import-m3u-input');
      const file = new win.File(['#EXTM3U\na.mp3\n'], 'mylist.m3u', { type: 'audio/x-mpegurl' });
      // jsdom file inputs are read-only; define the files getter for this test
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new win.Event('change'));
      await flush();

      const post = calls.find((c) => c.method === 'POST' && c.url === '/api/playlists/import');
      expect(post).toBeTruthy();
      // multipart → body is a FormData carrying the file and a derived name
      expect(post.body instanceof win.FormData).toBe(true);
      expect(post.body.get('name')).toBe('mylist');
    });
  });

  // -------------------------------------------------------------------------
  // updateSmartRules
  // -------------------------------------------------------------------------
  describe('updateSmartRules', () => {
    it('PUT /api/playlists/:id with rules collected from the smart fields', async () => {
      const { doc, pl, calls } = bootWithFetch([
        route('PUT', '/api/playlists/s1', {}),
        route('GET', '/api/playlists/s1', { id: 's1', type: 'smart', rules: {}, resolvedTracks: [] }),
        route('GET', '/api/playlists', []),
      ]);
      // render the smart detail so the smart-* fields exist, then set values
      pl.renderPlaylistDetail({ id: 's1', name: 'S', type: 'smart', rules: {}, resolvedTracks: [] });
      doc.getElementById('smart-bpm-min').value = '110';
      doc.getElementById('smart-bpm-max').value = '130';
      doc.getElementById('smart-name-pattern').value = 'acid.*';
      doc.getElementById('smart-tags').value = 'dark, raw';
      doc.getElementById('smart-tag-mode').value = 'all';

      pl.updateSmartRules('s1');
      await flush();

      const put = calls.find((c) => c.method === 'PUT' && c.url === '/api/playlists/s1');
      expect(put).toBeTruthy();
      expect(put.body).toEqual({
        rules: { bpmMin: 110, bpmMax: 130, namePattern: 'acid.*', tags: ['dark', 'raw'], tagMode: 'all' },
      });
    });

    it('omits empty rule fields (only fills what is set)', async () => {
      const { doc, pl, calls } = bootWithFetch([
        route('PUT', '/api/playlists/s1', {}),
        route('GET', '/api/playlists/s1', { id: 's1', type: 'smart', rules: {}, resolvedTracks: [] }),
        route('GET', '/api/playlists', []),
      ]);
      pl.renderPlaylistDetail({ id: 's1', name: 'S', type: 'smart', rules: {}, resolvedTracks: [] });
      doc.getElementById('smart-bpm-min').value = '90';
      // leave the rest empty
      pl.updateSmartRules('s1');
      await flush();
      const put = calls.find((c) => c.method === 'PUT' && c.url === '/api/playlists/s1');
      expect(put.body).toEqual({ rules: { bpmMin: 90 } });
    });
  });

  // -------------------------------------------------------------------------
  // load-to-queue
  // -------------------------------------------------------------------------
  describe('load-to-queue (#playlist-load-queue-btn)', () => {
    it('POST /api/queue/load-playlist then GET /api/queue (loadQueue refresh)', async () => {
      const { doc, pl, calls } = bootWithFetch([
        route('POST', '/api/queue/load-playlist', { ok: true, loaded: 5, total: 5 }),
        route('GET', '/api/queue', []),
      ]);
      pl.setSelectedPlaylistId('p3');
      doc.getElementById('playlist-load-queue-btn').click();
      await flush();

      const post = calls.find((c) => c.method === 'POST' && c.url === '/api/queue/load-playlist');
      expect(post).toBeTruthy();
      expect(post.body).toEqual({ playlistId: 'p3' });
      // loadQueue's observable effect: a follow-up GET /api/queue
      expect(calls.some((c) => c.method === 'GET' && c.url === '/api/queue')).toBe(true);
    });

    it('does not refresh the queue when the backend reports failure (ok:false)', async () => {
      const { doc, pl, calls } = bootWithFetch([
        route('POST', '/api/queue/load-playlist', { ok: false, error: 'boom' }),
        route('GET', '/api/queue', []),
      ]);
      pl.setSelectedPlaylistId('p3');
      doc.getElementById('playlist-load-queue-btn').click();
      await flush();
      // AS-IS: on ok:false the handler shows an error and does NOT call loadQueue
      expect(calls.some((c) => c.method === 'GET' && c.url === '/api/queue')).toBe(false);
    });

    it('no-op when no playlist is selected', async () => {
      const { doc, pl, calls } = bootWithFetch([]);
      pl.setSelectedPlaylistId(null);
      doc.getElementById('playlist-load-queue-btn').click();
      await flush();
      expect(calls.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // loadForSelect (music part of the former loadPlaylistsForSelect)
  // -------------------------------------------------------------------------
  describe('loadForSelect', () => {
    it('populates #schedule-default-playlist with one option per playlist + a None option', async () => {
      const { doc, pl } = bootWithFetch([
        routeExact('GET', '/api/playlists', [
          { id: 'p1', name: 'One' },
          { id: 'p2', name: 'Two' },
        ]),
        routeExact('GET', '/api/video-playlists', []),
      ]);
      pl.loadForSelect();
      await flush();

      const sel = doc.getElementById('schedule-default-playlist');
      const opts = sel.querySelectorAll('option');
      // "-- None --" + 2 playlists
      expect(opts.length).toBe(3);
      expect(opts[0].value).toBe('');
      expect(opts[1].value).toBe('p1');
      expect(opts[1].textContent).toBe('One');
      expect(opts[2].value).toBe('p2');
    });
  });
});
