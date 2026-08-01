/**
 * tests/dashboard/videoPlaylistsUI.test.js
 *
 * Characterization pins (C1) for the VIDEO-PLAYLISTS UI domain. This domain still
 * lives inside the app.js IIFE; C1 only adds a test-only hook (window.__appVideoPlaylists,
 * sibling of window.__appDrift, guarded by window.__APP_TEST__) exposing the 5 domain
 * fns + a getter/setter for selectedVideoPlaylistId. No function is moved/renamed.
 *
 * These tests pin the AS-IS observable contract so that C2 (extraction into
 * dashboard/public/videoplaylists.js) can re-point them and prove equivalence.
 *
 * Domain functions pinned (current app.js lines 1293-1513):
 *   - loadVideoPlaylists()              GET /api/video-playlists -> renderVideoPlaylistsList
 *   - renderVideoPlaylistsList(data)    builds .vp-item rows from a BARE ARRAY (data||[])
 *   - selectVideoPlaylist(id)           shows detail, GET /api/video-playlists/<id> -> detail
 *   - renderVideoPlaylistDetail(pl)     manual: GET /api/visuals-processed -> .video-tile grid
 *                                       smart : resolvedTracks read-only tiles
 *   - saveVideoPlaylistVideos(id)       PUT /api/video-playlists/<id> body {tracks:[...]}
 *   - create-video-playlist-btn         generic modal -> POST /api/video-playlists {name,type}
 *
 * AS-IS quirks pinned here (flagged for C2):
 *   - renderVideoPlaylistsList reads a BARE ARRAY (data||[]), NOT data.profiles. A
 *     {profiles:[...]} wrapper would have undefined .length and is NOT pinned here.
 *   - the type badge reuses the .vp-active-badge class but carries 'SMART'/'MANUAL'
 *     (default/undefined type -> 'MANUAL'); there is NO active/isActive concept.
 *   - count field is pl.trackCount (not videoCount); literal label is 'videos'.
 *   - the manual video list endpoint is /api/visuals-processed (a BARE ARRAY of {name,size}).
 *   - manual tiles are ordered SELECTED-FIRST; an unmatched track name is dropped.
 *   - smart tiles are read-only (style.cursor='default', no onclick, no .video-tile-size).
 *   - saveVideoPlaylistVideos PUT body key is {tracks:[...]}; create POST body is {name,type}.
 *   - loadVideoPlaylists' error path uses log() (no #error-banner); select/save/delete/
 *     activate/load-queue/create/update-rules use showError() (#error-banner 'visible').
 *   - #vpl-delete-btn .then chains off the RAW response (no r.json()); confirm gated.
 *   - activate-profile success calls FRVisualProfiles.loadVisualProfiles() (cross-domain).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, flush, closeAllWindows } from './appBoot.js';

// Close every jsdom window this file booted (rationale in appBoot.js).
afterAll(closeAllWindows);

/** Boot a fresh window and grab the (C1) video-playlists hook. */
function boot() {
  const { win, doc } = bootWindow();
  const vpl = win.FRVideoPlaylists;
  return { win, doc, vpl };
}

/** Install a recording fetch stub (replacing the never-resolving boot fetch). */
function withFetch(win, routes) {
  const stub = makeFetchStub(routes);
  win.fetch = stub.fetch;
  return stub;
}

describe('video-playlists UI characterization (window.FRVideoPlaylists)', () => {
  it('exposes the 5 fns + selection getter/setter', () => {
    const { vpl } = boot();
    expect(vpl).toBeTruthy();
    for (const fn of [
      'loadVideoPlaylists', 'renderVideoPlaylistsList', 'selectVideoPlaylist',
      'renderVideoPlaylistDetail', 'saveVideoPlaylistVideos',
      'getSelectedVideoPlaylistId', 'setSelectedVideoPlaylistId',
    ]) {
      expect(typeof vpl[fn]).toBe('function');
    }
    // initial selection state is null
    expect(vpl.getSelectedVideoPlaylistId()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // loadVideoPlaylists -> renderVideoPlaylistsList
  // -------------------------------------------------------------------------
  describe('loadVideoPlaylists', () => {
    it('GET /api/video-playlists -> renders one .vp-item per playlist (name, type badge, count)', async () => {
      const { win, doc, vpl } = boot();
      const stub = withFetch(win, [
        // AS-IS: response is a BARE ARRAY, not {profiles:[...]}
        routeExact('GET', '/api/video-playlists', [
          { id: 'p1', name: 'Day', type: 'smart', trackCount: 3 },
          { id: 'p2', name: 'Night', type: 'manual', trackCount: 0 },
          { id: 'p3', name: 'Untyped' }, // no type -> 'MANUAL', no trackCount -> '0 videos'
        ]),
      ]);
      vpl.loadVideoPlaylists();
      await flush();

      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/video-playlists')).toBe(true);

      const items = doc.getElementById('video-playlists-list').querySelectorAll('.vp-item');
      expect(items.length).toBe(3);

      expect(items[0].querySelector('.vp-item-name').textContent).toBe('Day');
      expect(items[0].querySelector('.vp-active-badge').textContent).toBe('SMART');
      expect(items[0].querySelector('.vp-active-badge').style.background).toBe('rgb(139, 92, 246)');
      expect(items[0].querySelector('.vp-count').textContent).toBe('3 videos');

      expect(items[1].querySelector('.vp-active-badge').textContent).toBe('MANUAL');
      expect(items[1].querySelector('.vp-active-badge').style.background).toBe('rgb(107, 114, 128)');
      expect(items[1].querySelector('.vp-count').textContent).toBe('0 videos');

      // missing type defaults to MANUAL; missing trackCount -> '0 videos'
      expect(items[2].querySelector('.vp-active-badge').textContent).toBe('MANUAL');
      expect(items[2].querySelector('.vp-count').textContent).toBe('0 videos');
    });

    it('AS-IS: load error path uses log() (no #error-banner)', async () => {
      const { win, doc, vpl } = boot();
      win.fetch = () => Promise.reject(new Error('boom'));
      vpl.loadVideoPlaylists();
      await flush();
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // renderVideoPlaylistsList — driven directly
  // -------------------------------------------------------------------------
  describe('renderVideoPlaylistsList', () => {
    it('selected playlist (selectedVideoPlaylistId===id at render) gets " selected" class', () => {
      const { doc, vpl } = boot();
      vpl.setSelectedVideoPlaylistId('p2');
      vpl.renderVideoPlaylistsList([
        { id: 'p1', name: 'A', type: 'manual', trackCount: 0 },
        { id: 'p2', name: 'B', type: 'manual', trackCount: 0 },
      ]);
      const items = doc.getElementById('video-playlists-list').querySelectorAll('.vp-item');
      expect(items[0].className).toBe('vp-item');
      expect(items[1].className).toBe('vp-item selected');
    });

    it('AS-IS: empty array -> "No video playlists" empty-state', () => {
      const { doc, vpl } = boot();
      vpl.renderVideoPlaylistsList([]);
      const container = doc.getElementById('video-playlists-list');
      expect(container.querySelectorAll('.vp-item').length).toBe(0);
      expect(container.querySelector('.empty-state').textContent).toBe('No video playlists');
    });

    it('AS-IS: null data -> data||[] -> empty-state', () => {
      const { doc, vpl } = boot();
      vpl.renderVideoPlaylistsList(null);
      const container = doc.getElementById('video-playlists-list');
      expect(container.querySelector('.empty-state').textContent).toBe('No video playlists');
    });

    it('clicking a list row routes through selectVideoPlaylist (detail shown + GET fired)', async () => {
      const { win, doc, vpl } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/video-playlists/p1', { id: 'p1', name: 'A', type: 'smart', resolvedTracks: [] }),
      ]);
      vpl.renderVideoPlaylistsList([{ id: 'p1', name: 'A', type: 'smart', trackCount: 0 }]);
      doc.getElementById('video-playlists-list').querySelector('.vp-item').onclick();
      await flush();

      expect(doc.getElementById('video-playlist-detail').style.display).toBe('block');
      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/video-playlists/p1')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // selectVideoPlaylist -> renderVideoPlaylistDetail
  // -------------------------------------------------------------------------
  describe('selectVideoPlaylist + renderVideoPlaylistDetail (manual branch)', () => {
    it('a failed video-grid load shows the error and LEAVES THE GRID INTACT', async () => {
      // CHANGED IN T14-C1, same reason as the visual-profiles twin: no .catch
      // and a pre-fetch clear meant a transient failure emptied the grid, and
      // saveVideoPlaylistVideos saves exactly what the grid holds.
      const { win, doc, vpl } = boot();
      const grid = doc.getElementById('vpl-video-grid');
      grid.innerHTML = '<div class="video-tile selected"><div class="video-tile-name">b.mp4</div></div>';

      win.fetch = (url) => (String(url).indexOf('/api/visuals-processed') !== -1
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }));

      vpl.renderVideoPlaylistDetail({ id: 'p1', name: 'Sunset', type: 'manual', tracks: ['b.mp4'] });
      await flush(10);

      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);
      expect(banner.textContent).toContain('Failed to load videos');
      expect(grid.querySelectorAll('.video-tile').length).toBe(1);
      expect(grid.querySelector('.video-tile-name').textContent).toBe('b.mp4');
    });

    it('shows detail synchronously, sets selection, title, indicator + SELECTED-FIRST tiles from /api/visuals-processed', async () => {
      const { win, doc, vpl } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/video-playlists/p1', {
          id: 'p1', name: 'Sunset', type: 'manual', tracks: ['b.mp4'],
        }),
        routeExact('GET', '/api/visuals-processed', [
          { name: 'a.mp4', size: 5000 },
          { name: 'b.mp4', size: 1048576 },
        ]),
      ]);

      vpl.selectVideoPlaylist('p1');
      // detail shown + selection set synchronously, before any fetch resolves
      expect(doc.getElementById('video-playlist-detail').style.display).toBe('block');
      expect(vpl.getSelectedVideoPlaylistId()).toBe('p1');

      await flush(10);

      expect(doc.getElementById('vpl-detail-title').textContent).toBe('Sunset');
      expect(doc.getElementById('vpl-type-indicator').textContent).toBe('Manual playlist — click to add/remove');
      // smart-rules panel hidden for manual
      expect(doc.getElementById('vpl-smart-rules').style.display).toBe('none');

      expect(stub.calls.some((c) => c.url === '/api/video-playlists/p1')).toBe(true);
      expect(stub.calls.some((c) => c.url === '/api/visuals-processed')).toBe(true);

      const tiles = doc.getElementById('vpl-video-grid').querySelectorAll('.video-tile');
      expect(tiles.length).toBe(2);
      // SELECTED-FIRST: b.mp4 (in tracks) comes first, selected
      expect(tiles[0].className).toBe('video-tile selected');
      expect(tiles[0].querySelector('.video-tile-name').textContent).toBe('b.mp4');
      // 1048576 bytes -> "1.0 MB" (fmtSize)
      expect(tiles[0].querySelector('.video-tile-size').textContent).toBe('1.0 MB');
      // a.mp4 not selected -> plain class; 5000 bytes -> "4.9 KB"
      expect(tiles[1].className).toBe('video-tile');
      expect(tiles[1].querySelector('.video-tile-name').textContent).toBe('a.mp4');
      expect(tiles[1].querySelector('.video-tile-size').textContent).toBe('4.9 KB');
    });

    it('AS-IS: a track name with no matching processed video is silently dropped', async () => {
      const { win, doc, vpl } = boot();
      withFetch(win, [
        routeExact('GET', '/api/video-playlists/p1', {
          id: 'p1', name: 'P', type: 'manual', tracks: ['ghost.mp4', 'real.mp4'],
        }),
        routeExact('GET', '/api/visuals-processed', [{ name: 'real.mp4', size: 10 }]),
      ]);
      vpl.selectVideoPlaylist('p1');
      await flush(10);

      const tiles = doc.getElementById('vpl-video-grid').querySelectorAll('.video-tile');
      expect(tiles.length).toBe(1);
      expect(tiles[0].className).toBe('video-tile selected');
      expect(tiles[0].querySelector('.video-tile-name').textContent).toBe('real.mp4');
    });

    it('clicking a manual tile toggles "selected" and PUTs the new {tracks:[...]} set', async () => {
      const { win, doc, vpl } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/video-playlists/p1', { id: 'p1', name: 'P', type: 'manual', tracks: [] }),
        routeExact('GET', '/api/visuals-processed', [{ name: 'clip.mp4', size: 10 }]),
        routeExact('PUT', '/api/video-playlists/p1', {}),
      ]);
      vpl.selectVideoPlaylist('p1');
      await flush(10);

      const tile = doc.getElementById('vpl-video-grid').querySelector('.video-tile');
      expect(tile.className).toBe('video-tile'); // not selected initially
      tile.onclick();
      await flush();

      expect(tile.classList.contains('selected')).toBe(true);
      const put = stub.calls.find((c) => c.method === 'PUT' && c.url === '/api/video-playlists/p1');
      expect(put).toBeTruthy();
      // AS-IS body key is {tracks:[...]}, NOT {videos:[...]}
      expect(put.body).toEqual({ tracks: ['clip.mp4'] });
    });

    it('select error path -> showError writes #error-banner', async () => {
      const { win, doc, vpl } = boot();
      win.fetch = () => Promise.reject(new Error('nope'));
      vpl.selectVideoPlaylist('p1');
      await flush();
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);
      expect(banner.textContent).toContain('Failed to load video playlist');
    });
  });

  describe('renderVideoPlaylistDetail (smart branch)', () => {
    it('smart playlist: shows rules panel + read-only resolved tiles (no size, no onclick)', () => {
      const { doc, vpl } = boot();
      vpl.renderVideoPlaylistDetail({
        id: 'p1', name: 'Auto', type: 'smart',
        rules: { namePattern: 'neon*', tags: ['city', 'night'], tagMode: 'all' },
        resolvedTracks: ['one.mp4', 'two.mp4'],
      });

      expect(doc.getElementById('vpl-detail-title').textContent).toBe('Auto');
      expect(doc.getElementById('vpl-type-indicator').textContent).toBe('Smart playlist — auto-resolves by rules');

      // rules panel shown + populated from playlist.rules
      expect(doc.getElementById('vpl-smart-rules').style.display).toBe('block');
      expect(doc.getElementById('vpl-name-pattern').value).toBe('neon*');
      expect(doc.getElementById('vpl-tags').value).toBe('city, night');
      expect(doc.getElementById('vpl-tag-mode').value).toBe('all');

      const tiles = doc.getElementById('vpl-video-grid').querySelectorAll('.video-tile');
      expect(tiles.length).toBe(2);
      expect(tiles[0].className).toBe('video-tile selected');
      expect(tiles[0].style.cursor).toBe('default');
      expect(tiles[0].onclick).toBeNull();
      expect(tiles[0].querySelector('.video-tile-name').textContent).toBe('one.mp4');
      // no size element in the read-only branch
      expect(tiles[0].querySelector('.video-tile-size')).toBeNull();
    });

    it('smart playlist with empty resolvedTracks -> "No matching videos" empty-state', () => {
      const { doc, vpl } = boot();
      vpl.renderVideoPlaylistDetail({ id: 'p1', name: 'Empty', type: 'smart', resolvedTracks: [] });
      const grid = doc.getElementById('vpl-video-grid');
      expect(grid.querySelectorAll('.video-tile').length).toBe(0);
      expect(grid.querySelector('.empty-state').textContent).toBe('No matching videos');
    });
  });

  // -------------------------------------------------------------------------
  // detail action buttons (rebound on every render, close over `playlist`)
  // -------------------------------------------------------------------------
  describe('detail action buttons', () => {
    it('#vpl-load-queue-btn POSTs /load-queue', async () => {
      const { win, doc, vpl } = boot();
      const stub = withFetch(win, [
        routeExact('POST', '/api/video-playlists/p1/load-queue', { loaded: 4 }),
      ]);
      vpl.renderVideoPlaylistDetail({ id: 'p1', name: 'P', type: 'smart', resolvedTracks: ['x'] });
      doc.getElementById('vpl-load-queue-btn').onclick();
      await flush();
      expect(stub.calls.some((c) => c.method === 'POST' && c.url === '/api/video-playlists/p1/load-queue')).toBe(true);
    });

    it('#vpl-activate-profile-btn POSTs /activate-profile THEN calls FRVisualProfiles.loadVisualProfiles()', async () => {
      const { win, doc, vpl } = boot();
      const stub = withFetch(win, [
        routeExact('POST', '/api/video-playlists/p1/activate-profile', { activated: 7 }),
        // cross-domain call fires GET /api/visual-profiles via FRVisualProfiles
        routeExact('GET', '/api/visual-profiles', { profiles: [] }),
      ]);
      vpl.renderVideoPlaylistDetail({ id: 'p1', name: 'P', type: 'smart', resolvedTracks: ['x'] });
      doc.getElementById('vpl-activate-profile-btn').onclick();
      await flush(10);

      expect(stub.calls.some((c) => c.method === 'POST' && c.url === '/api/video-playlists/p1/activate-profile')).toBe(true);
      // cross-domain reach into the already-extracted visual-profiles module
      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/visual-profiles')).toBe(true);
    });

    it('#vpl-delete-btn confirm=true -> DELETE, hides detail, nulls selection, reloads', async () => {
      const { win, doc, vpl } = boot();
      const stub = withFetch(win, [
        routeExact('DELETE', '/api/video-playlists/p1', {}),
        routeExact('GET', '/api/video-playlists', []),
      ]);
      win.confirm = () => true;
      vpl.setSelectedVideoPlaylistId('p1');
      doc.getElementById('video-playlist-detail').style.display = 'block';
      vpl.renderVideoPlaylistDetail({ id: 'p1', name: 'P', type: 'smart', resolvedTracks: [] });

      doc.getElementById('vpl-delete-btn').onclick();
      await flush();

      expect(stub.calls.some((c) => c.method === 'DELETE' && c.url === '/api/video-playlists/p1')).toBe(true);
      expect(doc.getElementById('video-playlist-detail').style.display).toBe('none');
      expect(vpl.getSelectedVideoPlaylistId()).toBeNull();
      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/video-playlists')).toBe(true);
    });

    it('#vpl-delete-btn confirm=false -> no DELETE fired', async () => {
      const { win, doc, vpl } = boot();
      const stub = withFetch(win, [routeExact('DELETE', '/api/video-playlists/p1', {})]);
      win.confirm = () => false;
      doc.getElementById('video-playlist-detail').style.display = 'block';
      vpl.renderVideoPlaylistDetail({ id: 'p1', name: 'P', type: 'smart', resolvedTracks: [] });

      doc.getElementById('vpl-delete-btn').onclick();
      await flush();

      expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(false);
      expect(doc.getElementById('video-playlist-detail').style.display).toBe('block');
    });
  });

  // -------------------------------------------------------------------------
  // saveVideoPlaylistVideos — driven directly
  // -------------------------------------------------------------------------
  describe('saveVideoPlaylistVideos', () => {
    it('PUTs the names of the currently .selected tiles as {tracks:[...]}', async () => {
      const { win, doc, vpl } = boot();
      const stub = withFetch(win, [routeExact('PUT', '/api/video-playlists/p9', {})]);
      const grid = doc.getElementById('vpl-video-grid');
      grid.innerHTML =
        '<div class="video-tile selected"><div class="video-tile-name">one.mp4</div></div>' +
        '<div class="video-tile"><div class="video-tile-name">two.mp4</div></div>' +
        '<div class="video-tile selected"><div class="video-tile-name">three.mp4</div></div>';
      vpl.saveVideoPlaylistVideos('p9');
      await flush();

      const put = stub.calls.find((c) => c.method === 'PUT' && c.url === '/api/video-playlists/p9');
      expect(put).toBeTruthy();
      expect(put.body).toEqual({ tracks: ['one.mp4', 'three.mp4'] });
    });

    it('save error path -> showError writes #error-banner', async () => {
      const { win, doc, vpl } = boot();
      win.fetch = () => Promise.reject(new Error('nope'));
      vpl.saveVideoPlaylistVideos('p9');
      await flush();
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);
      expect(banner.textContent).toContain('Save video playlist failed');
    });
  });

  // -------------------------------------------------------------------------
  // module-level handlers (bound once at app load), driven via real DOM
  // -------------------------------------------------------------------------
  describe('#vpl-update-rules-btn (module-level)', () => {
    it('AS-IS: no selection -> early return, no PUT', async () => {
      const { win, doc, vpl } = boot();
      const stub = withFetch(win, [routeExact('PUT', '/api/video-playlists/p1', {})]);
      vpl.setSelectedVideoPlaylistId(null);
      doc.getElementById('vpl-update-rules-btn').onclick();
      await flush();
      expect(stub.calls.some((c) => c.method === 'PUT')).toBe(false);
    });

    it('with selection -> PUTs {rules:{namePattern,tags,tagMode}} from the inputs', async () => {
      const { win, doc, vpl } = boot();
      const stub = withFetch(win, [
        routeExact('PUT', '/api/video-playlists/p1', {}),
        // .then re-selects + reloads
        routeExact('GET', '/api/video-playlists/p1', { id: 'p1', name: 'P', type: 'smart', resolvedTracks: [] }),
        routeExact('GET', '/api/video-playlists', []),
      ]);
      vpl.setSelectedVideoPlaylistId('p1');
      doc.getElementById('vpl-name-pattern').value = 'neon*';
      doc.getElementById('vpl-tags').value = ' city , night , ';
      doc.getElementById('vpl-tag-mode').value = 'all';

      doc.getElementById('vpl-update-rules-btn').onclick();
      await flush(10);

      const put = stub.calls.find((c) => c.method === 'PUT' && c.url === '/api/video-playlists/p1');
      expect(put).toBeTruthy();
      // tags split on ',' + trim + filter(Boolean) -> trailing empty dropped
      expect(put.body).toEqual({ rules: { namePattern: 'neon*', tags: ['city', 'night'], tagMode: 'all' } });
    });
  });

  // -------------------------------------------------------------------------
  // create-video-playlist-btn — generic modal -> POST (real button)
  // -------------------------------------------------------------------------
  describe('create flow (real #create-video-playlist-btn)', () => {
    it('opens the modal, then save POSTs {name,type} and selects the new playlist', async () => {
      const { win, doc, vpl } = boot();
      const stub = withFetch(win, [
        routeExact('POST', '/api/video-playlists', { id: 'new1' }),
        // create success -> loadVideoPlaylists + selectVideoPlaylist('new1')
        routeExact('GET', '/api/video-playlists', []),
        routeExact('GET', '/api/video-playlists/new1', { id: 'new1', name: 'Cyber', type: 'smart', resolvedTracks: [] }),
      ]);

      doc.getElementById('create-video-playlist-btn').onclick();
      expect(doc.getElementById('generic-modal').style.display).toBe('flex');
      expect(doc.getElementById('generic-modal-title').textContent).toBe('Create Video Playlist');

      doc.getElementById('new-vpl-name').value = 'Cyber';
      doc.getElementById('new-vpl-type').value = 'smart';

      doc.getElementById('generic-modal-save').onclick();
      await flush(10);

      const post = stub.calls.find((c) => c.method === 'POST' && c.url === '/api/video-playlists');
      expect(post).toBeTruthy();
      expect(post.body).toEqual({ name: 'Cyber', type: 'smart' });
      // success closes the modal and selects the new playlist
      expect(doc.getElementById('generic-modal').style.display).toBe('none');
      expect(vpl.getSelectedVideoPlaylistId()).toBe('new1');
    });

    it('AS-IS: empty name -> onSave early-returns, no POST', async () => {
      const { win, doc } = boot();
      const stub = withFetch(win, [routeExact('POST', '/api/video-playlists', { id: 'x' })]);
      doc.getElementById('create-video-playlist-btn').onclick();
      doc.getElementById('new-vpl-name').value = '   '; // whitespace -> trim() empty
      doc.getElementById('generic-modal-save').onclick();
      await flush();
      expect(stub.calls.some((c) => c.method === 'POST')).toBe(false);
    });
  });
});
