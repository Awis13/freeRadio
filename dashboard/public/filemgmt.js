/**
 * filemgmt.js — File-management UI for the STUDIO 23 / FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js filemgmt refactor).
 * Owns the music/visual file-list state (`musicFiles`, `visualFiles`) — this
 * domain is the writer (loadFileList fills them) — and renders the music/visuals
 * file lists, wires the drop-zone upload system, and drives delete/upload.
 *
 * Dependency injection: `init(deps)` receives the host services
 * (authFetch, log, showError, showLoginOverlay, renderTrackSelector,
 * loadOverlayAssets), a live getter for the WS-owned bpmMap (getBpmMap, read AT
 * CALL TIME, never cached — app.js keeps bpmMap because the WS handler writes it)
 * and a live getter for the mutable auth token (getAuthToken, read at upload
 * time so the Authorization header always reflects the current session).
 * fmtSize is taken from window.FRUtils (loaded before this file). The list / count
 * DOM nodes are resolved via document.getElementById at call time, exactly as the
 * former app.js closure referenced its cached musicList/visualsList refs (the page
 * binds the first matching instance).
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/filemgmt.js"> (attaches its public API to window.FRFileMgmt)
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
    window.FRFileMgmt = api;
  }
})(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Module-owned state (moved out of app.js). This domain is the writer:
  // loadFileList populates these from GET /api/<type>.
  // -------------------------------------------------------------------------
  var musicFiles = [];
  var visualFiles = [];

  // Test-only fallback for the WS-owned bpmMap. In the browser this is provided
  // by app.js via deps.getBpmMap(); the vitest harness may instead seed it
  // through setBpmMap().
  var bpmMap = {};

  // Injected host services / state getters (set by init).
  var deps = {
    authFetch: function () { return Promise.reject(new Error('FRFileMgmt not initialised')); },
    log: function () {},
    showError: function () {},
    showLoginOverlay: function () {},
    renderTrackSelector: function () {},
    loadOverlayAssets: function () {},
    getBpmMap: null,
    getAuthToken: function () { return ''; },
  };

  // -------------------------------------------------------------------------
  // Helpers that resolve injected services / live shared state at call time.
  // -------------------------------------------------------------------------
  function authFetch(url, opts) { return deps.authFetch(url, opts); }
  function log(msg) { return deps.log(msg); }
  function showError(msg) { return deps.showError(msg); }
  function showLoginOverlay() { return deps.showLoginOverlay(); }
  function renderTrackSelector(filter) { return deps.renderTrackSelector(filter); }
  function loadOverlayAssets() { return deps.loadOverlayAssets(); }

  function getBpmMap() {
    return deps.getBpmMap ? deps.getBpmMap() : bpmMap;
  }
  function fmtSize(bytes) {
    return window.FRUtils.fmtSize(bytes);
  }

  // -------------------------------------------------------------------------
  // File Management (behaviour-identical to the former app.js functions).
  // -------------------------------------------------------------------------
  function refreshBpmInList() {
    var musicList = document.getElementById('music-list');
    var items = musicList.querySelectorAll('.file-item');
    items.forEach(function (el) {
      var name = el.dataset.name;
      var bpmEl = el.querySelector('.file-bpm');
      if (bpmEl && name) {
        var bpm = getBpmMap()[name];
        bpmEl.textContent = bpm ? Math.round(bpm) + ' BPM' : '';
      }
    });
  }

  function loadFileList(type) {
    if (!type) return;
    authFetch('/api/' + type)
      .then(function (r) { return r.json(); })
      .then(function (files) {
        renderFileList(type, files);
        if (type === 'music') {
          musicFiles = files;
          renderTrackSelector();
        }
        if (type === 'visuals') {
          visualFiles = files;
        }
      })
      .catch(function (e) { log('files: error loading ' + type + ': ' + e); });
  }

  function renderFileList(type, files) {
    var container = document.getElementById(type === 'music' ? 'music-list' : 'visuals-list');
    var countEl = document.getElementById(type === 'music' ? 'music-count' : 'visuals-count');
    countEl.textContent = files.length + ' files';

    container.innerHTML = '';
    files.forEach(function (f) {
      var div = document.createElement('div');
      div.className = 'file-item';
      div.dataset.name = f.name;

      var nameEl = document.createElement('span');
      nameEl.className = 'file-name';
      nameEl.textContent = f.name;
      nameEl.title = f.name;
      div.appendChild(nameEl);

      if (type === 'music') {
        var bpmEl = document.createElement('span');
        bpmEl.className = 'file-bpm';
        var bpm = getBpmMap()[f.name];
        bpmEl.textContent = bpm ? Math.round(bpm) + ' BPM' : '';
        div.appendChild(bpmEl);
      }

      var sizeEl = document.createElement('span');
      sizeEl.className = 'file-size';
      sizeEl.textContent = fmtSize(f.size);
      div.appendChild(sizeEl);

      var delBtn = document.createElement('button');
      delBtn.className = 'file-del';
      delBtn.textContent = 'x';
      delBtn.title = 'Delete ' + f.name;
      delBtn.onclick = function () { deleteFile(type, f.name); };
      div.appendChild(delBtn);

      container.appendChild(div);
    });
  }

  function deleteFile(type, name) {
    if (!confirm('Delete ' + name + '?')) return;
    authFetch('/api/' + type + '/' + encodeURIComponent(name), { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function () {
        log('deleted ' + type + ': ' + name);
        loadFileList(type);
      })
      .catch(function (e) { showError('Delete failed: ' + e); });
  }

  // -------------------------------------------------------------------------
  // Drop Zone upload system.
  // -------------------------------------------------------------------------
  function initDropZone(el) {
    var input = el.querySelector('.drop-zone-input');
    var browseBtn = el.querySelector('.drop-zone-browse');
    var queueEl = el.querySelector('.drop-zone-queue');
    var type = el.dataset.type;
    var acceptStr = el.dataset.accept || '';
    var acceptExts = acceptStr.split(',').map(function(e) { return e.trim().toLowerCase(); });

    browseBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      input.click();
    });
    el.addEventListener('click', function(e) {
      if (e.target === el || e.target.closest('.drop-zone-prompt')) input.click();
    });

    el.addEventListener('dragenter', function(e) { e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragover', function(e) { e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', function(e) {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drag-over');
    });
    el.addEventListener('drop', function(e) {
      e.preventDefault();
      el.classList.remove('drag-over');
      handleFiles(e.dataTransfer.files);
    });

    input.addEventListener('change', function() {
      handleFiles(input.files);
      input.value = '';
    });

    function handleFiles(files) {
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var ext = '.' + f.name.split('.').pop().toLowerCase();
        if (acceptExts.length && acceptExts[0] && acceptExts.indexOf(ext) === -1) {
          log('skipped ' + f.name + ' (unsupported format)');
          continue;
        }
        uploadOneFile(type, f, queueEl);
      }
    }
  }

  /**
   * Wire every `.drop-zone` element on the page (was the inline
   * `document.querySelectorAll('.drop-zone').forEach(initDropZone)` in app.js).
   */
  function initDropZones() {
    document.querySelectorAll('.drop-zone').forEach(initDropZone);
  }

  function uploadOneFile(type, file, queueEl) {
    var item = document.createElement('div');
    item.className = 'upload-item';
    var nameSpan = document.createElement('span');
    nameSpan.className = 'upload-item-name';
    nameSpan.textContent = file.name;
    var sizeSpan = document.createElement('span');
    sizeSpan.className = 'upload-item-size';
    sizeSpan.textContent = fmtSize(file.size);
    var progressDiv = document.createElement('div');
    progressDiv.className = 'upload-item-progress';
    var fill = document.createElement('div');
    fill.className = 'upload-item-progress-fill';
    progressDiv.appendChild(fill);
    var badge = document.createElement('span');
    badge.className = 'upload-item-status uploading';
    badge.textContent = '0%';

    item.appendChild(nameSpan);
    item.appendChild(sizeSpan);
    item.appendChild(progressDiv);
    item.appendChild(badge);
    queueEl.appendChild(item);

    var isOverlay = (type === 'overlay-assets');
    var endpoint = isOverlay ? '/api/overlays/assets' : '/api/' + type;
    var fieldName = isOverlay ? 'file' : 'files';

    var formData = new FormData();
    formData.append(fieldName, file);

    var authToken = deps.getAuthToken();
    var xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint, true);
    if (authToken) xhr.setRequestHeader('Authorization', 'Bearer ' + authToken);

    xhr.upload.onprogress = function(e) {
      if (e.lengthComputable) {
        var pct = Math.round(e.loaded / e.total * 100);
        fill.style.width = pct + '%';
        badge.textContent = pct + '%';
      }
    };

    xhr.onload = function() {
      if (xhr.status >= 200 && xhr.status < 300) {
        fill.style.width = '100%';
        badge.className = 'upload-item-status ready';
        badge.textContent = 'OK';
        log('uploaded ' + file.name + ' to ' + type);
        if (type === 'overlay-assets') loadOverlayAssets();
        loadFileList(type === 'overlay-assets' ? null : type);
        setTimeout(function() {
          item.style.transition = 'opacity 0.4s';
          item.style.opacity = '0';
          setTimeout(function() { if (item.parentNode) item.parentNode.removeChild(item); }, 500);
        }, 3000);
      } else if (xhr.status === 401) {
        showLoginOverlay();
        badge.className = 'upload-item-status error';
        badge.textContent = 'AUTH';
      } else {
        badge.className = 'upload-item-status error';
        badge.textContent = 'ERROR';
        showError('Upload failed: ' + xhr.statusText);
      }
    };

    xhr.onerror = function() {
      badge.className = 'upload-item-status error';
      badge.textContent = 'ERROR';
      showError('Upload failed: network error');
    };

    xhr.send(formData);
    log('uploading ' + file.name + ' to ' + type);
  }

  /**
   * Store injected dependencies. Safe to call more than once (the vitest harness
   * re-inits per test with its own controllable deps).
   */
  function init(injected) {
    injected = injected || {};
    window.FRUtils.mergeDeps(deps, injected, 'FRFileMgmt');
  }

  return {
    init: init,
    loadFileList: loadFileList,
    initDropZones: initDropZones,
    getMusicFiles: function () { return musicFiles; },
    getVisualFiles: function () { return visualFiles; },

    // Surface used by the characterization tests to drive the module.
    refreshBpmInList: refreshBpmInList,
    renderFileList: renderFileList,
    deleteFile: deleteFile,
    initDropZone: initDropZone,
    uploadOneFile: uploadOneFile,
    setMusicFiles: function (a) { musicFiles = a; },
    setVisualFiles: function (a) { visualFiles = a; },
    setBpmMap: function (o) { bpmMap = o; },
  };
});
