/**
 * tests/dashboard/visualProfilesUI.test.js
 *
 * Characterization pins for the visual-profiles UI, now extracted out of the app.js
 * IIFE into dashboard/public/visualprofiles.js (window.FRVisualProfiles). These tests
 * pin the AS-IS observable contract of the visual-profiles domain functions. They were
 * authored in C1 against the code in app.js and re-pointed in C2 to the extracted
 * module, with assertions unchanged to prove behavioural equivalence.
 *
 * This domain has NO init/dependency-injection surface: window.FRVisualProfiles holds
 * the REAL functions, which use the REAL deps (authFetch -> win.fetch, log, showError,
 * fmtSize = FRUtils.fmtSize). So the only backend control is replacing the boot's
 * never-resolving win.fetch with a recording makeFetchStub AFTER boot, then calling
 * the module fns and asserting DOM (in `doc`) + recorded fetches (stub.calls).
 *
 * Functions pinned (current app.js lines ~1494-1633):
 *   - loadVisualProfiles()           GET /api/visual-profiles -> renderVisualProfilesList
 *   - renderVisualProfilesList(data) builds .vp-item rows from data.profiles
 *   - selectVisualProfile(id)        shows detail, GET /api/visual-profiles/<id> -> detail
 *   - renderVisualProfileDetail(p)   GET /api/visuals -> .video-tile grid + btn wiring
 *   - saveVisualProfileVideos(id)    PUT /api/visual-profiles/<id> body {videos:[...]}
 *   - create-visual-profile-btn      generic modal -> POST /api/visual-profiles
 *
 * AS-IS quirks pinned here (flagged for the C2 extraction):
 *   - renderVisualProfilesList reads data.profiles (an OBJECT wrapper); a bare array
 *     -> empty-state "No visual profiles".
 *   - /api/visuals responds with a BARE ARRAY of {name,size} (different shape).
 *   - the list-item ' selected' class only appears when selectedVisualProfileId === p.id
 *     at render time; ' active' from p.isActive; badge text is literally 'ACTIVE'.
 *   - loadVisualProfiles' error path uses log() (no DOM); select/save/activate/delete/
 *     create use showError() (#error-banner). So the load-failure path has no banner.
 *   - clicking a .video-tile toggles 'selected' AND immediately PUTs the new set.
 *   - delete is gated by confirm('Delete profile "<name>"?').
 */

import { describe, it, expect, afterAll } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, flush, closeAllWindows } from './appBoot.js';

// Close every jsdom window this file booted (rationale in appBoot.js).
afterAll(closeAllWindows);

/**
 * Boot a fresh window and grab the visual-profiles hook. No init/deps to inject —
 * the hook fns are the real closure fns; tests control only win.fetch.
 */
function boot() {
  const { win, doc } = bootWindow();
  const vp = win.FRVisualProfiles;
  return { win, doc, vp };
}

/** Install a recording fetch stub (replacing the never-resolving boot fetch). */
function withFetch(win, routes) {
  const stub = makeFetchStub(routes);
  win.fetch = stub.fetch;
  return stub;
}

describe('visual-profiles UI characterization (window.FRVisualProfiles)', () => {
  it('exposes the 5 fns + selection getter/setter', () => {
    const { vp } = boot();
    expect(vp).toBeTruthy();
    for (const fn of [
      'loadVisualProfiles', 'selectVisualProfile', 'renderVisualProfilesList',
      'renderVisualProfileDetail', 'saveVisualProfileVideos',
      'getSelectedVisualProfileId', 'setSelectedVisualProfileId',
    ]) {
      expect(typeof vp[fn]).toBe('function');
    }
  });

  // -------------------------------------------------------------------------
  // loadVisualProfiles -> renderVisualProfilesList
  // -------------------------------------------------------------------------
  describe('loadVisualProfiles', () => {
    it('GET /api/visual-profiles -> renders one .vp-item per profile (name, count)', async () => {
      const { win, doc, vp } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/visual-profiles', {
          profiles: [
            { id: 'p1', name: 'Day', videoCount: 3 },
            { id: 'p2', name: 'Night', videoCount: 0 },
          ],
        }),
      ]);
      vp.loadVisualProfiles();
      await flush();

      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/visual-profiles')).toBe(true);

      const items = doc.getElementById('visual-profiles-list').querySelectorAll('.vp-item');
      expect(items.length).toBe(2);
      expect(items[0].querySelector('.vp-item-name').textContent).toBe('Day');
      expect(items[0].querySelector('.vp-count').textContent).toBe('3 videos');
      // videoCount missing/zero -> "0 videos"
      expect(items[1].querySelector('.vp-count').textContent).toBe('0 videos');
      // no active badge on a non-active profile
      expect(items[0].querySelector('.vp-active-badge')).toBeNull();
    });

    it('AS-IS: load error path uses log() (no #error-banner)', async () => {
      const { win, doc, vp } = boot();
      // fetch rejects -> the .catch uses log(), which writes no DOM
      win.fetch = () => Promise.reject(new Error('boom'));
      vp.loadVisualProfiles();
      await flush();
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // renderVisualProfilesList — driven directly
  // -------------------------------------------------------------------------
  describe('renderVisualProfilesList', () => {
    it('active profile gets " active" class + an ACTIVE badge', () => {
      const { doc, vp } = boot();
      vp.renderVisualProfilesList({ profiles: [{ id: 'p1', name: 'Live', isActive: true, videoCount: 2 }] });
      const item = doc.getElementById('visual-profiles-list').querySelector('.vp-item');
      expect(item.className).toBe('vp-item active');
      const badge = item.querySelector('.vp-active-badge');
      expect(badge).toBeTruthy();
      expect(badge.textContent).toBe('ACTIVE');
    });

    it('selected profile (selectedVisualProfileId===id at render) gets " selected" class', () => {
      const { doc, vp } = boot();
      vp.setSelectedVisualProfileId('p2');
      vp.renderVisualProfilesList({ profiles: [
        { id: 'p1', name: 'A', videoCount: 0 },
        { id: 'p2', name: 'B', videoCount: 0 },
      ] });
      const items = doc.getElementById('visual-profiles-list').querySelectorAll('.vp-item');
      expect(items[0].className).toBe('vp-item');
      expect(items[1].className).toBe('vp-item selected');
    });

    it('AS-IS: empty profiles list -> "No visual profiles" empty-state', () => {
      const { doc, vp } = boot();
      vp.renderVisualProfilesList({ profiles: [] });
      const container = doc.getElementById('visual-profiles-list');
      expect(container.querySelectorAll('.vp-item').length).toBe(0);
      expect(container.querySelector('.empty-state').textContent).toBe('No visual profiles');
    });

    it('AS-IS: a bare array (no .profiles wrapper) falls through to the empty-state', () => {
      const { doc, vp } = boot();
      // (array).profiles is undefined -> profiles = [] -> empty-state
      vp.renderVisualProfilesList([{ id: 'p1', name: 'X', videoCount: 1 }]);
      const container = doc.getElementById('visual-profiles-list');
      expect(container.querySelectorAll('.vp-item').length).toBe(0);
      expect(container.querySelector('.empty-state').textContent).toBe('No visual profiles');
    });

    it('clicking a list row routes through selectVisualProfile (detail shown + GET fired)', async () => {
      const { win, doc, vp } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/visual-profiles/p1', { id: 'p1', name: 'A', videos: [] }),
        routeExact('GET', '/api/visuals', []),
      ]);
      vp.renderVisualProfilesList({ profiles: [{ id: 'p1', name: 'A', videoCount: 0 }] });
      doc.getElementById('visual-profiles-list').querySelector('.vp-item').onclick();
      await flush();

      expect(doc.getElementById('visual-profile-detail').style.display).toBe('block');
      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/visual-profiles/p1')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // selectVisualProfile -> renderVisualProfileDetail
  // -------------------------------------------------------------------------
  describe('selectVisualProfile + renderVisualProfileDetail', () => {
    it('shows detail synchronously, sets title, and fills the video grid from /api/visuals', async () => {
      const { win, doc, vp } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/visual-profiles/p1', { id: 'p1', name: 'Sunset', videos: ['a.mp4'] }),
        routeExact('GET', '/api/visuals', [
          { name: 'a.mp4', size: 1048576 },
          { name: 'b.mp4', size: 5000 },
        ]),
      ]);

      vp.selectVisualProfile('p1');
      // detail is shown synchronously, before any fetch resolves
      expect(doc.getElementById('visual-profile-detail').style.display).toBe('block');
      // selection state updated synchronously
      expect(vp.getSelectedVisualProfileId()).toBe('p1');

      await flush(10);

      expect(doc.getElementById('vp-detail-title').textContent).toBe('Sunset');
      // both fetches fired, in order
      expect(stub.calls.some((c) => c.url === '/api/visual-profiles/p1')).toBe(true);
      expect(stub.calls.some((c) => c.url === '/api/visuals')).toBe(true);

      const tiles = doc.getElementById('vp-video-grid').querySelectorAll('.video-tile');
      expect(tiles.length).toBe(2);
      // a.mp4 is in profile.videos -> tile gets ' selected'
      expect(tiles[0].className).toBe('video-tile selected');
      expect(tiles[0].querySelector('.video-tile-name').textContent).toBe('a.mp4');
      // 1048576 bytes -> "1.0 MB" (fmtSize)
      expect(tiles[0].querySelector('.video-tile-size').textContent).toBe('1.0 MB');
      // b.mp4 not in the set -> plain class; 5000 bytes -> "4.9 KB"
      expect(tiles[1].className).toBe('video-tile');
      expect(tiles[1].querySelector('.video-tile-size').textContent).toBe('4.9 KB');
    });

    it('clicking a video tile toggles "selected" and PUTs the new {videos:[...]} set', async () => {
      const { win, doc, vp } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/visual-profiles/p1', { id: 'p1', name: 'P', videos: [] }),
        routeExact('GET', '/api/visuals', [{ name: 'clip.mp4', size: 10 }]),
        routeExact('PUT', '/api/visual-profiles/p1', {}),
      ]);
      vp.selectVisualProfile('p1');
      await flush(10);

      const tile = doc.getElementById('vp-video-grid').querySelector('.video-tile');
      expect(tile.className).toBe('video-tile'); // not selected initially
      tile.onclick();
      await flush();

      // toggled on
      expect(tile.classList.contains('selected')).toBe(true);
      // immediate PUT with the now-selected names
      const put = stub.calls.find((c) => c.method === 'PUT' && c.url === '/api/visual-profiles/p1');
      expect(put).toBeTruthy();
      expect(put.body).toEqual({ videos: ['clip.mp4'] });
    });

    it('vp-activate-btn POSTs /activate then reloads the list', async () => {
      const { win, doc, vp } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/visual-profiles/p1', { id: 'p1', name: 'P', videos: [] }),
        routeExact('GET', '/api/visuals', []),
        routeExact('POST', '/api/visual-profiles/p1/activate', {}),
        routeExact('GET', '/api/visual-profiles', { profiles: [] }),
      ]);
      vp.selectVisualProfile('p1');
      await flush();

      doc.getElementById('vp-activate-btn').onclick();
      await flush();

      expect(stub.calls.some((c) => c.method === 'POST' && c.url === '/api/visual-profiles/p1/activate')).toBe(true);
      // activate success reloads the profiles list
      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/visual-profiles')).toBe(true);
    });

    it('vp-delete-btn confirm=true -> DELETE, hides detail, nulls selection, reloads', async () => {
      const { win, doc, vp } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/visual-profiles/p1', { id: 'p1', name: 'P', videos: [] }),
        routeExact('GET', '/api/visuals', []),
        routeExact('DELETE', '/api/visual-profiles/p1', {}),
        routeExact('GET', '/api/visual-profiles', { profiles: [] }),
      ]);
      win.confirm = () => true;
      vp.selectVisualProfile('p1');
      await flush();
      expect(vp.getSelectedVisualProfileId()).toBe('p1');

      doc.getElementById('vp-delete-btn').onclick();
      await flush();

      expect(stub.calls.some((c) => c.method === 'DELETE' && c.url === '/api/visual-profiles/p1')).toBe(true);
      expect(doc.getElementById('visual-profile-detail').style.display).toBe('none');
      expect(vp.getSelectedVisualProfileId()).toBeNull();
      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/visual-profiles')).toBe(true);
    });

    it('vp-delete-btn confirm=false -> no DELETE fired', async () => {
      const { win, doc, vp } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/visual-profiles/p1', { id: 'p1', name: 'P', videos: [] }),
        routeExact('GET', '/api/visuals', []),
      ]);
      win.confirm = () => false;
      vp.selectVisualProfile('p1');
      await flush();

      doc.getElementById('vp-delete-btn').onclick();
      await flush();

      expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(false);
      // detail stays visible, selection unchanged
      expect(doc.getElementById('visual-profile-detail').style.display).toBe('block');
      expect(vp.getSelectedVisualProfileId()).toBe('p1');
    });

    it('a failed video-grid load shows the error and an explicit failure state', async () => {
      // CHANGED IN T14-C1 (reworked). Originally the chain had no .catch and a
      // failed load left an unexplained blank grid plus an unhandled rejection.
      // Preserving the old tiles instead was WORSE: each tile's onclick closes
      // over the profile id it was rendered for, so a surviving tile PUTs into
      // the previous profile while the panel shows the new one. The grid is
      // therefore cleared and replaced with a non-clickable failure state.
      const { win, doc, vp } = boot();
      const grid = doc.getElementById('vp-video-grid');
      grid.innerHTML = '<div class="video-tile selected"><div class="video-tile-name">a.mp4</div></div>';

      win.fetch = () => Promise.reject(new Error('offline'));
      vp.renderVisualProfileDetail({ id: 'p1', name: 'Sunset', videos: ['a.mp4'] });
      await flush(10);

      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);
      expect(banner.textContent).toContain('Failed to load videos');

      // No stale tiles, and not a silent blank either.
      expect(grid.querySelectorAll('.video-tile').length).toBe(0);
      expect(grid.querySelector('.grid-load-failed')).toBeTruthy();
      expect(grid.textContent).toContain('Could not load videos');
    });

    it('a body that is not the expected array is treated as a failure too', async () => {
      // authFetch resolves on a 500, so the render would otherwise walk an
      // error object as if it were the video list.
      const { win, doc, vp } = boot();
      win.fetch = () => Promise.resolve({
        ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }),
      });
      vp.renderVisualProfileDetail({ id: 'p1', name: 'Sunset', videos: [] });
      await flush(10);

      const grid = doc.getElementById('vp-video-grid');
      expect(grid.querySelectorAll('.video-tile').length).toBe(0);
      expect(grid.querySelector('.grid-load-failed')).toBeTruthy();
    });

    it('an IN-FLIGHT load leaves no clickable tile from the previous profile', async () => {
      // ADDED IN THE TRACK-CLOSE HOTFIX. The failure paths were covered; the
      // window BEFORE resolution was not. The title is written synchronously,
      // so between navigating to a profile and its videos arriving the panel
      // said "Second" while still showing First's tiles — each wired to p1.
      // A click in that window saved into the profile the user had left.
      const { win, doc, vp } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/visuals', [{ name: 'a.mp4', size: 10 }]),
      ]);
      vp.renderVisualProfileDetail({ id: 'p1', name: 'First', videos: ['a.mp4'] });
      await flush(10);
      expect(doc.getElementById('vp-video-grid').querySelectorAll('.video-tile').length).toBe(1);

      // Second render whose fetch never settles — the in-flight state, held.
      win.fetch = () => new Promise(() => {});
      vp.renderVisualProfileDetail({ id: 'p2', name: 'Second', videos: [] });
      await flush(10);

      const grid = doc.getElementById('vp-video-grid');
      expect(doc.getElementById('vp-detail-title').textContent).toBe('Second');
      expect(grid.querySelectorAll('.video-tile').length).toBe(0);

      // Nothing left to click means nothing can PUT, least of all into p1.
      stub.calls.length = 0;
      grid.querySelectorAll('*').forEach((el) => { if (el.onclick) el.onclick(); });
      await flush(10);
      expect(stub.calls.filter((c) => c.method === 'PUT').length).toBe(0);
    });

    it('navigating on clears a failure box left by the previous profile', async () => {
      // The retry button in a failure box closes over the profile that failed.
      // Left standing while a third profile loads, it offers to re-render the
      // wrong one under the new title.
      const { win, doc, vp } = boot();
      win.fetch = () => Promise.reject(new Error('offline'));
      vp.renderVisualProfileDetail({ id: 'p2', name: 'Second', videos: [] });
      await flush(10);
      const grid = doc.getElementById('vp-video-grid');
      expect(grid.querySelector('.grid-load-failed')).toBeTruthy();

      win.fetch = () => new Promise(() => {});
      vp.renderVisualProfileDetail({ id: 'p3', name: 'Third', videos: [] });
      await flush(10);

      expect(doc.getElementById('vp-detail-title').textContent).toBe('Third');
      expect(grid.querySelector('.grid-load-failed')).toBeNull();
    });

    it('a failed render cannot leave a tile that saves into the PREVIOUS profile', async () => {
      // The regression this contract exists to prevent: render A, then have
      // render B fail, then click whatever is left. Nothing clickable may
      // remain, so no PUT can fire at all — least of all one carrying p1.
      const { win, doc, vp } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/visuals', [{ name: 'a.mp4', size: 10 }]),
      ]);
      vp.renderVisualProfileDetail({ id: 'p1', name: 'First', videos: ['a.mp4'] });
      await flush(10);
      const grid = doc.getElementById('vp-video-grid');
      expect(grid.querySelectorAll('.video-tile').length).toBe(1);

      win.fetch = () => Promise.reject(new Error('offline'));
      vp.renderVisualProfileDetail({ id: 'p2', name: 'Second', videos: [] });
      await flush(10);

      const tiles = grid.querySelectorAll('.video-tile');
      expect(tiles.length).toBe(0);
      const before = stub.calls.length;
      grid.querySelectorAll('div').forEach((el) => el.onclick && el.onclick());
      await flush(10);
      expect(stub.calls.slice(before).filter((c) => c.method === 'PUT')).toEqual([]);
    });

    it('select error path -> showError writes #error-banner', async () => {
      const { win, doc, vp } = boot();
      win.fetch = () => Promise.reject(new Error('nope'));
      vp.selectVisualProfile('p1');
      await flush();
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);
      expect(banner.textContent).toContain('Failed to load profile');
    });
  });

  // -------------------------------------------------------------------------
  // saveVisualProfileVideos — driven directly
  // -------------------------------------------------------------------------
  describe('saveVisualProfileVideos', () => {
    it('PUTs the names of the currently .selected tiles in the grid', async () => {
      const { win, doc, vp } = boot();
      const stub = withFetch(win, [routeExact('PUT', '/api/visual-profiles/p9', {})]);
      // hand-build a grid with one selected + one not
      const grid = doc.getElementById('vp-video-grid');
      grid.innerHTML =
        '<div class="video-tile selected"><div class="video-tile-name">one.mp4</div></div>' +
        '<div class="video-tile"><div class="video-tile-name">two.mp4</div></div>';
      vp.saveVisualProfileVideos('p9');
      await flush();

      const put = stub.calls.find((c) => c.method === 'PUT' && c.url === '/api/visual-profiles/p9');
      expect(put).toBeTruthy();
      // only the selected tile's name is in the body
      expect(put.body).toEqual({ videos: ['one.mp4'] });
    });
  });

  // -------------------------------------------------------------------------
  // create-visual-profile-btn — generic modal -> POST (drives the REAL button,
  // create is not exposed via window.FRVisualProfiles' public surface)
  // -------------------------------------------------------------------------
  describe('create flow (real #create-visual-profile-btn)', () => {
    it('opens the modal, then save POSTs {name, videos:[]} and selects the new profile', async () => {
      const { win, doc, vp } = boot();
      const stub = withFetch(win, [
        routeExact('POST', '/api/visual-profiles', { id: 'new1' }),
        // create success calls selectVisualProfile(p.id) -> these two fire
        routeExact('GET', '/api/visual-profiles/new1', { id: 'new1', name: 'Night Visuals', videos: [] }),
        routeExact('GET', '/api/visuals', []),
        routeExact('GET', '/api/visual-profiles', { profiles: [] }),
      ]);

      // open the generic modal (injects #new-vp-name into #generic-modal-body)
      doc.getElementById('create-visual-profile-btn').onclick();
      expect(doc.getElementById('generic-modal').style.display).toBe('flex');
      expect(doc.getElementById('generic-modal-title').textContent).toBe('Create Visual Profile');

      const nameInput = doc.getElementById('new-vp-name');
      expect(nameInput).toBeTruthy();
      nameInput.value = 'Night Visuals';

      // fire the modal save -> runs the onSave callback
      doc.getElementById('generic-modal-save').onclick();
      await flush();

      const post = stub.calls.find((c) => c.method === 'POST' && c.url === '/api/visual-profiles');
      expect(post).toBeTruthy();
      expect(post.body).toEqual({ name: 'Night Visuals', videos: [] });
      // success closes the modal and selects the new profile
      expect(doc.getElementById('generic-modal').style.display).toBe('none');
      expect(vp.getSelectedVisualProfileId()).toBe('new1');
    });

    it('AS-IS: empty name -> onSave early-returns, no POST', async () => {
      const { win, doc } = boot();
      const stub = withFetch(win, [routeExact('POST', '/api/visual-profiles', { id: 'x' })]);
      doc.getElementById('create-visual-profile-btn').onclick();
      doc.getElementById('new-vp-name').value = '   '; // whitespace -> trim() empty
      doc.getElementById('generic-modal-save').onclick();
      await flush();
      expect(stub.calls.some((c) => c.method === 'POST')).toBe(false);
    });
  });
});
