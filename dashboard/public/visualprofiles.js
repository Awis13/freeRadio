/**
 * visualprofiles.js — Visual-profiles UI for the STUDIO 23 / FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js visual-profiles
 * refactor). Owns the selected-profile state (`selectedVisualProfileId`) and
 * renders the visual-profiles list + detail (video grid), wires activate/delete,
 * and drives the create-profile modal flow.
 *
 * Dependency injection: `init(deps)` receives the host services
 * (authFetch, log, showError, openGenericModal, closeGenericModal). fmtSize is
 * taken from window.FRUtils (loaded before this file). All list / detail / grid
 * DOM nodes are resolved via document.getElementById at call time, exactly as
 * the former app.js closure referenced them. init() also binds the
 * create-visual-profile-btn (the only DOM bind this domain owns); that handler
 * reaches openGenericModal/closeGenericModal through the injected deps, so it no
 * longer depends on function-hoisting like the old module-scope binding did.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/visualprofiles.js"> (attaches its public API to
 * window.FRVisualProfiles) AND required by the vitest suite via module.exports
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
    window.FRVisualProfiles = api;
  }
})(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Module-owned state (moved out of app.js). Tracks which profile's detail is
  // currently shown; read at render time to mark the ' selected' list row.
  // -------------------------------------------------------------------------
  var selectedVisualProfileId = null;

  // Injected host services (set by init).
  var deps = {
    authFetch: function () { return Promise.reject(new Error('FRVisualProfiles not initialised')); },
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
  // Visual Profiles (behaviour-identical to the former app.js functions).
  // -------------------------------------------------------------------------
  function loadVisualProfiles() {
    authFetch('/api/visual-profiles')
      .then(function(r) { return r.json(); })
      .then(function(data) { renderVisualProfilesList(data); })
      .catch(function(e) { log('visual profiles: error: ' + e); });
  }

  function renderVisualProfilesList(data) {
    var container = document.getElementById('visual-profiles-list');
    container.innerHTML = '';
    var profiles = data.profiles || [];
    if (profiles.length === 0) {
      container.innerHTML = '<div class="empty-state">No visual profiles</div>';
      return;
    }
    profiles.forEach(function(p) {
      var div = document.createElement('div');
      div.className = 'vp-item' + (p.isActive ? ' active' : '') + (selectedVisualProfileId === p.id ? ' selected' : '');
      div.onclick = function() { selectVisualProfile(p.id); };

      var nameEl = document.createElement('span');
      nameEl.className = 'vp-item-name';
      nameEl.textContent = p.name;
      div.appendChild(nameEl);

      if (p.isActive) {
        var badge = document.createElement('span');
        badge.className = 'vp-active-badge';
        badge.textContent = 'ACTIVE';
        div.appendChild(badge);
      }

      var count = document.createElement('span');
      count.className = 'vp-count';
      count.textContent = (p.videoCount || 0) + ' videos';
      div.appendChild(count);

      container.appendChild(div);
    });
  }

  function selectVisualProfile(id) {
    selectedVisualProfileId = id;
    var detail = document.getElementById('visual-profile-detail');
    detail.style.display = 'block';

    authFetch('/api/visual-profiles/' + id)
      .then(function(r) { return r.json(); })
      .then(function(p) { renderVisualProfileDetail(p); })
      .catch(function(e) { showError('Failed to load profile: ' + e); });
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

  function renderVisualProfileDetail(profile) {
    document.getElementById('vp-detail-title').textContent = profile.name;
    var grid = document.getElementById('vp-video-grid');

    // A failed load must not leave the previous profile's tiles on screen: each
    // tile's onclick closes over the id it was rendered for, so a surviving
    // tile would PUT into the OLD profile while the panel shows the new one.
    // Any failure — rejected request, non-2xx body, anything that is not the
    // expected array — replaces the grid with a non-clickable failure state.
    authFetch('/api/visuals')
      .then(function(r) { return r.json(); })
      .then(function(allVideos) {
        if (!Array.isArray(allVideos)) throw new Error('unexpected response');
        grid.innerHTML = '';
        var selectedSet = new Set(profile.videos || []);
        allVideos.forEach(function(v) {
          var div = document.createElement('div');
          div.className = 'video-tile' + (selectedSet.has(v.name) ? ' selected' : '');
          div.onclick = function() {
            div.classList.toggle('selected');
            saveVisualProfileVideos(profile.id);
          };

          var nameEl = document.createElement('div');
          nameEl.className = 'video-tile-name';
          nameEl.textContent = v.name;
          div.appendChild(nameEl);

          var sizeEl = document.createElement('div');
          sizeEl.className = 'video-tile-size';
          sizeEl.textContent = fmtSize(v.size);
          div.appendChild(sizeEl);

          grid.appendChild(div);
        });
      })
      .catch(function(e) {
        showError('Failed to load videos: ' + e);
        renderGridFailure(grid, function() { renderVisualProfileDetail(profile); });
      });

    document.getElementById('vp-activate-btn').onclick = function() {
      authFetch('/api/visual-profiles/' + profile.id + '/activate', { method: 'POST' })
        .then(function() {
          log('visual: activated ' + profile.name);
          loadVisualProfiles();
        })
        .catch(function(e) { showError('Activate failed: ' + e); });
    };

    document.getElementById('vp-delete-btn').onclick = function() {
      if (!confirm('Delete profile "' + profile.name + '"?')) return;
      authFetch('/api/visual-profiles/' + profile.id, { method: 'DELETE' })
        .then(function() {
          log('visual: deleted ' + profile.name);
          document.getElementById('visual-profile-detail').style.display = 'none';
          selectedVisualProfileId = null;
          loadVisualProfiles();
        })
        .catch(function(e) { showError('Delete failed: ' + e); });
    };
  }

  function saveVisualProfileVideos(profileId) {
    var grid = document.getElementById('vp-video-grid');
    var selected = [];
    grid.querySelectorAll('.video-tile.selected').forEach(function(tile) {
      selected.push(tile.querySelector('.video-tile-name').textContent);
    });
    authFetch('/api/visual-profiles/' + profileId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videos: selected })
    }).catch(function(e) { showError('Save videos failed: ' + e); });
  }

  /**
   * Bind the create-visual-profile-btn onclick (was a module-scope inline
   * statement in app.js). Called from init() — runs AFTER deps are injected, so
   * the modal handler resolves openGenericModal/closeGenericModal via deps
   * rather than relying on hoisting. Null-guarded for a missing element.
   */
  function bindCreateButton() {
    var btn = document.getElementById('create-visual-profile-btn');
    if (!btn) return;
    btn.onclick = function() {
      openGenericModal('Create Visual Profile',
        '<div class="form-group"><label>Name</label><input type="text" id="new-vp-name" placeholder="Night Visuals"></div>',
        function() {
          var name = document.getElementById('new-vp-name').value.trim();
          if (!name) return;
          authFetch('/api/visual-profiles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, videos: [] })
          })
            .then(function(r) { return r.json(); })
            .then(function(p) {
              log('visual: created ' + name);
              closeGenericModal();
              loadVisualProfiles();
              selectVisualProfile(p.id);
            })
            .catch(function(e) { showError('Create failed: ' + e); });
        }
      );
    };
  }

  /**
   * Store injected dependencies, then bind the create button. Safe to call more
   * than once (the vitest harness re-inits per test with its own deps).
   */
  function init(injected) {
    injected = injected || {};
    window.FRUtils.mergeDeps(deps, injected, 'FRVisualProfiles');
    bindCreateButton();
  }

  return {
    init: init,
    loadVisualProfiles: loadVisualProfiles,

    // Surface used by the characterization tests to drive the module.
    selectVisualProfile: selectVisualProfile,
    renderVisualProfilesList: renderVisualProfilesList,
    renderVisualProfileDetail: renderVisualProfileDetail,
    saveVisualProfileVideos: saveVisualProfileVideos,
    getSelectedVisualProfileId: function () { return selectedVisualProfileId; },
    setSelectedVisualProfileId: function (v) { selectedVisualProfileId = v; },
  };
});
