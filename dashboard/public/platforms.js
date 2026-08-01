/**
 * platforms.js — Stream-platforms / stream-keys UI for the STUDIO 23 / FreeRadio
 * dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js platforms refactor).
 * Owns the platform domain state (PLATFORM_PRESETS, maxPlatforms,
 * currentPlatformNames), renders the platform list, wires the add/save/toggle/
 * delete flow, and drives the domain's OWN #platform-modal (NOT the generic
 * modal — there is no openGenericModal/closeGenericModal dependency here).
 *
 * Dependency injection: `init(deps)` receives the host services
 * (authFetch, log, showError). uniquePlatformName delegates to
 * window.FRUtils.uniquePlatformName (loaded before this file), passing the
 * module-private currentPlatformNames. All platform DOM nodes are captured in
 * init() via document.getElementById (mirroring app.js's boot-time capture).
 * init() also assigns window.savePlatform / window.closePlatformModal (driven in
 * production via inline onclick in index.html), binds the preset-select /
 * add-button / name-input / modal-backdrop handlers, then runs the boot
 * auto-load (loadPlatforms + the 30s poll).
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/platforms.js"> (attaches its public API to window.FRPlatforms)
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
    window.FRPlatforms = api;
  }
})(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Module-owned state (moved out of app.js).
  // -------------------------------------------------------------------------
  var PLATFORM_PRESETS = {
    youtube:  { name: 'YouTube',  rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2' },
    kick:     { name: 'Kick',     rtmpUrl: '' },
    twitch:   { name: 'Twitch',   rtmpUrl: 'rtmp://live.twitch.tv/app' },
    facebook: { name: 'Facebook', rtmpUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/' },
    custom:   { name: '',         rtmpUrl: '' }
  };

  var maxPlatforms = 3;
  var currentPlatformNames = [];

  // Platform DOM refs — captured in init() (after the document is parsed),
  // mirroring app.js's boot-time capture. Null until init runs.
  var platformList = null;
  var addPlatformBtn = null;
  var platformModal = null;
  var platformNameInput = null;
  var streamKeyInput = null;
  var rtmpUrlInput = null;
  var rtmpHelp = null;
  var platformEnabled = null;
  var presetGroup = null;
  var presetSelect = null;

  // Injected host services (set by init).
  var deps = {
    authFetch: function () { return Promise.reject(new Error('FRPlatforms not initialised')); },
    log: function () {},
    showError: function () {},
  };

  // -------------------------------------------------------------------------
  // Helpers that resolve injected services at call time.
  // -------------------------------------------------------------------------
  function authFetch(url, opts) { return deps.authFetch(url, opts); }
  function log(msg) { return deps.log(msg); }
  function showError(msg) { return deps.showError(msg); }

  // Delegates to FRUtils (single source of truth), passing the current names.
  function uniquePlatformName(base) {
    return window.FRUtils.uniquePlatformName(base, currentPlatformNames);
  }

  // -------------------------------------------------------------------------
  // Stream platforms (behaviour-identical to the former app.js functions).
  // -------------------------------------------------------------------------
  function applyPreset(key) {
    var preset = PLATFORM_PRESETS[key];
    if (!preset) return;
    var isCustom = key === 'custom';
    var urlEditable = isCustom || !preset.rtmpUrl;
    platformNameInput.value = isCustom ? '' : uniquePlatformName(preset.name);
    rtmpUrlInput.value = preset.rtmpUrl;
    platformNameInput.readOnly = !isCustom;
    rtmpUrlInput.readOnly = !urlEditable;
    platformNameInput.style.opacity = isCustom ? '' : '.7';
    rtmpUrlInput.style.opacity = urlEditable ? '' : '.7';
    syncPlatformHints();
  }

  function syncPlatformHints() {
    var name = (platformNameInput.value || '').trim().toLowerCase();
    if (name === 'kick') {
      rtmpUrlInput.placeholder = 'rtmps://<ingest>.global-contribute.live-video.net/app';
      if (rtmpHelp) rtmpHelp.textContent = 'Kick: server URL from Creator Dashboard, stream key separately.';
      return;
    }
    rtmpUrlInput.placeholder = 'rtmp://... or rtmps://...';
    if (rtmpHelp) rtmpHelp.textContent = 'Use server URL; stream key is stored separately.';
  }

  function loadPlatforms() {
    authFetch('/api/stream-keys')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        maxPlatforms = data.maxPlatforms || 3;
        currentPlatformNames = Object.keys(data.platforms);
        renderPlatforms(data.platforms);
      })
      .catch(function(e) { log('platforms: error loading: ' + e); });
  }

  function renderPlatforms(platforms) {
    platformList.innerHTML = '';
    var entries = Object.entries(platforms);
    entries.forEach(function(entry) {
      var name = entry[0];
      var config = entry[1];
      var div = document.createElement('div');
      div.className = 'platform-item' + (config.enabled ? ' enabled' : '');

      var nameEl = document.createElement('span');
      nameEl.className = 'platform-name';
      nameEl.textContent = name;
      div.appendChild(nameEl);

      var statusEl = document.createElement('span');
      statusEl.className = 'platform-status';
      statusEl.textContent = config.enabled ? 'ON' : 'OFF';
      div.appendChild(statusEl);

      var toggleBtn = document.createElement('button');
      toggleBtn.className = 'platform-toggle' + (config.enabled ? ' on' : ' off');
      toggleBtn.textContent = config.enabled ? 'Disable' : 'Enable';
      toggleBtn.onclick = function() { togglePlatform(name, !config.enabled); };
      div.appendChild(toggleBtn);

      var delBtn = document.createElement('button');
      delBtn.className = 'platform-del';
      delBtn.textContent = '×';
      delBtn.onclick = function() { deletePlatform(name); };
      div.appendChild(delBtn);

      platformList.appendChild(div);
    });

    var atLimit = entries.length >= maxPlatforms;
    addPlatformBtn.disabled = atLimit;
    addPlatformBtn.title = atLimit ? 'Limit: max ' + maxPlatforms + ' platforms' : '';
  }

  function deletePlatform(name) {
    if (!confirm('Remove ' + name + '?')) return;
    authFetch('/api/stream-keys/' + encodeURIComponent(name), { method: 'DELETE' })
      .then(function() {
        log('platform removed: ' + name);
        loadPlatforms();
      })
      .catch(function(e) { showError('Remove failed: ' + e); });
  }

  function togglePlatform(name, enabled) {
    authFetch('/api/stream-keys/' + encodeURIComponent(name) + '/enabled', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.success) throw new Error(data.error || 'toggle failed');
        log('platform ' + name + ': ' + (enabled ? 'ENABLED' : 'DISABLED'));
        loadPlatforms();
      })
      .catch(function(e) { showError('Platform toggle failed: ' + e); });
  }

  function closePlatformModal() {
    platformModal.style.display = 'none';
  }

  function savePlatform() {
    var name = platformNameInput.value.trim();
    var rtmpUrl = rtmpUrlInput.value.trim();
    var key = streamKeyInput.value.trim();
    var enabled = platformEnabled.checked;

    if (!name) { alert('Please enter platform name'); return; }
    if (!rtmpUrl) { alert('Please enter RTMP URL'); return; }
    if (!key) { alert('Please enter stream key'); return; }

    authFetch('/api/stream-keys/' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled, streamKey: key, rtmpUrl: rtmpUrl })
    })
      .then(function(r) {
        if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || 'save failed'); });
        log('platform saved: ' + name);
        closePlatformModal();
        loadPlatforms();
      })
      .catch(function(e) { showError('Save failed: ' + e.message); });
  }

  /**
   * Store injected dependencies, capture the platform DOM refs, assign the
   * window globals (savePlatform / closePlatformModal — driven via inline
   * onclick in index.html), bind the domain handlers, then run the boot
   * auto-load. Safe to call more than once (the vitest harness re-inits per
   * test with its own deps); DOM refs are null-guarded.
   */
  function init(injected) {
    injected = injected || {};
    window.FRUtils.mergeDeps(deps, injected, 'FRPlatforms');

    // Capture DOM refs (after the document is parsed).
    platformList = document.getElementById('platform-list');
    addPlatformBtn = document.getElementById('add-platform-btn');
    platformModal = document.getElementById('platform-modal');
    platformNameInput = document.getElementById('platform-name-input');
    streamKeyInput = document.getElementById('stream-key-input');
    rtmpUrlInput = document.getElementById('rtmp-url-input');
    rtmpHelp = document.getElementById('rtmp-help');
    platformEnabled = document.getElementById('platform-enabled');
    presetGroup = document.getElementById('preset-group');
    presetSelect = document.getElementById('platform-preset-select');

    // Window globals (inline onclick in index.html drives these).
    window.savePlatform = savePlatform;
    window.closePlatformModal = closePlatformModal;

    if (presetSelect) {
      presetSelect.onchange = function() { applyPreset(presetSelect.value); };
    }

    if (addPlatformBtn) {
      addPlatformBtn.onclick = function() {
        streamKeyInput.value = '';
        platformEnabled.checked = true;
        presetGroup.style.display = '';
        presetSelect.value = 'youtube';
        applyPreset('youtube');
        platformModal.style.display = 'flex';
      };
    }

    if (platformNameInput) {
      platformNameInput.oninput = syncPlatformHints;
    }

    if (platformModal) {
      platformModal.onclick = function(e) {
        if (e.target === platformModal) closePlatformModal();
      };
    }

    loadPlatforms();
    setInterval(loadPlatforms, 30000);
  }

  return {
    init: init,
    uniquePlatformName: uniquePlatformName,
    setCurrentPlatformNames: function (a) { currentPlatformNames = a; },

    // Surface used by the characterization tests to drive the module.
    loadPlatforms: loadPlatforms,
    renderPlatforms: renderPlatforms,
    deletePlatform: deletePlatform,
    togglePlatform: togglePlatform,
    syncPlatformHints: syncPlatformHints,
    applyPreset: applyPreset,
    getCurrentPlatformNames: function () { return currentPlatformNames; },
    getMaxPlatforms: function () { return maxPlatforms; },
  };
});
