/**
 * playlists.js — Music-playlists UI for the STUDIO 23 / FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js playlists refactor).
 * Owns the music-playlists state (`playlists`, `selectedPlaylistId`) and renders
 * the playlists list, the per-playlist detail (manual vs smart), the track
 * library, and wires the create / delete / load-to-queue / import handlers.
 *
 * Dependency injection: this module performs no global lookups for shared app
 * state or services. `init(deps)` receives the host services
 * (authFetch, log, showError, openGenericModal, closeGenericModal, loadQueue)
 * and live getters for shared state (getMusicFiles, getBpmMap) that are read AT
 * CALL TIME, never cached. escapeHtml is taken from window.FRUtils (loaded
 * before this file).
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/playlists.js"> (attaches its public API to window.FRPlaylists)
 * AND required by the vitest suite via module.exports (CJS). It deliberately
 * uses NO top-level `export`/`import` so a browser <script> can load it without
 * a SyntaxError.
 */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.FRPlaylists = api;
  }
})(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Module-owned state (moved out of app.js).
  // -------------------------------------------------------------------------
  var playlists = [];
  var selectedPlaylistId = null;

  // Test-only fallbacks for the shared music state. In the browser these are
  // provided by app.js via deps.getMusicFiles()/getBpmMap(); the vitest harness
  // may instead seed them through setMusicFiles()/setBpmMap().
  var musicFiles = [];
  var bpmMap = {};

  // Injected host services / state getters (set by init).
  var deps = {
    authFetch: function () { return Promise.reject(new Error('FRPlaylists not initialised')); },
    log: function () {},
    showError: function () {},
    openGenericModal: function () {},
    closeGenericModal: function () {},
    loadQueue: function () {},
    getMusicFiles: null,
    getBpmMap: null,
  };

  // -------------------------------------------------------------------------
  // Helpers that resolve injected services / live shared state at call time.
  // -------------------------------------------------------------------------
  function authFetch(url, opts) { return deps.authFetch(url, opts); }
  function log(msg) { return deps.log(msg); }
  function showError(msg) { return deps.showError(msg); }
  function openGenericModal(title, bodyHtml, onSave) { return deps.openGenericModal(title, bodyHtml, onSave); }
  function closeGenericModal() { return deps.closeGenericModal(); }
  function loadQueue() { return deps.loadQueue(); }

  function getMusicFiles() {
    return deps.getMusicFiles ? deps.getMusicFiles() : musicFiles;
  }
  function getBpmMap() {
    return deps.getBpmMap ? deps.getBpmMap() : bpmMap;
  }
  function escapeHtml(s) {
    return window.FRUtils.escapeHtml(s);
  }

  // -------------------------------------------------------------------------
  // Playlists UI (behaviour-identical to the former app.js functions).
  // -------------------------------------------------------------------------
  function loadPlaylists() {
    authFetch('/api/playlists')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        playlists = data;
        renderPlaylistsList();
      })
      .catch(function(e) { log('playlists: error: ' + e); });
  }

  function renderPlaylistsList() {
    var container = document.getElementById('playlists-list');
    container.innerHTML = '';
    if (!playlists || playlists.length === 0) {
      container.innerHTML = '<div class="empty-state">No playlists yet</div>';
      return;
    }
    playlists.forEach(function(pl) {
      var div = document.createElement('div');
      div.className = 'playlist-item' + (selectedPlaylistId === pl.id ? ' selected' : '');
      div.onclick = function() { selectPlaylist(pl.id); };

      var nameEl = document.createElement('span');
      nameEl.className = 'playlist-item-name';
      nameEl.textContent = pl.name;
      div.appendChild(nameEl);

      var badge = document.createElement('span');
      badge.className = 'playlist-badge ' + pl.type;
      badge.textContent = pl.type;
      div.appendChild(badge);

      var count = document.createElement('span');
      count.className = 'playlist-count';
      count.textContent = (pl.trackCount || 0) + ' tracks';
      div.appendChild(count);

      container.appendChild(div);
    });
  }

  function selectPlaylist(id) {
    selectedPlaylistId = id;
    renderPlaylistsList();
    authFetch('/api/playlists/' + id)
      .then(function(r) { return r.json(); })
      .then(function(pl) { renderPlaylistDetail(pl); })
      .catch(function(e) { showError('Failed to load playlist: ' + e); });
  }

  function renderPlaylistDetail(pl) {
    var titleEl = document.getElementById('playlist-detail-title');
    var actionsEl = document.getElementById('playlist-detail-actions');
    var contentEl = document.getElementById('playlist-detail-content');
    var libraryPanel = document.getElementById('track-library-panel');

    titleEl.textContent = pl.name + ' (' + pl.type + ')';
    actionsEl.style.display = 'flex';

    contentEl.innerHTML = '';

    if (pl.type === 'smart') {
      var rulesDiv = document.createElement('div');
      rulesDiv.className = 'smart-rules';

      var rules = pl.rules || {};
      var html = '<div class="form-group"><label>BPM Range</label><div class="range-inputs">' +
        '<input type="number" id="smart-bpm-min" value="' + escapeHtml('' + (rules.bpmMin || '')) + '" placeholder="Min" class="input-small">' +
        ' - <input type="number" id="smart-bpm-max" value="' + escapeHtml('' + (rules.bpmMax || '')) + '" placeholder="Max" class="input-small">' +
        '</div></div>' +
        '<div class="form-group"><label>Name Pattern (regex)</label>' +
        '<input type="text" id="smart-name-pattern" value="' + escapeHtml(rules.namePattern || '') + '" placeholder="e.g. hard.*techno"></div>' +
        '<div class="form-group"><label>Tags</label>' +
        '<input type="text" id="smart-tags" value="' + escapeHtml((rules.tags || []).join(', ')) + '" placeholder="tag1, tag2"></div>' +
        '<div class="form-group"><label>Tag Mode</label>' +
        '<select id="smart-tag-mode"><option value="any"' + (rules.tagMode !== 'all' ? ' selected' : '') + '>Any</option>' +
        '<option value="all"' + (rules.tagMode === 'all' ? ' selected' : '') + '>All</option></select></div>' +
        '<button class="btn-primary" data-action="updateSmartRules" data-id="' + escapeHtml(pl.id) + '">Update Rules</button>';
      rulesDiv.innerHTML = html;
      rulesDiv.querySelector('[data-action="updateSmartRules"]').addEventListener('click', function() {
        updateSmartRules(pl.id);
      });
      contentEl.appendChild(rulesDiv);

      var tracksDiv = document.createElement('div');
      tracksDiv.className = 'playlist-tracks';
      tracksDiv.innerHTML = '<div class="panel-head" style="margin-top:12px"><span>Resolved Tracks (' + (pl.resolvedTracks || []).length + ')</span></div>';
      (pl.resolvedTracks || []).forEach(function(t) {
        var item = document.createElement('div');
        item.className = 'playlist-track-item';
        item.textContent = t;
        tracksDiv.appendChild(item);
      });
      contentEl.appendChild(tracksDiv);
      libraryPanel.style.display = 'none';

    } else {
      var tracks = pl.tracks || [];
      if (tracks.length === 0) {
        contentEl.innerHTML = '<div class="empty-state">No tracks. Add from library below.</div>';
      } else {
        tracks.forEach(function(t, idx) {
          var item = document.createElement('div');
          item.className = 'playlist-track-item';
          item.draggable = true;
          item.dataset.idx = idx;

          var grip = document.createElement('span');
          grip.className = 'drag-grip';
          grip.textContent = '≡';
          item.appendChild(grip);

          var nameEl = document.createElement('span');
          nameEl.className = 'playlist-track-name';
          nameEl.textContent = t;
          item.appendChild(nameEl);

          var bpm = getBpmMap()[t];
          if (bpm) {
            var bpmEl = document.createElement('span');
            bpmEl.className = 'selector-bpm';
            bpmEl.textContent = Math.round(bpm) + ' BPM';
            item.appendChild(bpmEl);
          }

          var removeBtn = document.createElement('button');
          removeBtn.className = 'file-del';
          removeBtn.textContent = 'x';
          removeBtn.onclick = function(e) {
            e.stopPropagation();
            removeTrackFromPlaylist(pl.id, idx);
          };
          item.appendChild(removeBtn);

          item.ondragstart = function(e) {
            e.dataTransfer.setData('text/plain', idx);
            item.classList.add('dragging');
          };
          item.ondragend = function() { item.classList.remove('dragging'); };
          item.ondragover = function(e) { e.preventDefault(); item.classList.add('drag-over'); };
          item.ondragleave = function() { item.classList.remove('drag-over'); };
          item.ondrop = function(e) {
            e.preventDefault();
            item.classList.remove('drag-over');
            var from = parseInt(e.dataTransfer.getData('text/plain'));
            var to = idx;
            if (from !== to) reorderPlaylistTrack(pl.id, from, to);
          };

          contentEl.appendChild(item);
        });
      }

      libraryPanel.style.display = 'block';
      renderPlaylistTrackLibrary(pl.id, pl.tracks || []);
    }
  }

  function renderPlaylistTrackLibrary(playlistId, existingTracks) {
    var container = document.getElementById('playlist-track-library');
    var searchInput = document.getElementById('playlist-track-search');

    function render(filter) {
      container.innerHTML = '';
      var search = (filter || '').toLowerCase();
      var filtered = getMusicFiles().filter(function(f) {
        return !search || f.name.toLowerCase().indexOf(search) !== -1;
      });
      filtered.forEach(function(f) {
        var div = document.createElement('div');
        div.className = 'selector-item';

        var name = document.createElement('span');
        name.className = 'selector-name';
        name.textContent = f.name;
        div.appendChild(name);

        var bpm = getBpmMap()[f.name];
        if (bpm) {
          var bpmEl = document.createElement('span');
          bpmEl.className = 'selector-bpm';
          bpmEl.textContent = Math.round(bpm) + ' BPM';
          div.appendChild(bpmEl);
        }

        var inPlaylist = existingTracks.indexOf(f.name) !== -1;
        var addBtn = document.createElement('button');
        addBtn.className = 'btn-add-queue';
        addBtn.textContent = inPlaylist ? '✓' : '+';
        addBtn.disabled = inPlaylist;
        if (!inPlaylist) {
          addBtn.onclick = function() {
            addTrackToPlaylist(playlistId, f.name);
          };
        }
        div.appendChild(addBtn);

        container.appendChild(div);
      });
    }

    searchInput.oninput = function() { render(searchInput.value); };
    render(searchInput.value);
  }

  function addTrackToPlaylist(playlistId, track) {
    authFetch('/api/playlists/' + playlistId)
      .then(function(r) { return r.json(); })
      .then(function(pl) {
        var tracks = (pl.tracks || []).concat([track]);
        return authFetch('/api/playlists/' + playlistId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracks: tracks })
        });
      })
      .then(function() { selectPlaylist(playlistId); })
      .catch(function(e) { showError('Add track failed: ' + e); });
  }

  function removeTrackFromPlaylist(playlistId, idx) {
    authFetch('/api/playlists/' + playlistId)
      .then(function(r) { return r.json(); })
      .then(function(pl) {
        var tracks = (pl.tracks || []).slice();
        tracks.splice(idx, 1);
        return authFetch('/api/playlists/' + playlistId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracks: tracks })
        });
      })
      .then(function() { selectPlaylist(playlistId); })
      .catch(function(e) { showError('Remove track failed: ' + e); });
  }

  function reorderPlaylistTrack(playlistId, from, to) {
    authFetch('/api/playlists/' + playlistId + '/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from, to: to })
    })
      .then(function() { selectPlaylist(playlistId); })
      .catch(function(e) { showError('Reorder failed: ' + e); });
  }

  function updateSmartRules(playlistId) {
    var bpmMin = document.getElementById('smart-bpm-min').value;
    var bpmMax = document.getElementById('smart-bpm-max').value;
    var namePattern = document.getElementById('smart-name-pattern').value;
    var tags = document.getElementById('smart-tags').value.split(',').map(function(t) { return t.trim(); }).filter(Boolean);
    var tagMode = document.getElementById('smart-tag-mode').value;

    var rules = {};
    if (bpmMin) rules.bpmMin = parseInt(bpmMin);
    if (bpmMax) rules.bpmMax = parseInt(bpmMax);
    if (namePattern) rules.namePattern = namePattern;
    if (tags.length) { rules.tags = tags; rules.tagMode = tagMode; }

    authFetch('/api/playlists/' + playlistId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: rules })
    })
      .then(function() {
        log('playlist: updated smart rules');
        selectPlaylist(playlistId);
        loadPlaylists();
      })
      .catch(function(e) { showError('Update rules failed: ' + e); });
  }

  // -------------------------------------------------------------------------
  // Button / input handlers — bound to their DOM elements by init().
  // -------------------------------------------------------------------------
  function onCreateClick() {
    openGenericModal('Create Playlist',
      '<div class="form-group"><label>Name</label><input type="text" id="new-playlist-name" placeholder="My Playlist"></div>' +
      '<div class="form-group"><label>Type</label><select id="new-playlist-type">' +
      '<option value="manual">Manual</option><option value="smart">Smart</option></select></div>',
      function() {
        var name = document.getElementById('new-playlist-name').value.trim();
        var type = document.getElementById('new-playlist-type').value;
        if (!name) return;
        authFetch('/api/playlists', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, type: type })
        })
          .then(function(r) { return r.json(); })
          .then(function(pl) {
            log('playlist: created ' + pl.name);
            closeGenericModal();
            loadPlaylists();
            selectPlaylist(pl.id);
          })
          .catch(function(e) { showError('Create playlist failed: ' + e); });
      }
    );
  }

  function onDeleteClick() {
    if (!selectedPlaylistId) return;
    if (!confirm('Delete this playlist?')) return;
    authFetch('/api/playlists/' + selectedPlaylistId, { method: 'DELETE' })
      .then(function() {
        log('playlist: deleted');
        selectedPlaylistId = null;
        document.getElementById('playlist-detail-content').innerHTML = '<div class="empty-state">Select a playlist from the list</div>';
        document.getElementById('playlist-detail-actions').style.display = 'none';
        document.getElementById('playlist-detail-title').textContent = 'Select a playlist';
        document.getElementById('track-library-panel').style.display = 'none';
        loadPlaylists();
      })
      .catch(function(e) { showError('Delete failed: ' + e); });
  }

  function onLoadQueueClick() {
    if (!selectedPlaylistId) return;
    authFetch('/api/queue/load-playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playlistId: selectedPlaylistId })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          log('playlist: loaded ' + data.loaded + '/' + data.total + ' tracks to queue');
          loadQueue();
        } else {
          showError('Load playlist failed: ' + (data.error || 'unknown'));
        }
      })
      .catch(function(e) { showError('Load playlist failed: ' + e); });
  }

  function onImportChange() {
    var file = this.files[0];
    if (!file) return;
    var formData = new FormData();
    formData.append('file', file);
    formData.append('name', file.name.replace(/\.[^.]+$/, ''));
    authFetch('/api/playlists/import', { method: 'POST', body: formData })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        log('playlist: imported ' + data.importedCount + '/' + data.totalParsed + ' tracks');
        loadPlaylists();
        if (data.id) selectPlaylist(data.id);
      })
      .catch(function(e) { showError('Import failed: ' + e); });
    this.value = '';
  }

  /**
   * Populate the music playlist <select> dropdowns
   * (#schedule-default-playlist, .playlist-select). This is the MUSIC half of
   * the former app.js loadPlaylistsForSelect; the video half stays in app.js.
   */
  function loadForSelect() {
    authFetch('/api/playlists')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var selects = document.querySelectorAll('#schedule-default-playlist, .playlist-select');
        selects.forEach(function(sel) {
          var current = sel.value;
          sel.innerHTML = '<option value="">-- None --</option>';
          data.forEach(function(pl) {
            sel.innerHTML += '<option value="' + escapeHtml(pl.id) + '">' + escapeHtml(pl.name) + '</option>';
          });
          sel.value = current;
        });
      })
      .catch(function() {});
  }

  /**
   * Store injected dependencies and bind the create / delete / load-queue /
   * import handlers to their DOM elements. Safe to call more than once (the
   * vitest harness re-inits per test); handler binding is idempotent.
   */
  function init(injected) {
    injected = injected || {};
    for (var k in deps) {
      if (Object.prototype.hasOwnProperty.call(injected, k)) {
        deps[k] = injected[k];
      }
    }

    var createBtn = document.getElementById('create-playlist-btn');
    if (createBtn) createBtn.onclick = onCreateClick;
    var deleteBtn = document.getElementById('playlist-delete-btn');
    if (deleteBtn) deleteBtn.onclick = onDeleteClick;
    var loadQueueBtn = document.getElementById('playlist-load-queue-btn');
    if (loadQueueBtn) loadQueueBtn.onclick = onLoadQueueClick;
    var importInput = document.getElementById('import-m3u-input');
    if (importInput) importInput.onchange = onImportChange;
  }

  return {
    init: init,
    loadPlaylists: loadPlaylists,
    loadForSelect: loadForSelect,

    // Surface used by the characterization tests to drive the module.
    renderPlaylistsList: renderPlaylistsList,
    selectPlaylist: selectPlaylist,
    renderPlaylistDetail: renderPlaylistDetail,
    renderPlaylistTrackLibrary: renderPlaylistTrackLibrary,
    addTrackToPlaylist: addTrackToPlaylist,
    removeTrackFromPlaylist: removeTrackFromPlaylist,
    reorderPlaylistTrack: reorderPlaylistTrack,
    updateSmartRules: updateSmartRules,
    setPlaylists: function (a) { playlists = a; },
    getPlaylists: function () { return playlists; },
    setSelectedPlaylistId: function (id) { selectedPlaylistId = id; },
    getSelectedPlaylistId: function () { return selectedPlaylistId; },
    setMusicFiles: function (a) { musicFiles = a; },
    setBpmMap: function (o) { bpmMap = o; }
  };
});
