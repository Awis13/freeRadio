/**
 * queue.js — Track queue, video queue and track selector for the
 * STUDIO 23 / FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the broadcast-core refactor).
 * Owns the queue list rendering, the add/skip/clear actions for both the music
 * and video queues, the mode-aware active-queue poll, and the track selector
 * with its search filter.
 *
 * SPLIT-BRAIN, PRESERVED ON PURPOSE. The skip and clear buttons have TWO
 * handler bodies: the boot copies (moved here, bound by init) and duplicates
 * that updateBroadcastUI re-assigns on every repaint (now in broadcast.js).
 * They are byte-equivalent today.
 * Consolidating them would be a behaviour change, so both survive this
 * extraction; the divergence and success-timer pins in broadcastUI.test.js keep
 * them honest. This is tracked for a follow-up, not fixed here.
 *
 * OWNED STATE: none beyond the DOM refs it renders into. The queue itself lives
 * on the server; every render is driven by a fetch.
 *
 * DOM refs: #queue-list and #track-selector are region-private and resolved
 * once in init(), mirroring app.js's module-scope caching. #skip-btn,
 * #clear-queue-btn and #queue-search are ALSO read by updateBroadcastUI and
 * applyUiMode in broadcast.js, which resolves them itself; this module resolves
 * the same elements by id.
 *
 * NOT OWNED HERE, injected instead — all three now belong to broadcast.js and
 * arrive through app.js's wiring:
 *   - bpmMap, written by the WS 'init' and 'bpm' frames, read by the selector's
 *     BPM badge -> getBpmMap.
 *   - processedVisualFiles, written by loadProcessedVisuals -> getProcessedVisualFiles.
 *   - broadcastState, read for the video/music mode split -> getBroadcastState.
 *   - FRFileMgmt's music list -> getMusicFiles, matching how app.js already
 *     passes it to FRPlaylists.
 *   - FRTrackHistory.loadTrackHistory, which skip's success branch schedules at
 *     2s -> loadTrackHistory. No sibling module reaches for another domain
 *     module directly, so it is injected rather than taken off window.
 *
 * cleanTrackName comes from window.FRUtils at call time, following
 * trackhistory.js — FRUtils is the shared util module every file may reach.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/queue.js"> (attaches its public API to window.FRQueue) AND
 * required by the vitest suite via module.exports (CJS). It deliberately uses NO
 * top-level `export`/`import` so a browser <script> can load it without a
 * SyntaxError.
 */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.FRQueue = api;
  }
})(function () {
  'use strict';

  // Injected host services (set by init). Defaults keep a pre-init call inert.
  var deps = {
    authFetch: function () { return Promise.reject(new Error('FRQueue not initialised')); },
    log: function () {},
    showError: function () {},
    getBroadcastState: function () { return null; },
    getBpmMap: function () { return {}; },
    getMusicFiles: function () { return []; },
    getProcessedVisualFiles: function () { return []; },
    loadTrackHistory: function () {},
  };

  // Helpers that resolve injected services at call time.
  function authFetch(url, opts) { return deps.authFetch(url, opts); }
  function log(msg) { return deps.log(msg); }
  function showError(msg) { return deps.showError(msg); }
  function getBroadcastState() { return deps.getBroadcastState(); }
  function getBpmMap() { return deps.getBpmMap(); }
  function getMusicFiles() { return deps.getMusicFiles(); }
  function getProcessedVisualFiles() { return deps.getProcessedVisualFiles(); }
  function loadTrackHistory() { return deps.loadTrackHistory(); }

  // Shared FRUtils helper resolved at call time (single source of truth).
  function cleanTrackName(f) { return window.FRUtils.cleanTrackName(f); }

  // DOM refs — assigned once by resolveDom() from init(), mirroring app.js's
  // module-scope resolution.
  var queueList = null;
  var trackSelector = null;
  var queueSearch = null;
  var skipBtn = null;
  var clearQueueBtn = null;

  function resolveDom() {
    queueList = document.getElementById('queue-list');
    trackSelector = document.getElementById('track-selector');
    queueSearch = document.getElementById('queue-search');
    skipBtn = document.getElementById('skip-btn');
    clearQueueBtn = document.getElementById('clear-queue-btn');
  }

  function loadQueue() {
    authFetch('/api/queue')
      .then(function(r) { return r.json(); })
      .then(function(items) { renderQueue(items); })
      .catch(function() { renderQueue([]); });
  }

  function renderQueue(items) {
    queueList.innerHTML = '';
    if (!items || items.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'queue-empty';
      empty.textContent = 'Queue empty \u2014 random mode';
      queueList.appendChild(empty);
      return;
    }
    items.forEach(function(path, i) {
      var div = document.createElement('div');
      div.className = 'queue-item';
      var num = document.createElement('span');
      num.className = 'queue-num';
      num.textContent = (i + 1) + '.';
      div.appendChild(num);
      var name = document.createElement('span');
      name.className = 'queue-name';
      name.textContent = cleanTrackName(path);
      name.title = path;
      div.appendChild(name);
      queueList.appendChild(div);
    });
  }

  function addToQueue(filename) {
    authFetch('/api/queue/push', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: filename
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          log('queue: added ' + filename);
          loadQueue();
        } else {
          showError('Queue push failed: ' + (data.error || 'unknown'));
        }
      })
      .catch(function(e) { showError('Queue push failed: ' + e); });
  }
  // --- Video Queue Control ---
  function loadVideoQueue() {
    authFetch('/api/video-queue')
      .then(function(r) { return r.json(); })
      .then(function(items) { renderQueue(items); })
      .catch(function() { renderQueue([]); });
  }

  function addToVideoQueue(filename) {
    authFetch('/api/video-queue/push', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: filename
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          log('video queue: added ' + filename);
          loadVideoQueue();
        }
      })
      .catch(function(e) { showError('Video queue push failed: ' + e); });
  }

  function skipVideo() {
    authFetch('/api/video-queue/skip', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          log('video: skipped');
          setTimeout(loadVideoQueue, 1000);
        }
      })
      .catch(function(e) { showError('Video skip failed: ' + e); });
  }

  function clearVideoQueue() {
    authFetch('/api/video-queue/clear', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          log('video queue: cleared');
          loadVideoQueue();
        }
      })
      .catch(function(e) { showError('Clear video queue failed: ' + e); });
  }

  function loadActiveQueue() {
    if (getBroadcastState().visualMode === 'video-playlist') loadVideoQueue();
    else loadQueue();
  }

  // --- Track Selector ---
  function renderTrackSelector(filter) {
    trackSelector.innerHTML = '';
    var isVideoMode = getBroadcastState().visualMode === 'video-playlist';
    var sourceFiles = isVideoMode ? getProcessedVisualFiles() : getMusicFiles();
    var search = (filter || '').toLowerCase();
    var filtered = sourceFiles.filter(function(f) {
      return !search || f.name.toLowerCase().indexOf(search) !== -1;
    });
    filtered.forEach(function(f) {
      var div = document.createElement('div');
      div.className = 'selector-item';

      var name = document.createElement('span');
      name.className = 'selector-name';
      name.textContent = f.name;
      name.title = f.name;
      div.appendChild(name);

      if (!isVideoMode) {
        var bpm = getBpmMap()[f.name];
        if (bpm) {
          var bpmEl = document.createElement('span');
          bpmEl.className = 'selector-bpm';
          bpmEl.textContent = Math.round(bpm) + ' BPM';
          div.appendChild(bpmEl);
        }
      }

      var addBtn = document.createElement('button');
      addBtn.className = 'btn-add-queue';
      addBtn.textContent = '+';
      addBtn.title = isVideoMode ? 'Add to video queue' : 'Add to queue';
      addBtn.onclick = isVideoMode
        ? (function(n) { return function() { addToVideoQueue(n); }; })(f.name)
        : (function(n) { return function() { addToQueue(n); }; })(f.name);
      div.appendChild(addBtn);

      trackSelector.appendChild(div);
    });
  }

  /**
   * Bind the boot copies of the skip/clear handlers and the search input, then
   * run the boot load and start the 5s active-queue poll — the same statements,
   * in the same order, that ran inline in app.js.
   */
  function bindBootHandlers() {
    skipBtn.onclick = function() {
      authFetch('/api/queue/skip', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok) {
            log('queue: skipped track');
            setTimeout(loadQueue, 1000);
            setTimeout(loadTrackHistory, 2000);
          }
        })
        .catch(function(e) { showError('Skip failed: ' + e); });
    };

    clearQueueBtn.onclick = function() {
      authFetch('/api/queue/clear', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok) {
            log('queue: cleared');
            loadQueue();
          }
        })
        .catch(function(e) { showError('Clear queue failed: ' + e); });
    };
    queueSearch.oninput = function() {
      renderTrackSelector(queueSearch.value);
    };

    loadQueue();
    setInterval(loadActiveQueue, 5000);
  }

  function init(injected) {
    injected = injected || {};
    for (var k in deps) {
      if (Object.prototype.hasOwnProperty.call(injected, k)) {
        deps[k] = injected[k];
      }
    }
    resolveDom();
    bindBootHandlers();
  }

  return {
    init: init,
    loadQueue: loadQueue,
    renderQueue: renderQueue,
    addToQueue: addToQueue,
    loadVideoQueue: loadVideoQueue,
    addToVideoQueue: addToVideoQueue,
    skipVideo: skipVideo,
    clearVideoQueue: clearVideoQueue,
    loadActiveQueue: loadActiveQueue,
    renderTrackSelector: renderTrackSelector,
  };
});
