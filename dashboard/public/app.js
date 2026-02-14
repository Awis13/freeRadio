(function () {
  'use strict';

  // --- DOM refs (Management tab) ---
  var video = document.getElementById('player');
  var modeTag = document.getElementById('mode-tag');
  var uptimeEl = document.getElementById('uptime');
  var qualitySelect = document.getElementById('quality-select');
  var errorBanner = document.getElementById('error-banner');
  var audioTrack = document.getElementById('audio-track');
  var videoTrack = document.getElementById('video-track');
  var trackBpm = document.getElementById('track-bpm');
  var statListeners = document.getElementById('stat-listeners');
  var statAudioBr = document.getElementById('stat-audio-br');
  var statFps = document.getElementById('stat-fps');
  var statSpeed = document.getElementById('stat-speed');
  var statVideoBr = document.getElementById('stat-video-br');
  var statTime = document.getElementById('stat-time');
  var musicList = document.getElementById('music-list');
  var musicCount = document.getElementById('music-count');
  var musicInput = document.getElementById('music-input');
  var musicStatus = document.getElementById('music-upload-status');
  var visualsList = document.getElementById('visuals-list');
  var visualsCount = document.getElementById('visuals-count');
  var visualsInput = document.getElementById('visuals-input');
  var visualsStatus = document.getElementById('visuals-upload-status');
  var logEl = document.getElementById('log');
  var dbgClear = document.getElementById('dbg-clear');
  var dbgPause = document.getElementById('dbg-pause');

  // --- DOM refs (Studio tab) ---
  var studioPlayer = document.getElementById('studio-player');
  var studioAudioTrack = document.getElementById('studio-audio-track');
  var studioBpm = document.getElementById('studio-bpm');
  var studioFps = document.getElementById('studio-fps');
  var studioBitrate = document.getElementById('studio-bitrate');
  var studioListeners = document.getElementById('studio-listeners');
  var queueList = document.getElementById('queue-list');
  var skipBtn = document.getElementById('skip-btn');
  var clearQueueBtn = document.getElementById('clear-queue-btn');
  var trackSelector = document.getElementById('track-selector');
  var queueSearch = document.getElementById('queue-search');

  // --- State ---
  var bpmMap = {};
  var logsPaused = false;
  var logs = [];
  var startTime = Date.now();
  var musicFiles = [];
  var visualFiles = [];
  var activeTab = 'studio';
  var playlists = [];
  var selectedPlaylistId = null;
  var selectedVisualProfileId = null;
  var listenerHistory = [];
  var peakListeners = 0;

  // --- Tab Switching ---
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var tab = btn.dataset.tab;
      activeTab = tab;
      document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
      document.getElementById('tab-' + tab).classList.add('active');
      // Load tab-specific data
      if (tab === 'playlists') loadPlaylists();
      if (tab === 'schedule') { loadSchedule(); loadPlaylistsForSelect(); }
      if (tab === 'visuals') { loadVisualProfiles(); loadOverlays(); loadOverlayAssets(); }
      if (tab === 'analytics') loadAnalytics();
    });
  });

  // --- Keyboard shortcuts ---
  document.addEventListener('keydown', function(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space' && activeTab === 'studio') {
      e.preventDefault();
      skipBtn.click();
    }
  });

  // --- Logging ---
  function log(msg) {
    var ts = new Date().toISOString().slice(11, 23);
    logs.push('[' + ts + '] ' + msg);
    if (logs.length > 500) logs.shift();
    if (!logsPaused) {
      logEl.textContent = logs.join('\n');
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  dbgClear.onclick = function () { logs.length = 0; logEl.textContent = ''; };
  dbgPause.onclick = function () {
    logsPaused = !logsPaused;
    dbgPause.textContent = logsPaused ? 'Resume' : 'Pause';
    if (!logsPaused) {
      logEl.textContent = logs.join('\n');
      logEl.scrollTop = logEl.scrollHeight;
    }
  };

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.classList.add('visible');
    log('ERROR: ' + msg);
    setTimeout(function() { errorBanner.classList.remove('visible'); }, 5000);
  }

  // --- Uptime ---
  setInterval(function () {
    var s = Math.floor((Date.now() - startTime) / 1000);
    var h = Math.floor(s / 3600); s %= 3600;
    var m = Math.floor(s / 60); s %= 60;
    uptimeEl.textContent = pad(h) + ':' + pad(m) + ':' + pad(s);
  }, 1000);

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  // --- Format helpers ---
  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function cleanTrackName(filename) {
    if (!filename) return '';
    var name = filename.split('/').pop() || filename;
    name = name.replace(/\.[^.]+$/, '');
    name = name.replace(/_/g, ' ');
    return name;
  }

  // --- HLS Player ---
  var hlsInstance = null;

  function initPlayer() {
    var src = '/hls/stream.m3u8';
    log('init player src=' + src);

    var ua = navigator.userAgent || '';
    var vendor = navigator.vendor || '';
    var isIOS = /iPad|iPhone|iPod/.test(ua);
    var isSafari = vendor === 'Apple Computer, Inc.' &&
      /Safari\//.test(ua) &&
      !/Chrome\/|Chromium\/|Edg\/|OPR\//.test(ua);

    if (isIOS || isSafari) {
      log('mode=native-hls');
      studioPlayer.src = src;
      video.src = src;
      studioPlayer.play().catch(function () {});
      video.play().catch(function () {});
      return;
    }

    if (typeof Hls === 'undefined') {
      log('hls.js not loaded, falling back to native');
      studioPlayer.src = src;
      video.src = src;
      studioPlayer.play().catch(function () {});
      video.play().catch(function () {});
      return;
    }

    if (!Hls.isSupported()) {
      log('MSE not supported');
      studioPlayer.src = src;
      video.src = src;
      return;
    }

    log('mode=hls.js v' + (Hls.version || '?'));

    hlsInstance = new Hls({
      lowLatencyMode: false,
      backBufferLength: 30,
      enableWorker: true,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10,
      liveDurationInfinity: true,
      maxBufferLength: 20,
      maxMaxBufferLength: 40
    });

    hlsInstance.on(Hls.Events.ERROR, function (_, data) {
      var msg = 'hls:error ' + data.type + '/' + data.details + ' fatal=' + data.fatal;
      log(msg);
      if (data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          log('hls: network error, retrying in 3s...');
          setTimeout(function () { hlsInstance.startLoad(); }, 3000);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          log('hls: media error, recovering...');
          hlsInstance.recoverMediaError();
        }
      }
    });

    hlsInstance.on(Hls.Events.MANIFEST_PARSED, function () {
      log('hls: manifest parsed, starting playback');
      studioPlayer.play().catch(function () {});
    });

    hlsInstance.on(Hls.Events.FRAG_LOADED, function (_, data) {
      var sn = data.frag ? data.frag.sn : '?';
      log('hls:frag sn=' + sn);
    });

    hlsInstance.loadSource(src);
    hlsInstance.attachMedia(studioPlayer);

    var hls2 = new Hls({
      lowLatencyMode: false,
      backBufferLength: 30,
      enableWorker: true,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10,
      liveDurationInfinity: true,
      maxBufferLength: 20,
      maxMaxBufferLength: 40
    });

    hls2.on(Hls.Events.ERROR, function (_, data) {
      if (data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          setTimeout(function () { hls2.startLoad(); }, 3000);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls2.recoverMediaError();
        }
      }
    });

    hls2.on(Hls.Events.MANIFEST_PARSED, function () {
      video.play().catch(function () {});
    });

    hls2.loadSource(src);
    hls2.attachMedia(video);
  }

  initPlayer();

  // --- WebSocket ---
  var ws = null;
  var wsReconnectDelay = 1000;

  function connectWs() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);

    ws.onopen = function () {
      log('ws: connected');
      wsReconnectDelay = 1000;
    };

    ws.onclose = function () {
      log('ws: disconnected, reconnecting in ' + (wsReconnectDelay / 1000) + 's');
      setTimeout(connectWs, wsReconnectDelay);
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, 10000);
    };

    ws.onerror = function () {
      log('ws: error');
    };

    ws.onmessage = function (evt) {
      try {
        var msg = JSON.parse(evt.data);
        handleMessage(msg);
      } catch (e) {
        log('ws: parse error ' + e);
      }
    };
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'init':
        updateMode(msg.data.outputMode);
        updateAudio(msg.data.audio);
        updateVideo(msg.data.video);
        updateIcecast(msg.data.icecast);
        updateFfmpeg(msg.data.ffmpeg);
        bpmMap = msg.data.bpm || {};
        loadFileList('music');
        loadFileList('visuals');
        break;
      case 'audio':
        updateAudio(msg.data);
        break;
      case 'video':
        updateVideo(msg.data);
        break;
      case 'icecast':
        updateIcecast(msg.data);
        break;
      case 'ffmpeg':
        updateFfmpeg(msg.data);
        break;
      case 'bpm':
        bpmMap = msg.data || {};
        refreshBpmInList();
        break;
    }
  }

  function updateMode(mode) {
    modeTag.textContent = (mode || 'hls').toUpperCase();
    if (mode === 'rtmp') {
      modeTag.classList.add('rtmp');
    }
  }

  function updateAudio(data) {
    if (!data) return;
    var name = data.title || cleanTrackName(data.filename) || '--';
    audioTrack.textContent = name;
    studioAudioTrack.textContent = name;

    var filename = (data.filename || '').split('/').pop();
    var bpm = bpmMap[filename];
    trackBpm.textContent = bpm ? Math.round(bpm) + ' BPM' : '';
    studioBpm.textContent = bpm ? Math.round(bpm) + ' BPM' : '';
  }

  function updateVideo(data) {
    if (!data) return;
    var name = data.title || cleanTrackName(data.filename) || '--';
    videoTrack.textContent = name;
  }

  function updateIcecast(data) {
    if (!data) return;
    statListeners.textContent = data.listeners || '0';
    studioListeners.textContent = data.listeners || '0';
    statAudioBr.textContent = data.bitrate ? data.bitrate + ' kbps' : '--';
    if (data.serverStart) {
      startTime = new Date(data.serverStart).getTime() || Date.now();
    }
    // Track listener history for analytics
    var count = parseInt(data.listeners) || 0;
    listenerHistory.push({ ts: Date.now(), count: count });
    if (listenerHistory.length > 720) listenerHistory.shift(); // ~1 hour at 5s intervals
    if (count > peakListeners) peakListeners = count;
  }

  function updateFfmpeg(data) {
    if (!data) return;
    statFps.textContent = data.fps || '--';
    statSpeed.textContent = data.speed || '--';
    statVideoBr.textContent = data.bitrate || '--';
    statTime.textContent = data.time || '--';
    studioFps.textContent = data.fps || '--';
    studioBitrate.textContent = data.bitrate || '--';
  }

  function refreshBpmInList() {
    var items = musicList.querySelectorAll('.file-item');
    items.forEach(function (el) {
      var name = el.dataset.name;
      var bpmEl = el.querySelector('.file-bpm');
      if (bpmEl && name) {
        var bpm = bpmMap[name];
        bpmEl.textContent = bpm ? Math.round(bpm) + ' BPM' : '';
      }
    });
  }

  connectWs();

  // --- File Management ---
  function loadFileList(type) {
    fetch('/api/' + type)
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
    var container = type === 'music' ? musicList : visualsList;
    var countEl = type === 'music' ? musicCount : visualsCount;
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
        var bpm = bpmMap[f.name];
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
    fetch('/api/' + type + '/' + encodeURIComponent(name), { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function () {
        log('deleted ' + type + ': ' + name);
        loadFileList(type);
      })
      .catch(function (e) { showError('Delete failed: ' + e); });
  }

  function uploadFiles(type, input, statusEl) {
    var files = input.files;
    if (!files || !files.length) return;

    var formData = new FormData();
    for (var i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }

    statusEl.textContent = 'Uploading ' + files.length + ' file(s)...';
    log('uploading ' + files.length + ' file(s) to ' + type);

    fetch('/api/' + type, { method: 'POST', body: formData })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var count = data.uploaded ? data.uploaded.length : 0;
        statusEl.textContent = 'Uploaded ' + count + ' file(s)';
        log('uploaded ' + count + ' file(s) to ' + type);
        loadFileList(type);
        setTimeout(function () { statusEl.textContent = ''; }, 3000);
      })
      .catch(function (e) {
        statusEl.textContent = 'Upload failed';
        showError('Upload failed: ' + e);
      });

    input.value = '';
  }

  musicInput.onchange = function () { uploadFiles('music', musicInput, musicStatus); };
  visualsInput.onchange = function () { uploadFiles('visuals', visualsInput, visualsStatus); };

  setInterval(function () { loadFileList('music'); }, 30000);
  setInterval(function () { loadFileList('visuals'); }, 30000);

  // --- Queue Control ---
  function loadQueue() {
    fetch('/api/queue')
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
    fetch('/api/queue/push', {
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

  skipBtn.onclick = function() {
    fetch('/api/queue/skip', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          log('queue: skipped track');
          setTimeout(loadQueue, 1000);
        }
      })
      .catch(function(e) { showError('Skip failed: ' + e); });
  };

  clearQueueBtn.onclick = function() {
    fetch('/api/queue/clear', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok) {
          log('queue: cleared');
          loadQueue();
        }
      })
      .catch(function(e) { showError('Clear queue failed: ' + e); });
  };

  // --- Track Selector ---
  function renderTrackSelector(filter) {
    trackSelector.innerHTML = '';
    var search = (filter || '').toLowerCase();
    var filtered = musicFiles.filter(function(f) {
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

      var bpm = bpmMap[f.name];
      if (bpm) {
        var bpmEl = document.createElement('span');
        bpmEl.className = 'selector-bpm';
        bpmEl.textContent = Math.round(bpm) + ' BPM';
        div.appendChild(bpmEl);
      }

      var addBtn = document.createElement('button');
      addBtn.className = 'btn-add-queue';
      addBtn.textContent = '+';
      addBtn.title = 'Add to queue';
      addBtn.onclick = function() { addToQueue(f.name); };
      div.appendChild(addBtn);

      trackSelector.appendChild(div);
    });
  }

  queueSearch.oninput = function() {
    renderTrackSelector(queueSearch.value);
  };

  loadQueue();
  setInterval(loadQueue, 5000);

  // ============================
  // PLAYLISTS
  // ============================
  function loadPlaylists() {
    fetch('/api/playlists')
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
    fetch('/api/playlists/' + id)
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
      // Show rules
      var rulesDiv = document.createElement('div');
      rulesDiv.className = 'smart-rules';

      var rules = pl.rules || {};
      var html = '<div class="form-group"><label>BPM Range</label><div class="range-inputs">' +
        '<input type="number" id="smart-bpm-min" value="' + (rules.bpmMin || '') + '" placeholder="Min" class="input-small">' +
        ' - <input type="number" id="smart-bpm-max" value="' + (rules.bpmMax || '') + '" placeholder="Max" class="input-small">' +
        '</div></div>' +
        '<div class="form-group"><label>Name Pattern (regex)</label>' +
        '<input type="text" id="smart-name-pattern" value="' + (rules.namePattern || '') + '" placeholder="e.g. hard.*techno"></div>' +
        '<div class="form-group"><label>Tags</label>' +
        '<input type="text" id="smart-tags" value="' + ((rules.tags || []).join(', ')) + '" placeholder="tag1, tag2"></div>' +
        '<div class="form-group"><label>Tag Mode</label>' +
        '<select id="smart-tag-mode"><option value="any"' + (rules.tagMode !== 'all' ? ' selected' : '') + '>Any</option>' +
        '<option value="all"' + (rules.tagMode === 'all' ? ' selected' : '') + '>All</option></select></div>' +
        '<button class="btn-primary" onclick="updateSmartRules(\'' + pl.id + '\')">Update Rules</button>';
      rulesDiv.innerHTML = html;
      contentEl.appendChild(rulesDiv);

      // Show resolved tracks
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
      // Manual playlist — show tracks with drag reorder
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
          grip.textContent = '\u2261';
          item.appendChild(grip);

          var nameEl = document.createElement('span');
          nameEl.className = 'playlist-track-name';
          nameEl.textContent = t;
          item.appendChild(nameEl);

          var bpm = bpmMap[t];
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

          // Drag events
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

      // Show track library for adding
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
      var filtered = musicFiles.filter(function(f) {
        return !search || f.name.toLowerCase().indexOf(search) !== -1;
      });
      filtered.forEach(function(f) {
        var div = document.createElement('div');
        div.className = 'selector-item';

        var name = document.createElement('span');
        name.className = 'selector-name';
        name.textContent = f.name;
        div.appendChild(name);

        var bpm = bpmMap[f.name];
        if (bpm) {
          var bpmEl = document.createElement('span');
          bpmEl.className = 'selector-bpm';
          bpmEl.textContent = Math.round(bpm) + ' BPM';
          div.appendChild(bpmEl);
        }

        var inPlaylist = existingTracks.indexOf(f.name) !== -1;
        var addBtn = document.createElement('button');
        addBtn.className = 'btn-add-queue';
        addBtn.textContent = inPlaylist ? '\u2713' : '+';
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
    fetch('/api/playlists/' + playlistId)
      .then(function(r) { return r.json(); })
      .then(function(pl) {
        var tracks = (pl.tracks || []).concat([track]);
        return fetch('/api/playlists/' + playlistId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracks: tracks })
        });
      })
      .then(function() { selectPlaylist(playlistId); })
      .catch(function(e) { showError('Add track failed: ' + e); });
  }

  function removeTrackFromPlaylist(playlistId, idx) {
    fetch('/api/playlists/' + playlistId)
      .then(function(r) { return r.json(); })
      .then(function(pl) {
        var tracks = (pl.tracks || []).slice();
        tracks.splice(idx, 1);
        return fetch('/api/playlists/' + playlistId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracks: tracks })
        });
      })
      .then(function() { selectPlaylist(playlistId); })
      .catch(function(e) { showError('Remove track failed: ' + e); });
  }

  function reorderPlaylistTrack(playlistId, from, to) {
    fetch('/api/playlists/' + playlistId + '/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from, to: to })
    })
      .then(function() { selectPlaylist(playlistId); })
      .catch(function(e) { showError('Reorder failed: ' + e); });
  }

  window.updateSmartRules = function(playlistId) {
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

    fetch('/api/playlists/' + playlistId, {
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
  };

  // Create playlist
  document.getElementById('create-playlist-btn').onclick = function() {
    openGenericModal('Create Playlist',
      '<div class="form-group"><label>Name</label><input type="text" id="new-playlist-name" placeholder="My Playlist"></div>' +
      '<div class="form-group"><label>Type</label><select id="new-playlist-type">' +
      '<option value="manual">Manual</option><option value="smart">Smart</option></select></div>',
      function() {
        var name = document.getElementById('new-playlist-name').value.trim();
        var type = document.getElementById('new-playlist-type').value;
        if (!name) return;
        fetch('/api/playlists', {
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
  };

  // Delete playlist
  document.getElementById('playlist-delete-btn').onclick = function() {
    if (!selectedPlaylistId) return;
    if (!confirm('Delete this playlist?')) return;
    fetch('/api/playlists/' + selectedPlaylistId, { method: 'DELETE' })
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
  };

  // Load playlist to queue
  document.getElementById('playlist-load-queue-btn').onclick = function() {
    if (!selectedPlaylistId) return;
    fetch('/api/queue/load-playlist', {
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
  };

  // Import M3U
  document.getElementById('import-m3u-input').onchange = function() {
    var file = this.files[0];
    if (!file) return;
    var formData = new FormData();
    formData.append('file', file);
    formData.append('name', file.name.replace(/\.[^.]+$/, ''));
    fetch('/api/playlists/import', { method: 'POST', body: formData })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        log('playlist: imported ' + data.importedCount + '/' + data.totalParsed + ' tracks');
        loadPlaylists();
        if (data.id) selectPlaylist(data.id);
      })
      .catch(function(e) { showError('Import failed: ' + e); });
    this.value = '';
  };

  // ============================
  // SCHEDULE
  // ============================
  var scheduleData = { weekly: {}, events: {}, settings: {} };

  function loadSchedule() {
    fetch('/api/schedule')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        scheduleData = data;
        renderScheduleGrid();
        renderEventsList();
        renderScheduleSettings();
        loadScheduleCurrent();
      })
      .catch(function(e) { log('schedule: error: ' + e); });
  }

  function loadScheduleCurrent() {
    fetch('/api/schedule/current')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        document.getElementById('sched-active-slot').textContent = data.label || data.slotId || '--';
        document.getElementById('sched-active-playlist').textContent = data.playlistName || '--';
        document.getElementById('sw-now').textContent = data.label || 'No active slot';
        document.getElementById('sw-next').textContent = data.nextLabel || '--';
      })
      .catch(function() {
        document.getElementById('sw-now').textContent = 'Schedule off';
      });
  }

  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function renderScheduleGrid() {
    var grid = document.getElementById('schedule-grid');
    grid.innerHTML = '';

    // Header row
    var headerRow = document.createElement('div');
    headerRow.className = 'sched-header-row';
    headerRow.innerHTML = '<div class="sched-time-col"></div>';
    DAYS.forEach(function(d) {
      headerRow.innerHTML += '<div class="sched-day-col">' + d + '</div>';
    });
    grid.appendChild(headerRow);

    // Time rows (every 2 hours)
    for (var h = 0; h < 24; h += 2) {
      var row = document.createElement('div');
      row.className = 'sched-row';

      var timeCell = document.createElement('div');
      timeCell.className = 'sched-time-col';
      timeCell.textContent = pad(h) + ':00';
      row.appendChild(timeCell);

      for (var d = 0; d < 7; d++) {
        var cell = document.createElement('div');
        cell.className = 'sched-cell';
        cell.dataset.day = d;
        cell.dataset.hour = h;

        // Find slots that overlap this time
        var slots = Object.values(scheduleData.weekly || {}).filter(function(s) {
          if (s.day !== d) return false;
          var startH = parseInt(s.startTime.split(':')[0]);
          var endH = parseInt(s.endTime.split(':')[0]);
          if (endH <= startH) endH += 24; // overnight
          return h >= startH && h < endH || (h + 24 >= startH && h + 24 < endH);
        });

        if (slots.length > 0) {
          cell.className += ' sched-cell-filled';
          cell.textContent = slots[0].label || 'Slot';
          cell.title = slots[0].label + ' (' + slots[0].startTime + '-' + slots[0].endTime + ')';
          (function(slot) {
            cell.onclick = function() {
              if (confirm('Delete slot "' + (slot.label || slot.id) + '"?')) {
                deleteWeeklySlot(slot.id);
              }
            };
          })(slots[0]);
        }

        row.appendChild(cell);
      }
      grid.appendChild(row);
    }
  }

  function renderEventsList() {
    var container = document.getElementById('events-list');
    var events = Object.values(scheduleData.events || {});
    container.innerHTML = '';
    if (events.length === 0) {
      container.innerHTML = '<div class="empty-state">No events</div>';
      return;
    }
    events.sort(function(a, b) { return a.date < b.date ? -1 : 1; });
    events.forEach(function(ev) {
      var div = document.createElement('div');
      div.className = 'event-item';
      div.innerHTML =
        '<span class="event-date">' + ev.date + '</span>' +
        '<span class="event-time">' + ev.startTime + '-' + ev.endTime + '</span>' +
        '<span class="event-label">' + (ev.label || 'Event') + '</span>' +
        '<button class="file-del" title="Delete">x</button>';
      div.querySelector('button').onclick = function() {
        deleteEvent(ev.id);
      };
      container.appendChild(div);
    });
  }

  function renderScheduleSettings() {
    var s = scheduleData.settings || {};
    document.getElementById('schedule-timezone').value = s.timezone || 'Europe/Moscow';
    document.getElementById('schedule-enabled').checked = s.enabled !== false;
    // Populate playlist dropdown
    loadPlaylistsForSelect();
    setTimeout(function() {
      var sel = document.getElementById('schedule-default-playlist');
      sel.value = s.defaultPlaylistId || '';
    }, 500);
  }

  function loadPlaylistsForSelect() {
    fetch('/api/playlists')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var selects = document.querySelectorAll('#schedule-default-playlist, .playlist-select');
        selects.forEach(function(sel) {
          var current = sel.value;
          sel.innerHTML = '<option value="">-- None --</option>';
          data.forEach(function(pl) {
            sel.innerHTML += '<option value="' + pl.id + '">' + pl.name + '</option>';
          });
          sel.value = current;
        });
      })
      .catch(function() {});
  }

  document.getElementById('save-schedule-settings').onclick = function() {
    var settings = {
      timezone: document.getElementById('schedule-timezone').value,
      defaultPlaylistId: document.getElementById('schedule-default-playlist').value || null,
      enabled: document.getElementById('schedule-enabled').checked
    };
    fetch('/api/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: settings })
    })
      .then(function() { log('schedule: settings saved'); })
      .catch(function(e) { showError('Save schedule settings failed: ' + e); });
  };

  document.getElementById('add-weekly-slot-btn').onclick = function() {
    openGenericModal('Add Weekly Slot',
      '<div class="form-group"><label>Day</label><select id="slot-day">' +
      DAYS.map(function(d, i) { return '<option value="' + i + '">' + d + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="form-group"><label>Start Time</label><input type="time" id="slot-start" value="22:00"></div>' +
      '<div class="form-group"><label>End Time</label><input type="time" id="slot-end" value="06:00"></div>' +
      '<div class="form-group"><label>Playlist</label><select id="slot-playlist" class="playlist-select"><option value="">-- None --</option></select></div>' +
      '<div class="form-group"><label>Label</label><input type="text" id="slot-label" placeholder="Friday Night"></div>',
      function() {
        var slot = {
          day: parseInt(document.getElementById('slot-day').value),
          startTime: document.getElementById('slot-start').value,
          endTime: document.getElementById('slot-end').value,
          playlistId: document.getElementById('slot-playlist').value || null,
          label: document.getElementById('slot-label').value.trim()
        };
        fetch('/api/schedule/weekly', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(slot)
        })
          .then(function() { closeGenericModal(); loadSchedule(); })
          .catch(function(e) { showError('Add slot failed: ' + e); });
      }
    );
    loadPlaylistsForSelect();
  };

  function deleteWeeklySlot(id) {
    fetch('/api/schedule/weekly/' + id, { method: 'DELETE' })
      .then(function() { loadSchedule(); })
      .catch(function(e) { showError('Delete slot failed: ' + e); });
  }

  document.getElementById('add-event-btn').onclick = function() {
    openGenericModal('Add Event',
      '<div class="form-group"><label>Date</label><input type="date" id="event-date"></div>' +
      '<div class="form-group"><label>Start Time</label><input type="time" id="event-start" value="20:00"></div>' +
      '<div class="form-group"><label>End Time</label><input type="time" id="event-end" value="23:00"></div>' +
      '<div class="form-group"><label>Playlist</label><select id="event-playlist" class="playlist-select"><option value="">-- None --</option></select></div>' +
      '<div class="form-group"><label>Label</label><input type="text" id="event-label" placeholder="Guest DJ"></div>',
      function() {
        var ev = {
          date: document.getElementById('event-date').value,
          startTime: document.getElementById('event-start').value,
          endTime: document.getElementById('event-end').value,
          playlistId: document.getElementById('event-playlist').value || null,
          label: document.getElementById('event-label').value.trim()
        };
        fetch('/api/schedule/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ev)
        })
          .then(function() { closeGenericModal(); loadSchedule(); })
          .catch(function(e) { showError('Add event failed: ' + e); });
      }
    );
    loadPlaylistsForSelect();
  };

  function deleteEvent(id) {
    if (!confirm('Delete this event?')) return;
    fetch('/api/schedule/events/' + id, { method: 'DELETE' })
      .then(function() { loadSchedule(); })
      .catch(function(e) { showError('Delete event failed: ' + e); });
  }

  // Poll schedule widget
  setInterval(loadScheduleCurrent, 30000);

  // ============================
  // VISUAL PROFILES
  // ============================
  function loadVisualProfiles() {
    fetch('/api/visual-profiles')
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

    fetch('/api/visual-profiles/' + id)
      .then(function(r) { return r.json(); })
      .then(function(p) { renderVisualProfileDetail(p); })
      .catch(function(e) { showError('Failed to load profile: ' + e); });
  }

  function renderVisualProfileDetail(profile) {
    document.getElementById('vp-detail-title').textContent = profile.name;
    var grid = document.getElementById('vp-video-grid');
    grid.innerHTML = '';

    // Get all available visuals
    fetch('/api/visuals')
      .then(function(r) { return r.json(); })
      .then(function(allVideos) {
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
      });

    // Activate button
    document.getElementById('vp-activate-btn').onclick = function() {
      fetch('/api/visual-profiles/' + profile.id + '/activate', { method: 'POST' })
        .then(function() {
          log('visual: activated ' + profile.name);
          loadVisualProfiles();
        })
        .catch(function(e) { showError('Activate failed: ' + e); });
    };

    // Delete button
    document.getElementById('vp-delete-btn').onclick = function() {
      if (!confirm('Delete profile "' + profile.name + '"?')) return;
      fetch('/api/visual-profiles/' + profile.id, { method: 'DELETE' })
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
    fetch('/api/visual-profiles/' + profileId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videos: selected })
    }).catch(function(e) { showError('Save videos failed: ' + e); });
  }

  document.getElementById('create-visual-profile-btn').onclick = function() {
    openGenericModal('Create Visual Profile',
      '<div class="form-group"><label>Name</label><input type="text" id="new-vp-name" placeholder="Night Visuals"></div>',
      function() {
        var name = document.getElementById('new-vp-name').value.trim();
        if (!name) return;
        fetch('/api/visual-profiles', {
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

  // ============================
  // OVERLAYS
  // ============================
  var overlayConfig = { enabled: false, layers: [] };

  function loadOverlays() {
    fetch('/api/overlays')
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
        '<label class="checkbox-label"><input type="checkbox" ' + (layer.enabled ? 'checked' : '') + ' onchange="toggleOverlayLayer(' + idx + ', this.checked)"> ' +
        '<span class="overlay-type-badge">' + layer.type + '</span></label>' +
        '<button class="file-del" onclick="removeOverlayLayer(' + idx + ')">x</button>';
      div.appendChild(header);

      var body = document.createElement('div');
      body.className = 'overlay-layer-body';

      if (layer.type === 'now_playing' || layer.type === 'static_text' || layer.type === 'clock') {
        body.innerHTML =
          '<div class="overlay-props">' +
          (layer.type === 'static_text' ? '<div class="form-group"><label>Text</label><input type="text" value="' + (layer.text || '') + '" onchange="updateOverlayLayer(' + idx + ', \'text\', this.value)"></div>' : '') +
          (layer.type === 'clock' ? '<div class="form-group"><label>Format</label><input type="text" value="' + (layer.format || '%H:%M') + '" onchange="updateOverlayLayer(' + idx + ', \'format\', this.value)"></div>' : '') +
          '<div class="overlay-pos-grid">' +
          '<div class="form-group"><label>Font Size</label><input type="number" value="' + (layer.fontsize || 28) + '" onchange="updateOverlayLayer(' + idx + ', \'fontsize\', parseInt(this.value))"></div>' +
          '<div class="form-group"><label>Color</label><input type="text" value="' + (layer.fontcolor || 'white') + '" onchange="updateOverlayLayer(' + idx + ', \'fontcolor\', this.value)"></div>' +
          '<div class="form-group"><label>X</label><input type="text" value="' + (layer.x || '20') + '" onchange="updateOverlayLayer(' + idx + ', \'x\', this.value)"></div>' +
          '<div class="form-group"><label>Y</label><input type="text" value="' + (layer.y || '20') + '" onchange="updateOverlayLayer(' + idx + ', \'y\', this.value)"></div>' +
          '</div>' +
          '<div class="form-group"><label>Box Color</label><input type="text" value="' + (layer.boxcolor || '') + '" placeholder="black@0.6" onchange="updateOverlayLayer(' + idx + ', \'boxcolor\', this.value)"></div>' +
          '</div>';
      } else if (layer.type === 'logo') {
        body.innerHTML =
          '<div class="overlay-props">' +
          '<div class="form-group"><label>Asset</label><input type="text" value="' + (layer.asset || '') + '" onchange="updateOverlayLayer(' + idx + ', \'asset\', this.value)" placeholder="logo.png"></div>' +
          '<div class="overlay-pos-grid">' +
          '<div class="form-group"><label>X</label><input type="text" value="' + (layer.x || 'W-w-20') + '" onchange="updateOverlayLayer(' + idx + ', \'x\', this.value)"></div>' +
          '<div class="form-group"><label>Y</label><input type="text" value="' + (layer.y || '20') + '" onchange="updateOverlayLayer(' + idx + ', \'y\', this.value)"></div>' +
          '</div>' +
          '</div>';
      }
      div.appendChild(body);
      container.appendChild(div);
    });
  }

  document.getElementById('overlays-enabled-check').onchange = function() {
    overlayConfig.enabled = this.checked;
    saveOverlays();
  };

  window.toggleOverlayLayer = function(idx, enabled) {
    overlayConfig.layers[idx].enabled = enabled;
    saveOverlays();
  };

  window.updateOverlayLayer = function(idx, prop, value) {
    overlayConfig.layers[idx][prop] = value;
    saveOverlays();
  };

  window.removeOverlayLayer = function(idx) {
    overlayConfig.layers.splice(idx, 1);
    saveOverlays();
    renderOverlayLayers();
  };

  function saveOverlays() {
    fetch('/api/overlays', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(overlayConfig)
    })
      .then(function() { log('overlays: saved'); })
      .catch(function(e) { showError('Save overlays failed: ' + e); });
  }

  document.getElementById('add-overlay-btn').onclick = function() {
    openGenericModal('Add Overlay Layer',
      '<div class="form-group"><label>Type</label><select id="new-overlay-type">' +
      '<option value="now_playing">Now Playing</option>' +
      '<option value="static_text">Static Text</option>' +
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
          layer.text = 'SYSTEM 23';
          layer.fontsize = 18;
          layer.fontcolor = 'white';
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

  // Overlay assets
  function loadOverlayAssets() {
    fetch('/api/overlays/assets')
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
            '<span class="file-name">' + a.name + '</span>' +
            '<span class="file-size">' + fmtSize(a.size) + '</span>' +
            '<button class="file-del" title="Delete">x</button>';
          div.querySelector('button').onclick = function() {
            fetch('/api/overlays/assets/' + encodeURIComponent(a.name), { method: 'DELETE' })
              .then(function() { loadOverlayAssets(); });
          };
          container.appendChild(div);
        });
      })
      .catch(function() {});
  }

  document.getElementById('overlay-asset-input').onchange = function() {
    var file = this.files[0];
    if (!file) return;
    var formData = new FormData();
    formData.append('file', file);
    fetch('/api/overlays/assets', { method: 'POST', body: formData })
      .then(function() { loadOverlayAssets(); })
      .catch(function(e) { showError('Upload failed: ' + e); });
    this.value = '';
  };

  // ============================
  // ANALYTICS
  // ============================
  function loadAnalytics() {
    drawListenerChart();
    loadHistoryStats();
  }

  function drawListenerChart() {
    var canvas = document.getElementById('listeners-chart');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var w = canvas.width = canvas.parentElement.offsetWidth - 24;
    var h = canvas.height = 200;

    ctx.clearRect(0, 0, w, h);

    if (listenerHistory.length < 2) {
      ctx.fillStyle = '#9fb6cc';
      ctx.font = '13px monospace';
      ctx.fillText('Collecting data...', w / 2 - 60, h / 2);
      return;
    }

    var maxCount = Math.max.apply(null, listenerHistory.map(function(p) { return p.count; })) || 1;
    var padding = 40;
    var graphW = w - padding * 2;
    var graphH = h - padding * 2;

    // Grid
    ctx.strokeStyle = '#1c2631';
    ctx.lineWidth = 1;
    for (var i = 0; i <= 4; i++) {
      var gy = padding + graphH * (1 - i / 4);
      ctx.beginPath();
      ctx.moveTo(padding, gy);
      ctx.lineTo(w - padding, gy);
      ctx.stroke();
      ctx.fillStyle = '#9fb6cc';
      ctx.font = '10px monospace';
      ctx.fillText(Math.round(maxCount * i / 4), 2, gy + 4);
    }

    // Line
    ctx.strokeStyle = '#c4ffcb';
    ctx.lineWidth = 2;
    ctx.beginPath();
    listenerHistory.forEach(function(p, idx) {
      var x = padding + (idx / (listenerHistory.length - 1)) * graphW;
      var y = padding + graphH * (1 - p.count / maxCount);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill
    ctx.lineTo(padding + graphW, padding + graphH);
    ctx.lineTo(padding, padding + graphH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(196, 255, 203, 0.1)';
    ctx.fill();
  }

  function loadHistoryStats() {
    fetch('/api/history/stats')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        document.getElementById('analytics-total-tracks').textContent = data.totalPlayed || 0;
        document.getElementById('analytics-unique-tracks').textContent = data.uniqueTracks || 0;
        document.getElementById('analytics-peak-listeners').textContent = peakListeners;

        // Draw top tracks chart
        drawTopTracksChart(data.topTracks || []);

        // Uptime
        if (data.uptimeMs) {
          var hrs = Math.floor(data.uptimeMs / 3600000);
          var mins = Math.floor((data.uptimeMs % 3600000) / 60000);
          document.getElementById('analytics-uptime-value').textContent = hrs + 'h ' + mins + 'm';
        }
      })
      .catch(function() {
        document.getElementById('analytics-total-tracks').textContent = '0';
        document.getElementById('analytics-unique-tracks').textContent = '0';
        document.getElementById('analytics-peak-listeners').textContent = peakListeners;
      });
  }

  function drawTopTracksChart(tracks) {
    var canvas = document.getElementById('tracks-chart');
    if (!canvas || !tracks.length) return;
    var ctx = canvas.getContext('2d');
    var w = canvas.width = canvas.parentElement.offsetWidth - 24;
    var h = canvas.height = Math.max(200, tracks.length * 30 + 40);

    ctx.clearRect(0, 0, w, h);

    var top10 = tracks.slice(0, 10);
    var maxPlays = top10[0] ? top10[0].count : 1;
    var barH = 22;
    var gap = 6;
    var labelW = 200;

    top10.forEach(function(t, idx) {
      var y = 20 + idx * (barH + gap);
      var barW = (w - labelW - 60) * (t.count / maxPlays);

      // Bar
      ctx.fillStyle = '#243244';
      ctx.fillRect(labelW, y, w - labelW - 60, barH);
      ctx.fillStyle = '#c4ffcb';
      ctx.fillRect(labelW, y, barW, barH);

      // Label
      ctx.fillStyle = '#d7e1ea';
      ctx.font = '11px monospace';
      var name = t.track.length > 28 ? t.track.substr(0, 28) + '...' : t.track;
      ctx.fillText(name, 4, y + 15);

      // Count
      ctx.fillStyle = '#9fb6cc';
      ctx.fillText(t.count + 'x', w - 50, y + 15);
    });
  }

  // ============================
  // RESTREAM STATUS WIDGET (Studio sidebar)
  // ============================
  function loadRestreamStatusWidget() {
    fetch('/api/stream-keys')
      .then(function(r) { return r.json(); })
      .then(function(platforms) {
        var container = document.getElementById('restream-status-list');
        container.innerHTML = '';
        Object.entries(platforms).forEach(function(entry) {
          var name = entry[0];
          var config = entry[1];
          var div = document.createElement('div');
          div.className = 'restream-status-item';
          div.innerHTML =
            '<span class="restream-status-dot ' + (config.enabled ? 'on' : 'off') + '"></span>' +
            '<span>' + name + '</span>';
          container.appendChild(div);
        });
        if (Object.keys(platforms).length === 0) {
          container.innerHTML = '<div class="empty-state">No platforms</div>';
        }
      })
      .catch(function() {});
  }

  loadRestreamStatusWidget();
  setInterval(loadRestreamStatusWidget, 15000);

  // ============================
  // STREAM PLATFORMS (Management tab)
  // ============================
  var platformList = document.getElementById('platform-list');
  var addPlatformBtn = document.getElementById('add-platform-btn');
  var platformModal = document.getElementById('platform-modal');
  var platformNameInput = document.getElementById('platform-name-input');
  var streamKeyInput = document.getElementById('stream-key-input');
  var rtmpUrlInput = document.getElementById('rtmp-url-input');
  var rtmpHelp = document.getElementById('rtmp-help');
  var platformEnabled = document.getElementById('platform-enabled');
  var restreamAutoStartCheckbox = document.getElementById('restream-autostart-checkbox');

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
    fetch('/api/stream-keys')
      .then(function(r) { return r.json(); })
      .then(function(platforms) { renderPlatforms(platforms); })
      .catch(function(e) { log('platforms: error loading: ' + e); });
  }

  function renderPlatforms(platforms) {
    platformList.innerHTML = '';
    Object.entries(platforms).forEach(function(entry) {
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
      delBtn.textContent = '\u00d7';
      delBtn.onclick = function() { deletePlatform(name); };
      div.appendChild(delBtn);

      platformList.appendChild(div);
    });
  }

  function deletePlatform(name) {
    if (!confirm('Remove ' + name + '?')) return;
    fetch('/api/stream-keys/' + encodeURIComponent(name), { method: 'DELETE' })
      .then(function() {
        log('platform removed: ' + name);
        loadPlatforms();
      })
      .catch(function(e) { showError('Remove failed: ' + e); });
  }

  function togglePlatform(name, enabled) {
    fetch('/api/stream-keys/' + encodeURIComponent(name) + '/enabled', {
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

  addPlatformBtn.onclick = function() {
    platformNameInput.value = '';
    rtmpUrlInput.value = '';
    streamKeyInput.value = '';
    platformEnabled.checked = true;
    syncPlatformHints();
    platformModal.style.display = 'flex';
  };

  platformNameInput.oninput = syncPlatformHints;

  window.closePlatformModal = function() {
    platformModal.style.display = 'none';
  };

  window.savePlatform = function() {
    var name = platformNameInput.value.trim();
    var rtmpUrl = rtmpUrlInput.value.trim();
    var key = streamKeyInput.value.trim();
    var enabled = platformEnabled.checked;

    if (!name) { alert('Please enter platform name'); return; }
    if (!rtmpUrl) { alert('Please enter RTMP URL'); return; }
    if (!key) { alert('Please enter stream key'); return; }

    fetch('/api/stream-keys/' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled, streamKey: key, rtmpUrl: rtmpUrl })
    })
      .then(function() {
        log('platform saved: ' + name);
        closePlatformModal();
        loadPlatforms();
      })
      .catch(function(e) { showError('Save failed: ' + e); });
  };

  platformModal.onclick = function(e) {
    if (e.target === platformModal) closePlatformModal();
  };

  function loadRestreamSettings() {
    fetch('/api/restream/settings')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        restreamAutoStartCheckbox.checked = !!data.autoStart;
      })
      .catch(function(e) { log('restream settings: error loading: ' + e); });
  }

  restreamAutoStartCheckbox.onchange = function() {
    fetch('/api/restream/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoStart: restreamAutoStartCheckbox.checked })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.success) throw new Error(data.error || 'save failed');
        log('restream autostart: ' + (data.autoStart ? 'ON' : 'OFF'));
      })
      .catch(function(e) { showError('Restream autostart save failed: ' + e); });
  };

  loadPlatforms();
  loadRestreamSettings();
  setInterval(loadPlatforms, 30000);

  // --- Stream Control ---
  var streamToggleBtn = document.getElementById('stream-toggle-btn');

  function loadStreamControl() {
    fetch('/api/stream/control')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        updateStreamToggle(data.streaming);
      })
      .catch(function(e) { log('stream control: error loading: ' + e); });
  }

  function updateStreamToggle(streaming) {
    if (streaming) {
      streamToggleBtn.textContent = 'Stop Restream';
      streamToggleBtn.className = 'btn-toggle streaming';
    } else {
      streamToggleBtn.textContent = 'Start Restream';
      streamToggleBtn.className = 'btn-toggle stopped';
    }
  }

  streamToggleBtn.onclick = function() {
    var currentlyStreaming = streamToggleBtn.classList.contains('streaming');
    var newState = !currentlyStreaming;

    fetch('/api/stream/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streaming: newState })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        updateStreamToggle(data.streaming);
        log('restream: ' + (data.streaming ? 'STARTED' : 'STOPPED'));
      })
      .catch(function(e) { showError('Restream toggle failed: ' + e); });
  };

  loadStreamControl();
  setInterval(loadStreamControl, 5000);

  // --- Quality Settings ---
  function loadQuality() {
    fetch('/api/quality')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.current && data.current.preset) {
          qualitySelect.value = data.current.preset;
          log('quality: current = ' + data.current.preset);
        }
      })
      .catch(function(e) { log('quality: error loading: ' + e); });
  }

  qualitySelect.onchange = function() {
    var preset = qualitySelect.value;
    fetch('/api/quality', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: preset })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success) {
          log('quality: changed to ' + preset + ' (' + data.settings.name + ')');
          log('quality: restart streamer to apply');
          alert('Quality changed to ' + data.settings.name + '. Restart streamer to apply.');
        }
      })
      .catch(function(e) { showError('Quality change failed: ' + e); });
  };

  loadQuality();

  // ============================
  // GENERIC MODAL
  // ============================
  var genericModal = document.getElementById('generic-modal');
  var genericModalSave = document.getElementById('generic-modal-save');
  var genericModalCallback = null;

  function openGenericModal(title, bodyHtml, onSave) {
    document.getElementById('generic-modal-title').textContent = title;
    document.getElementById('generic-modal-body').innerHTML = bodyHtml;
    genericModalCallback = onSave;
    genericModal.style.display = 'flex';
  }

  window.closeGenericModal = function() {
    genericModal.style.display = 'none';
    genericModalCallback = null;
  };

  genericModalSave.onclick = function() {
    if (genericModalCallback) genericModalCallback();
  };

  genericModal.onclick = function(e) {
    if (e.target === genericModal) closeGenericModal();
  };

})();
