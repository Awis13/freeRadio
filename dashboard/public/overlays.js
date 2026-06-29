/**
 * overlays.js — Overlay-config UI for the STUDIO 23 / FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js overlays refactor).
 * Owns the overlay config state (`overlayConfig`) and renders the overlay layer
 * rows, drives the master enable checkbox, the add-layer modal flow, the
 * toggle/update/remove row handlers, the save (PUT /api/overlays) path, and the
 * overlay-assets list (GET/DELETE /api/overlays/assets).
 *
 * Dependency injection: `init(deps)` receives the host services
 * (authFetch, log, showError, openGenericModal, closeGenericModal). escapeHtml
 * and fmtSize are taken from window.FRUtils (loaded before this file). All
 * container / list DOM nodes are resolved via document.getElementById at call
 * time, exactly as the former app.js closure referenced them. init() also
 * assigns the window.toggleOverlayLayer / updateOverlayLayer / removeOverlayLayer
 * globals (the rendered rows reach them through window.*) and binds the
 * #overlays-enabled-check + #add-overlay-btn handlers (which formerly ran at
 * module-eval time); they now run post-deps so the modal handlers resolve
 * openGenericModal/closeGenericModal through the injected deps.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/overlays.js"> (attaches its public API to window.FROverlays)
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
    window.FROverlays = api;
  }
})(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Module-owned state (moved out of app.js). Holds the current overlay config
  // ({ enabled, layers }) fetched from / persisted to /api/overlays.
  // -------------------------------------------------------------------------
  var overlayConfig = { enabled: false, layers: [] };

  // Injected host services (set by init).
  var deps = {
    authFetch: function () { return Promise.reject(new Error('FROverlays not initialised')); },
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

  function escapeHtml(s) {
    return window.FRUtils.escapeHtml(s);
  }
  function fmtSize(b) {
    return window.FRUtils.fmtSize(b);
  }

  // -------------------------------------------------------------------------
  // Overlays (behaviour-identical to the former app.js functions).
  // -------------------------------------------------------------------------
  function loadOverlays() {
    authFetch('/api/overlays')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        overlayConfig = data;
        document.getElementById('overlays-enabled-check').checked = data.enabled;
        renderOverlayLayers();
      })
      .catch(function(e) { log('overlays: error: ' + e); });
  }

  function renderOverlayLayers() {
    var container = document.getElementById('overlay-layers');
    container.innerHTML = '';
    (overlayConfig.layers || []).forEach(function(layer, idx) {
      var div = document.createElement('div');
      div.className = 'overlay-layer' + (layer.enabled ? '' : ' disabled');

      var header = document.createElement('div');
      header.className = 'overlay-layer-header';
      header.innerHTML =
        '<label class="checkbox-label"><input type="checkbox" ' + (layer.enabled ? 'checked' : '') + '> ' +
        '<span class="overlay-type-badge">' + escapeHtml(layer.type) + '</span></label>' +
        '<button class="file-del">x</button>';
      header.querySelector('input[type="checkbox"]').addEventListener('change', function() {
        window.toggleOverlayLayer(idx, this.checked);
      });
      header.querySelector('button.file-del').addEventListener('click', function() {
        window.removeOverlayLayer(idx);
      });
      div.appendChild(header);

      var body = document.createElement('div');
      body.className = 'overlay-layer-body';

      if (layer.type === 'now_playing' || layer.type === 'scrolling_now_playing' || layer.type === 'static_text' || layer.type === 'clock' || layer.type === 'scrolling_text') {
        var isScrolling = layer.type === 'scrolling_text' || layer.type === 'scrolling_now_playing';
        body.innerHTML =
          '<div class="overlay-props">' +
          (layer.type === 'static_text' || layer.type === 'scrolling_text' ? '<div class="form-group"><label>Text</label><input type="text" value="' + escapeHtml(layer.text || '') + '" data-layer="' + idx + '" data-prop="text"></div>' : '') +
          (layer.type === 'scrolling_now_playing' ? '<div class="form-group"><label>Source</label><span class="text-secondary">Current track (auto)</span></div>' : '') +
          (isScrolling ? '<div class="form-group"><label>Speed (px/sec)</label><input type="number" value="' + escapeHtml('' + (layer.speed || 100)) + '" data-layer="' + idx + '" data-prop="speed" data-parse="int"></div>' : '') +
          (layer.type === 'clock' ? '<div class="form-group"><label>Format</label><input type="text" value="' + escapeHtml(layer.format || '%H:%M') + '" data-layer="' + idx + '" data-prop="format"></div>' : '') +
          '<div class="overlay-pos-grid">' +
          '<div class="form-group"><label>Font Size</label><input type="number" value="' + escapeHtml('' + (layer.fontsize || 28)) + '" data-layer="' + idx + '" data-prop="fontsize" data-parse="int"></div>' +
          '<div class="form-group"><label>Color</label><input type="text" value="' + escapeHtml(layer.fontcolor || 'white') + '" data-layer="' + idx + '" data-prop="fontcolor"></div>' +
          '<div class="form-group"><label>X</label><input type="text" value="' + escapeHtml('' + (layer.x || '20')) + '" data-layer="' + idx + '" data-prop="x"></div>' +
          '<div class="form-group"><label>Y</label><input type="text" value="' + escapeHtml('' + (layer.y || '20')) + '" data-layer="' + idx + '" data-prop="y"></div>' +
          '</div>' +
          '<div class="form-group"><label>Box Color</label><input type="text" value="' + escapeHtml(layer.boxcolor || '') + '" placeholder="black@0.6" data-layer="' + idx + '" data-prop="boxcolor"></div>' +
          '</div>';
      } else if (layer.type === 'logo') {
        body.innerHTML =
          '<div class="overlay-props">' +
          '<div class="form-group"><label>Asset</label><input type="text" value="' + escapeHtml(layer.asset || '') + '" data-layer="' + idx + '" data-prop="asset" placeholder="logo.png"></div>' +
          '<div class="overlay-pos-grid">' +
          '<div class="form-group"><label>X</label><input type="text" value="' + escapeHtml('' + (layer.x || 'W-w-20')) + '" data-layer="' + idx + '" data-prop="x"></div>' +
          '<div class="form-group"><label>Y</label><input type="text" value="' + escapeHtml('' + (layer.y || '20')) + '" data-layer="' + idx + '" data-prop="y"></div>' +
          '</div>' +
          '</div>';
      }
      div.appendChild(body);
      container.appendChild(div);
    });

    // Event delegation: all input[data-layer] change events
    container.addEventListener('change', function(e) {
      var input = e.target;
      if (!input.dataset || input.dataset.layer === undefined) return;
      var layerIdx = parseInt(input.dataset.layer);
      var prop = input.dataset.prop;
      var value = input.dataset.parse === 'int' ? parseInt(input.value) : input.value;
      window.updateOverlayLayer(layerIdx, prop, value);
    });
  }

  function toggleOverlayLayer(idx, enabled) {
    overlayConfig.layers[idx].enabled = enabled;
    saveOverlays();
  }

  function updateOverlayLayer(idx, prop, value) {
    overlayConfig.layers[idx][prop] = value;
    saveOverlays();
  }

  function removeOverlayLayer(idx) {
    overlayConfig.layers.splice(idx, 1);
    saveOverlays();
    renderOverlayLayers();
  }

  function saveOverlays() {
    authFetch('/api/overlays', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(overlayConfig)
    })
      .then(function() { log('overlays: saved'); })
      .catch(function(e) { showError('Save overlays failed: ' + e); });
  }

  // Overlay assets
  function loadOverlayAssets() {
    authFetch('/api/overlays/assets')
      .then(function(r) { return r.json(); })
      .then(function(assets) {
        var container = document.getElementById('overlay-assets-list');
        container.innerHTML = '';
        if (assets.length === 0) {
          container.innerHTML = '<div class="empty-state">No assets</div>';
          return;
        }
        assets.forEach(function(a) {
          var div = document.createElement('div');
          div.className = 'overlay-asset-item';
          div.innerHTML =
            '<span class="file-name">' + escapeHtml(a.name) + '</span>' +
            '<span class="file-size">' + fmtSize(a.size) + '</span>' +
            '<button class="file-del" title="Delete">x</button>';
          div.querySelector('button').onclick = function() {
            authFetch('/api/overlays/assets/' + encodeURIComponent(a.name), { method: 'DELETE' })
              .then(function() { loadOverlayAssets(); });
          };
          container.appendChild(div);
        });
      })
      .catch(function() {});
  }

  /**
   * Bind the #overlays-enabled-check.onchange + #add-overlay-btn.onclick handlers
   * (were module-scope inline statements in app.js). Called from init() — runs
   * AFTER deps are injected, so the modal handler resolves
   * openGenericModal/closeGenericModal via deps rather than relying on hoisting.
   * Null-guarded for missing elements.
   */
  function bindButtons() {
    var enabledCheck = document.getElementById('overlays-enabled-check');
    if (enabledCheck) {
      enabledCheck.onchange = function() {
        overlayConfig.enabled = this.checked;
        saveOverlays();
      };
    }

    var addBtn = document.getElementById('add-overlay-btn');
    if (addBtn) {
      addBtn.onclick = function() {
        openGenericModal('Add Overlay Layer',
          '<div class="form-group"><label>Type</label><select id="new-overlay-type">' +
          '<option value="now_playing">Now Playing (static)</option>' +
          '<option value="scrolling_now_playing">Now Playing (scrolling)</option>' +
          '<option value="static_text">Static Text</option>' +
          '<option value="scrolling_text">Scrolling Text</option>' +
          '<option value="clock">Clock</option>' +
          '<option value="logo">Logo</option></select></div>',
          function() {
            var type = document.getElementById('new-overlay-type').value;
            var layer = {
              id: 'ol_' + Date.now(),
              type: type,
              enabled: true,
              x: '20',
              y: '20'
            };
            if (type === 'now_playing') {
              layer.fontsize = 28;
              layer.fontcolor = 'white';
              layer.y = 'H-60';
              layer.boxcolor = 'black@0.6';
            } else if (type === 'static_text') {
              layer.text = 'STUDIO 23';
              layer.fontsize = 18;
              layer.fontcolor = 'white';
            } else if (type === 'scrolling_text') {
              layer.text = 'STUDIO 23 RADIO - HARD TECHNO 24/7';
              layer.fontsize = 32;
              layer.fontcolor = 'white';
              layer.speed = 150;
              layer.y = 'H-80';
              layer.boxcolor = 'black@0.5';
            } else if (type === 'scrolling_now_playing') {
              layer.fontsize = 32;
              layer.fontcolor = 'white';
              layer.speed = 120;
              layer.y = 'H-80';
              layer.boxcolor = 'black@0.5';
            } else if (type === 'clock') {
              layer.format = '%H:%M';
              layer.fontsize = 24;
              layer.fontcolor = 'white';
              layer.x = 'W-120';
            } else if (type === 'logo') {
              layer.asset = 'logo.png';
              layer.x = 'W-w-20';
            }
            overlayConfig.layers.push(layer);
            saveOverlays();
            closeGenericModal();
            renderOverlayLayers();
          }
        );
      };
    }
  }

  /**
   * Store injected dependencies, assign the toggle/update/remove window globals
   * (the rendered rows reach them via window.*), then bind the overlay buttons.
   * Safe to call more than once (the vitest harness re-inits per test with its
   * own deps).
   */
  function init(injected) {
    injected = injected || {};
    for (var k in deps) {
      if (Object.prototype.hasOwnProperty.call(injected, k)) {
        deps[k] = injected[k];
      }
    }
    window.toggleOverlayLayer = toggleOverlayLayer;
    window.updateOverlayLayer = updateOverlayLayer;
    window.removeOverlayLayer = removeOverlayLayer;
    bindButtons();
  }

  return {
    init: init,
    loadOverlays: loadOverlays,
    renderOverlayLayers: renderOverlayLayers,
    saveOverlays: saveOverlays,
    loadOverlayAssets: loadOverlayAssets,
    toggleOverlayLayer: toggleOverlayLayer,
    updateOverlayLayer: updateOverlayLayer,
    removeOverlayLayer: removeOverlayLayer,
    getOverlayConfig: function () { return overlayConfig; },
    setOverlayConfig: function (c) { overlayConfig = c; },
  };
});
