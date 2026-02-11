(function () {
  'use strict';

  // --- DOM refs ---
  const video = document.getElementById('player');
  const modeTag = document.getElementById('mode-tag');
  const uptimeEl = document.getElementById('uptime');
  const qualitySelect = document.getElementById('quality-select');
  const errorBanner = document.getElementById('error-banner');
  const audioTrack = document.getElementById('audio-track');
  const videoTrack = document.getElementById('video-track');
  const trackBpm = document.getElementById('track-bpm');
  const statListeners = document.getElementById('stat-listeners');
  const statAudioBr = document.getElementById('stat-audio-br');
  const statFps = document.getElementById('stat-fps');
  const statSpeed = document.getElementById('stat-speed');
  const statVideoBr = document.getElementById('stat-video-br');
  const statTime = document.getElementById('stat-time');
  const musicList = document.getElementById('music-list');
  const musicCount = document.getElementById('music-count');
  const musicInput = document.getElementById('music-input');
  const musicStatus = document.getElementById('music-upload-status');
  const visualsList = document.getElementById('visuals-list');
  const visualsCount = document.getElementById('visuals-count');
  const visualsInput = document.getElementById('visuals-input');
  const visualsStatus = document.getElementById('visuals-upload-status');
  const logEl = document.getElementById('log');
  const dbgClear = document.getElementById('dbg-clear');
  const dbgPause = document.getElementById('dbg-pause');

  // --- State ---
  let bpmMap = {};
  let logsPaused = false;
  const logs = [];
  let startTime = Date.now();

  // --- Logging ---
  function log(msg) {
    const ts = new Date().toISOString().slice(11, 23);
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
    // Strip path, extension
    var name = filename.split('/').pop() || filename;
    name = name.replace(/\.[^.]+$/, '');
    // Replace underscores with spaces
    name = name.replace(/_/g, ' ');
    return name;
  }

  // --- HLS Player ---
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
      video.src = src;
      video.play().catch(function () {});
      return;
    }

    if (typeof Hls === 'undefined') {
      log('hls.js not loaded, falling back to native');
      video.src = src;
      video.play().catch(function () {});
      return;
    }

    if (!Hls.isSupported()) {
      log('MSE not supported');
      video.src = src;
      return;
    }

    log('mode=hls.js v' + (Hls.version || '?'));
    var hls = new Hls({
      lowLatencyMode: false,
      backBufferLength: 30,
      enableWorker: true,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10,
      liveDurationInfinity: true,
      maxBufferLength: 20,
      maxMaxBufferLength: 40
    });

    hls.on(Hls.Events.ERROR, function (_, data) {
      var msg = 'hls:error ' + data.type + '/' + data.details + ' fatal=' + data.fatal;
      log(msg);
      if (data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          log('hls: network error, retrying in 3s...');
          setTimeout(function () { hls.startLoad(); }, 3000);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          log('hls: media error, recovering...');
          hls.recoverMediaError();
        }
      }
    });

    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      log('hls: manifest parsed, starting playback');
      video.play().catch(function () {});
    });

    hls.on(Hls.Events.FRAG_LOADED, function (_, data) {
      var sn = data.frag ? data.frag.sn : '?';
      log('hls:frag sn=' + sn);
    });

    hls.loadSource(src);
    hls.attachMedia(video);
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

    // Find BPM
    var filename = (data.filename || '').split('/').pop();
    var bpm = bpmMap[filename];
    trackBpm.textContent = bpm ? Math.round(bpm) + ' BPM' : '';
  }

  function updateVideo(data) {
    if (!data) return;
    var name = data.title || cleanTrackName(data.filename) || '--';
    videoTrack.textContent = name;
  }

  function updateIcecast(data) {
    if (!data) return;
    statListeners.textContent = data.listeners || '0';
    statAudioBr.textContent = data.bitrate ? data.bitrate + ' kbps' : '--';
    if (data.serverStart) {
      startTime = new Date(data.serverStart).getTime() || Date.now();
    }
  }

  function updateFfmpeg(data) {
    if (!data) return;
    statFps.textContent = data.fps || '--';
    statSpeed.textContent = data.speed || '--';
    statVideoBr.textContent = data.bitrate || '--';
    statTime.textContent = data.time || '--';
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
      .then(function (files) { renderFileList(type, files); })
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

  // --- Reload file lists periodically ---
  setInterval(function () { loadFileList('music'); }, 30000);
  setInterval(function () { loadFileList('visuals'); }, 30000);

  // --- Stream Platforms Management ---
  const platformList = document.getElementById('platform-list');
  const addPlatformBtn = document.getElementById('add-platform-btn');
  const platformModal = document.getElementById('platform-modal');
  const platformNameInput = document.getElementById('platform-name-input');
  const streamKeyInput = document.getElementById('stream-key-input');
  const rtmpUrlInput = document.getElementById('rtmp-url-input');
  const rtmpHelp = document.getElementById('rtmp-help');
  const platformEnabled = document.getElementById('platform-enabled');

  function syncPlatformHints() {
    var name = (platformNameInput.value || '').trim().toLowerCase();
    if (name === 'kick') {
      rtmpUrlInput.placeholder = 'rtmps://<ingest>.global-contribute.live-video.net/app';
      if (rtmpHelp) {
        rtmpHelp.textContent = 'Kick: server URL from Creator Dashboard (обычно .../app), stream key отдельно.';
      }
      return;
    }

    rtmpUrlInput.placeholder = 'rtmp://... or rtmps://...';
    if (rtmpHelp) {
      rtmpHelp.textContent = 'Use server URL; stream key is stored separately.';
    }
  }

  function loadPlatforms() {
    fetch('/api/stream-keys')
      .then(function(r) { return r.json(); })
      .then(function(platforms) { renderPlatforms(platforms); })
      .catch(function(e) { log('platforms: error loading: ' + e); });
  }

  function renderPlatforms(platforms) {
    platformList.innerHTML = '';
    Object.entries(platforms).forEach(function([name, config]) {
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
        if (!data.success) {
          throw new Error(data.error || 'toggle failed');
        }
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

    if (!name) {
      alert('Please enter platform name');
      return;
    }
    if (!rtmpUrl) {
      alert('Please enter RTMP URL');
      return;
    }
    if (!key) {
      alert('Please enter stream key');
      return;
    }

    fetch('/api/stream-keys/' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, streamKey: key, rtmpUrl })
    })
      .then(function() {
        log('platform saved: ' + name);
        closePlatformModal();
        loadPlatforms();
      })
      .catch(function(e) { showError('Save failed: ' + e); });
  };

  // Close modal on outside click
  platformModal.onclick = function(e) {
    if (e.target === platformModal) closePlatformModal();
  };

  // Initial load
  loadPlatforms();
  setInterval(loadPlatforms, 30000);

  // --- Stream Control ---
  const streamToggleBtn = document.getElementById('stream-toggle-btn');
  
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
      streamToggleBtn.textContent = 'Stop Stream';
      streamToggleBtn.className = 'btn-toggle streaming';
    } else {
      streamToggleBtn.textContent = 'Start Stream';
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
        log('stream: ' + (data.streaming ? 'STARTED' : 'STOPPED'));
      })
      .catch(function(e) { showError('Stream toggle failed: ' + e); });
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

})();
