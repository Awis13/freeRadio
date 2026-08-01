/**
 * videoplaylists.js — Video-playlists UI for the STUDIO 23 / FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js video-playlists
 * refactor). Owns the selected-playlist state (`selectedVideoPlaylistId`) and
 * renders the video-playlists list + detail (video grid), wires
 * load-queue/activate-profile/delete, drives the smart-rules update button and
 * the create-playlist modal flow.
 *
 * Dependency injection: `init(deps)` receives the host services
 * (authFetch, log, showError, openGenericModal, closeGenericModal). fmtSize is
 * taken from window.FRUtils (loaded before this file). All list / detail / grid
 * DOM nodes are resolved via document.getElementById at call time, exactly as
 * the former app.js closure referenced them. init() also binds the
 * create-video-playlist-btn and the vpl-update-rules-btn (the two DOM binds this
 * domain owns); those handlers reach openGenericModal/closeGenericModal through
 * the injected deps, so they no longer depend on function-hoisting like the old
 * module-scope bindings did.
 *
 * The activate-profile handler reaches the already-extracted visual-profiles
 * module via window.FRVisualProfiles (a sibling global loaded before app.js).
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/videoplaylists.js"> (attaches its public API to
 * window.FRVideoPlaylists) AND required by the vitest suite via module.exports
 * (CJS). It deliberately uses NO top-level `export`/`import` so a browser
 * <script> can load it without a SyntaxError.
 */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.FRVideoPlaylists = api;
  }
})(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Module-owned state (moved out of app.js). Tracks which playlist's detail is
  // currently shown; read at render time to mark the ' selected' list row.
  // -------------------------------------------------------------------------
  var selectedVideoPlaylistId = null;

  // Injected host services (set by init).
  var deps = {
    authFetch: function () { return Promise.reject(new Error('FRVideoPlaylists not initialised')); },
    log: function () {},
    showError: function () {},
    openGenericModal: function () {},
    closeGenericModal: function () {},
  };

  // -------------------------------------------------------------------------
  // Helpers that resolve injected services at call time.
  // -------------------------------------------------------------------------
  function authFetch(url, opts) { return deps.authFetch(url, opts); }
  function log(msg) { return deps.log(msg); }
  function showError(msg) { return deps.showError(msg); }
  function openGenericModal(title, body, onSave) { return deps.openGenericModal(title, body, onSave); }
  function closeGenericModal() { return deps.closeGenericModal(); }

  function fmtSize(bytes) {
    return window.FRUtils.fmtSize(bytes);
  }

  // -------------------------------------------------------------------------
  // Video Playlists (behaviour-identical to the former app.js functions).
  // -------------------------------------------------------------------------
  function loadVideoPlaylists() {
    authFetch('/api/video-playlists')
      .then(function(r) { return r.json(); })
      .then(function(data) { renderVideoPlaylistsList(data); })
      .catch(function(e) { log('video playlists: error: ' + e); });
  }

  function renderVideoPlaylistsList(data) {
    var container = document.getElementById('video-playlists-list');
    container.innerHTML = '';
    var playlists = data || [];
    if (playlists.length === 0) {
      container.innerHTML = '<div class="empty-state">No video playlists</div>';
      return;
    }
    playlists.forEach(function(pl) {
      var div = document.createElement('div');
      div.className = 'vp-item' + (selectedVideoPlaylistId === pl.id ? ' selected' : '');
      div.onclick = function() { selectVideoPlaylist(pl.id); };

      var nameEl = document.createElement('span');
      nameEl.className = 'vp-item-name';
      nameEl.textContent = pl.name;
      div.appendChild(nameEl);

      var typeBadge = document.createElement('span');
      typeBadge.className = 'vp-active-badge';
      typeBadge.textContent = pl.type === 'smart' ? 'SMART' : 'MANUAL';
      typeBadge.style.background = pl.type === 'smart' ? '#8b5cf6' : '#6b7280';
      div.appendChild(typeBadge);

      var count = document.createElement('span');
      count.className = 'vp-count';
      count.textContent = (pl.trackCount || 0) + ' videos';
      div.appendChild(count);

      container.appendChild(div);
    });
  }

  function selectVideoPlaylist(id) {
    selectedVideoPlaylistId = id;
    var detail = document.getElementById('video-playlist-detail');
    detail.style.display = 'block';

    authFetch('/api/video-playlists/' + id)
      .then(function(r) { return r.json(); })
      .then(function(pl) { renderVideoPlaylistDetail(pl); })
      .catch(function(e) { showError('Failed to load video playlist: ' + e); });
  }

  /**
   * Replace a tile grid with an explicit failure state.
   *
   * Never leaves stale tiles behind — they carry onclick handlers bound to
   * whatever entity was rendered when they were built — and never leaves the
   * grid silently blank, which reads as "no videos" rather than "load failed".
   * The retry button re-runs the SAME render for the SAME entity, so it cannot
   * reintroduce the staleness the tiles would have.
   */
  function renderGridFailure(grid, retry) {
    grid.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'empty-state grid-load-failed';

    var msg = document.createElement('span');
    msg.textContent = 'Could not load videos. ';
    box.appendChild(msg);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'grid-retry-btn';
    btn.textContent = 'Retry';
    btn.onclick = retry;
    box.appendChild(btn);

    grid.appendChild(box);
  }

  function renderVideoPlaylistDetail(playlist) {
    document.getElementById('vpl-detail-title').textContent = playlist.name;

    var indicator = document.getElementById('vpl-type-indicator');
    indicator.textContent = playlist.type === 'smart' ? 'Smart playlist — auto-resolves by rules' : 'Manual playlist — click to add/remove';
    indicator.style.cssText = 'padding:6px 10px;margin-bottom:8px;border-radius:4px;font-size:12px;background:#1a1a2e;color:#aaa';

    var smartRules = document.getElementById('vpl-smart-rules');
    if (playlist.type === 'smart') {
      smartRules.style.display = 'block';
      var rules = playlist.rules || {};
      document.getElementById('vpl-name-pattern').value = rules.namePattern || '';
      document.getElementById('vpl-tags').value = (rules.tags || []).join(', ');
      document.getElementById('vpl-tag-mode').value = rules.tagMode || 'any';
    } else {
      smartRules.style.display = 'none';
    }

    var grid = document.getElementById('vpl-video-grid');

    if (playlist.type === 'manual') {
      // A failed load must not leave the previous playlist's tiles on screen:
      // each tile's onclick closes over the id it was rendered for, so a
      // surviving tile would PUT into the OLD playlist while the panel shows
      // the new one. Any failure replaces the grid with a failure state.
      authFetch('/api/visuals-processed')
        .then(function(r) { return r.json(); })
        .then(function(allVideos) {
          if (!Array.isArray(allVideos)) throw new Error('unexpected response');
          grid.innerHTML = '';
          var selectedSet = new Set(playlist.tracks || []);
          var ordered = [];
          (playlist.tracks || []).forEach(function(t) {
            var found = allVideos.find(function(v) { return v.name === t; });
            if (found) ordered.push({ video: found, selected: true });
          });
          allVideos.forEach(function(v) {
            if (!selectedSet.has(v.name)) {
              ordered.push({ video: v, selected: false });
            }
          });

          ordered.forEach(function(item) {
            var div = document.createElement('div');
            div.className = 'video-tile' + (item.selected ? ' selected' : '');
            div.onclick = function() {
              div.classList.toggle('selected');
              saveVideoPlaylistVideos(playlist.id);
            };

            var nameEl = document.createElement('div');
            nameEl.className = 'video-tile-name';
            nameEl.textContent = item.video.name;
            div.appendChild(nameEl);

            var sizeEl = document.createElement('div');
            sizeEl.className = 'video-tile-size';
            sizeEl.textContent = fmtSize(item.video.size);
            div.appendChild(sizeEl);

            grid.appendChild(div);
          });
        })
        .catch(function(e) {
          showError('Failed to load videos: ' + e);
          renderGridFailure(grid, function() { renderVideoPlaylistDetail(playlist); });
        });
    } else {
      grid.innerHTML = '';
      var resolved = playlist.resolvedTracks || [];
      if (resolved.length === 0) {
        grid.innerHTML = '<div class="empty-state">No matching videos</div>';
      } else {
        resolved.forEach(function(name) {
          var div = document.createElement('div');
          div.className = 'video-tile selected';
          div.style.cursor = 'default';

          var nameEl = document.createElement('div');
          nameEl.className = 'video-tile-name';
          nameEl.textContent = name;
          div.appendChild(nameEl);

          grid.appendChild(div);
        });
      }
    }

    document.getElementById('vpl-load-queue-btn').onclick = function() {
      authFetch('/api/video-playlists/' + playlist.id + '/load-queue', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          log('video playlist: loaded ' + data.loaded + ' videos to queue');
        })
        .catch(function(e) { showError('Load to queue failed: ' + e); });
    };

    document.getElementById('vpl-activate-profile-btn').onclick = function() {
      authFetch('/api/video-playlists/' + playlist.id + '/activate-profile', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          log('video playlist: activated as shuffle profile (' + data.activated + ' videos)');
          window.FRVisualProfiles.loadVisualProfiles();
        })
        .catch(function(e) { showError('Activate profile failed: ' + e); });
    };

    document.getElementById('vpl-delete-btn').onclick = function() {
      if (!confirm('Delete video playlist "' + playlist.name + '"?')) return;
      authFetch('/api/video-playlists/' + playlist.id, { method: 'DELETE' })
        .then(function() {
          log('video playlist: deleted ' + playlist.name);
          document.getElementById('video-playlist-detail').style.display = 'none';
          selectedVideoPlaylistId = null;
          loadVideoPlaylists();
        })
        .catch(function(e) { showError('Delete failed: ' + e); });
    };
  }

  function saveVideoPlaylistVideos(playlistId) {
    var grid = document.getElementById('vpl-video-grid');
    var selected = [];
    grid.querySelectorAll('.video-tile.selected').forEach(function(tile) {
      selected.push(tile.querySelector('.video-tile-name').textContent);
    });
    authFetch('/api/video-playlists/' + playlistId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: selected })
    }).catch(function(e) { showError('Save video playlist failed: ' + e); });
  }

  /**
   * Bind the vpl-update-rules-btn onclick (was a module-scope inline statement
   * in app.js). Called from init() — runs AFTER deps are injected. Null-guarded
   * for a missing element.
   */
  function bindUpdateRulesButton() {
    var btn = document.getElementById('vpl-update-rules-btn');
    if (!btn) return;
    btn.onclick = function() {
      if (!selectedVideoPlaylistId) return;
      var tagsRaw = document.getElementById('vpl-tags').value.trim();
      var rules = {
        namePattern: document.getElementById('vpl-name-pattern').value.trim(),
        tags: tagsRaw ? tagsRaw.split(',').map(function(t) { return t.trim(); }).filter(Boolean) : [],
        tagMode: document.getElementById('vpl-tag-mode').value
      };
      authFetch('/api/video-playlists/' + selectedVideoPlaylistId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: rules })
      })
        .then(function() {
          log('video playlist: rules updated');
          selectVideoPlaylist(selectedVideoPlaylistId);
          loadVideoPlaylists();
        })
        .catch(function(e) { showError('Update rules failed: ' + e); });
    };
  }

  /**
   * Bind the create-video-playlist-btn onclick (was a module-scope inline
   * statement in app.js). Called from init() — runs AFTER deps are injected, so
   * the modal handler resolves openGenericModal/closeGenericModal via deps
   * rather than relying on hoisting. Null-guarded for a missing element.
   */
  function bindCreateButton() {
    var btn = document.getElementById('create-video-playlist-btn');
    if (!btn) return;
    btn.onclick = function() {
      openGenericModal('Create Video Playlist',
        '<div class="form-group"><label>Name</label><input type="text" id="new-vpl-name" placeholder="Cyberpunk Visuals"></div>' +
        '<div class="form-group"><label>Type</label><select id="new-vpl-type"><option value="manual">Manual</option><option value="smart">Smart</option></select></div>',
        function() {
          var name = document.getElementById('new-vpl-name').value.trim();
          var type = document.getElementById('new-vpl-type').value;
          if (!name) return;
          authFetch('/api/video-playlists', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, type: type })
          })
            .then(function(r) { return r.json(); })
            .then(function(pl) {
              log('video playlist: created ' + name);
              closeGenericModal();
              loadVideoPlaylists();
              selectVideoPlaylist(pl.id);
            })
            .catch(function(e) { showError('Create failed: ' + e); });
        }
      );
    };
  }

  /**
   * Store injected dependencies, then bind the create + update-rules buttons.
   * Safe to call more than once (the vitest harness re-inits per test with its
   * own deps).
   */
  function init(injected) {
    injected = injected || {};
    window.FRUtils.mergeDeps(deps, injected, 'FRVideoPlaylists');
    bindUpdateRulesButton();
    bindCreateButton();
  }

  return {
    init: init,
    loadVideoPlaylists: loadVideoPlaylists,

    // Surface used by the characterization tests to drive the module.
    renderVideoPlaylistsList: renderVideoPlaylistsList,
    selectVideoPlaylist: selectVideoPlaylist,
    renderVideoPlaylistDetail: renderVideoPlaylistDetail,
    saveVideoPlaylistVideos: saveVideoPlaylistVideos,
    getSelectedVideoPlaylistId: function () { return selectedVideoPlaylistId; },
    setSelectedVideoPlaylistId: function (v) { selectedVideoPlaylistId = v; },
  };
});
