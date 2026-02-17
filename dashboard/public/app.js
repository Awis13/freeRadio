(function () {
  'use strict';

  // --- DOM refs ---
  var studioPlayer = document.getElementById('studio-player');
  var modeTag = document.getElementById('mode-tag');
  var uptimeEl = document.getElementById('uptime');
  var qualitySelect = document.getElementById('quality-select');
  var errorBanner = document.getElementById('error-banner');
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

  // --- Studio DOM refs ---
  var studioAudioTrack = document.getElementById('studio-audio-track');
  var studioBpm = document.getElementById('studio-bpm');
  var queueList = document.getElementById('queue-list');
  var skipBtn = document.getElementById('skip-btn');
  var clearQueueBtn = document.getElementById('clear-queue-btn');
  var trackSelector = document.getElementById('track-selector');
  var queueSearch = document.getElementById('queue-search');
  var queuePanelTitle = document.getElementById('queue-panel-title');
  var queueSelectorTitle = document.getElementById('queue-selector-title');

  // --- State ---
  var bpmMap = {};
  var logsPaused = false;
  var logs = [];
  var startTime = Date.now();
  var musicFiles = [];
  var visualFiles = [];
  var processedVisualFiles = [];
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
      if (tab === 'playlists') loadPlaylists();
      if (tab === 'schedule') { loadSchedule(); loadPlaylistsForSelect(); }
      if (tab === 'visuals') { loadVisualProfiles(); loadOverlays(); loadOverlayAssets(); }
      if (tab === 'analytics') loadAnalytics();
    });
  });

  // --- Collapsible panels ---
  document.querySelectorAll('.panel-toggle').forEach(function(head) {
    head.addEventListener('click', function(e) {
      if (e.target.closest('.dbg-actions')) return;
      var panel = head.closest('.panel-collapsible');
      panel.classList.toggle('collapsed');
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

  function timeAgo(ts) {
    var diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  // --- HLS Player (live-only, no scrubbing) ---
  var hlsInstance = null;
  var playerMuteBtn = document.getElementById('player-mute-btn');

  // --- Overlay state machine ---
  // showLoading(text, source, lockMs) — show overlay.
  //   lockMs: minimum display time. During lock, only 'manifest' and 'safety' can hide.
  //           timeupdate/canplay from old stream are blocked until lock expires.
  // hideLoading(source) — hide overlay (respects lock for auto-sources).
  var aliveTimer = null;    // 4s no-timeupdate → show "Loading stream..."
  var safetyTimer = null;   // 20s max overlay duration
  var hlsRetryTimer = null;
  var overlayLockedUntil = 0;  // timestamp — auto-hide blocked until this time
  var pendingModeSwitch = false;  // hard block: overlay stays until mode actually applies

  function showLoading(text, source, lockMs) {
    var overlay = document.getElementById('player-overlay');
    var overlayText = document.getElementById('player-overlay-text');
    if (text) overlayText.textContent = text;
    overlay.classList.add('visible');
    if (lockMs) overlayLockedUntil = Date.now() + lockMs;
    log('OVR SHOW "' + text + '" src=' + (source || '?') + (lockMs ? ' lock=' + lockMs + 'ms' : ''));
    // Safety net: never stuck > 20s
    if (safetyTimer) clearTimeout(safetyTimer);
    safetyTimer = setTimeout(function() {
      safetyTimer = null;
      log('OVR safety 20s expired');
      overlayLockedUntil = 0;
      hideLoading('safety');
    }, 20000);
  }

  function hideLoading(source) {
    // pendingModeSwitch: hard block — only mode-applied and safety can hide
    if (pendingModeSwitch && source !== 'mode-applied' && source !== 'safety') return;
    // Timestamp lock: block auto-sources (timeupdate, canplay) for brief overlays
    if ((source === 'timeupdate' || source === 'canplay') && Date.now() < overlayLockedUntil) return;
    var overlay = document.getElementById('player-overlay');
    var wasVisible = overlay.classList.contains('visible');
    overlay.classList.remove('visible');
    overlayLockedUntil = 0;
    if (wasVisible) log('OVR HIDE src=' + (source || '?'));
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
  }

  function clearAllTimers(source) {
    if (aliveTimer) { clearTimeout(aliveTimer); aliveTimer = null; }
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
    if (hlsRetryTimer) { clearTimeout(hlsRetryTimer); hlsRetryTimer = null; }
  }

  // timeupdate = video is receiving frames → stream alive → hide overlay (if not locked)
  studioPlayer.addEventListener('timeupdate', function() {
    if (noiseActive) return;
    if (aliveTimer) { clearTimeout(aliveTimer); aliveTimer = null; }
    hideLoading('timeupdate');
    aliveTimer = setTimeout(function() {
      aliveTimer = null;
      if (noiseActive) return;
      showLoading('Buffering...', 'alive-timeout');
    }, 4000);
  });

  studioPlayer.addEventListener('canplay', function() {
    hideLoading('canplay');
  });

  // No seeking handler needed — controls are disabled (pointer-events: none)
  // Previously had a snap-to-live handler here, but it fought with HLS.js
  // gap recovery (bufferSeekOverHole), creating an infinite loop every 100ms.

  // Mute/unmute
  playerMuteBtn.onclick = function() {
    studioPlayer.muted = !studioPlayer.muted;
    playerMuteBtn.innerHTML = studioPlayer.muted ? '&#128263;' : '&#128266;';
    playerMuteBtn.title = studioPlayer.muted ? 'Unmute' : 'Mute';
    if (!studioPlayer.muted) playerMuteBtn.classList.add('unmuted');
    else playerMuteBtn.classList.remove('unmuted');
  };

  // --- TV Static Noise Engine ---
  var noiseCanvas = document.getElementById('static-noise-canvas');
  var noiseCtx = noiseCanvas.getContext('2d');
  var scanlines = document.getElementById('crt-scanlines');
  var channelFlash = document.getElementById('channel-flash');
  var noiseActive = false;
  var noiseRafId = null;
  var NOISE_W = 480, NOISE_H = 270;

  noiseCanvas.width = NOISE_W;
  noiseCanvas.height = NOISE_H;

  function renderNoise() {
    var imageData = noiseCtx.createImageData(NOISE_W, NOISE_H);
    var data = new Uint32Array(imageData.data.buffer);
    for (var i = 0; i < data.length; i++) {
      var v = (Math.random() * 255) | 0;
      data[i] = (255 << 24) | (v << 16) | (v << 8) | v;
    }
    noiseCtx.putImageData(imageData, 0, 0);
    if (noiseActive) noiseRafId = requestAnimationFrame(renderNoise);
  }

  function startStaticNoise() {
    noiseActive = true;
    noiseCanvas.classList.add('active');
    scanlines.classList.add('active');
    renderNoise();
    log('NOISE started');
  }

  function stopStaticNoise() {
    noiseActive = false;
    if (noiseRafId) { cancelAnimationFrame(noiseRafId); noiseRafId = null; }
    noiseCanvas.classList.remove('active');
    scanlines.classList.remove('active');
    log('NOISE stopped');
  }

  function flashTransition() {
    channelFlash.style.display = 'block';
    channelFlash.style.opacity = '0.8';
    var start = performance.now();
    function fade(now) {
      var elapsed = now - start;
      if (elapsed >= 300) {
        channelFlash.style.display = 'none';
        return;
      }
      channelFlash.style.opacity = (0.8 * (1 - elapsed / 300)).toFixed(3);
      requestAnimationFrame(fade);
    }
    requestAnimationFrame(fade);
  }

  var hlsSrc = '/hls/stream.m3u8';
  var useNativeHls = false;

  function initPlayer() {
    log('PLR init src=' + hlsSrc);
    var ua = navigator.userAgent || '';
    var vendor = navigator.vendor || '';
    var isIOS = /iPad|iPhone|iPod/.test(ua);
    var isSafari = vendor === 'Apple Computer, Inc.' &&
      /Safari\//.test(ua) &&
      !/Chrome\/|Chromium\/|Edg\/|OPR\//.test(ua);

    if (isIOS || isSafari || typeof Hls === 'undefined' || !Hls.isSupported()) {
      log('PLR mode=native-hls');
      useNativeHls = true;
      studioPlayer.src = hlsSrc;
      studioPlayer.play().catch(function () {});
      return;
    }
    log('PLR mode=hls.js v' + (Hls.version || '?'));
    startHls('init');
  }

  function startHls(source) {
    log('HLS startHls src=' + (source || '?'));
    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }

    hlsInstance = new Hls({
      lowLatencyMode: false,
      backBufferLength: 0,
      enableWorker: true,
      liveSyncDurationCount: 1,
      liveMaxLatencyDurationCount: 2,
      liveDurationInfinity: true,
      maxBufferLength: 4,
      maxMaxBufferLength: 8
    });

    var errorCount = 0;
    var errorResetTimer = null;

    hlsInstance.on(Hls.Events.ERROR, function (_, data) {
      if (data.fatal) {
        log('HLS FATAL ' + data.details);
        showLoading('Reconnecting...', 'hls-fatal');
        hlsInstance.destroy();
        hlsInstance = null;
        if (hlsRetryTimer) clearTimeout(hlsRetryTimer);
        hlsRetryTimer = setTimeout(function() {
          hlsRetryTimer = null;
          startHls('retry');
        }, 1500);
        return;
      }
      // Non-fatal errors: if too many in a short window, force restart
      errorCount++;
      if (!errorResetTimer) {
        errorResetTimer = setTimeout(function() {
          errorResetTimer = null;
          if (errorCount > 15) {
            log('HLS too many errors (' + errorCount + '), restarting');
            restartPlayer('error-flood');
          }
          errorCount = 0;
        }, 3000);
      }
    });

    hlsInstance.on(Hls.Events.MANIFEST_PARSED, function () {
      log('HLS MANIFEST_PARSED → play()');
      hideLoading('manifest');
      studioPlayer.play().catch(function (e) {
        log('HLS play() rejected: ' + e + ', retry in 1s');
        setTimeout(function() { studioPlayer.play().catch(function() {}); }, 1000);
      });
    });

    hlsInstance.loadSource(hlsSrc);
    hlsInstance.attachMedia(studioPlayer);
  }

  // restartPlayer: clean restart — clears ALL timers, shows overlay during reconnect
  function restartPlayer(source) {
    log('PLR restart src=' + (source || '?'));
    clearAllTimers('restart-' + (source || '?'));
    // Show overlay during reconnection — locked so stale timeupdate can't hide it.
    // 'manifest' source (MANIFEST_PARSED) always bypasses the lock.
    showLoading('Loading stream...', 'restart', 3000);
    if (useNativeHls) {
      studioPlayer.src = hlsSrc;
      studioPlayer.play().catch(function () {});
    } else {
      startHls('restart-' + (source || '?'));
    }
  }

  initPlayer();

  // Load file lists immediately
  loadFileList('music');
  loadFileList('visuals');

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
        updateIcecast(msg.data.icecast);
        updateFfmpeg(msg.data.ffmpeg);
        bpmMap = msg.data.bpm || {};
        if (msg.data.rtmpHealth) updateRestreamStatus(msg.data.rtmpHealth);
        loadFileList('music');
        loadFileList('visuals');
        break;
      case 'audio':
        updateAudio(msg.data);
        break;
      case 'video':
        if (pendingModeSwitch) {
          // New clip started in feed_fifo, but HLS player still has ~2s of buffered
          // old content (hls_time=1 × liveSyncDurationCount=1 + segment pipeline).
          // Wait for buffer to flush before hiding overlay.
          log('MODE new clip detected: ' + (msg.data && msg.data.filename || '?') + ', waiting for HLS buffer...');
          setTimeout(function() {
            pendingModeSwitch = false;
            hideLoading('mode-applied');
            log('MODE switch applied');
          }, 2500);
        }
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
      case 'rtmp-health':
        updateRestreamStatus(msg.data);
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
    studioAudioTrack.textContent = name;

    var filename = (data.filename || '').split('/').pop();
    var bpm = bpmMap[filename];
    studioBpm.textContent = bpm ? Math.round(bpm) + ' BPM' : '';
  }

  function updateIcecast(data) {
    if (!data) return;
    statListeners.textContent = data.listeners || '0';
    statAudioBr.textContent = data.bitrate ? data.bitrate + ' kbps' : '--';
    if (data.serverStart) {
      startTime = new Date(data.serverStart).getTime() || Date.now();
    }
    var count = parseInt(data.listeners) || 0;
    listenerHistory.push({ ts: Date.now(), count: count });
    if (listenerHistory.length > 720) listenerHistory.shift();
    if (count > peakListeners) peakListeners = count;
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
          setTimeout(loadTrackHistory, 2000);
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

  // --- Video Queue Control ---
  function loadVideoQueue() {
    fetch('/api/video-queue')
      .then(function(r) { return r.json(); })
      .then(function(items) { renderQueue(items); })
      .catch(function() { renderQueue([]); });
  }

  function addToVideoQueue(filename) {
    fetch('/api/video-queue/push', {
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
    fetch('/api/video-queue/skip', { method: 'POST' })
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
    fetch('/api/video-queue/clear', { method: 'POST' })
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
    if (broadcastState.visualMode === 'video-playlist') loadVideoQueue();
    else loadQueue();
  }

  // --- Track Selector ---
  function renderTrackSelector(filter) {
    trackSelector.innerHTML = '';
    var isVideoMode = broadcastState.visualMode === 'video-playlist';
    var sourceFiles = isVideoMode ? processedVisualFiles : musicFiles;
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
        var bpm = bpmMap[f.name];
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

  queueSearch.oninput = function() {
    renderTrackSelector(queueSearch.value);
  };

  loadQueue();
  setInterval(loadActiveQueue, 5000);

  // ============================
  // TRACK HISTORY (Studio sidebar)
  // ============================
  function loadTrackHistory() {
    fetch('/api/history?limit=10')
      .then(function(r) { return r.json(); })
      .then(function(entries) { renderTrackHistory(entries); })
      .catch(function() {});
  }

  function renderTrackHistory(entries) {
    var container = document.getElementById('track-history-list');
    container.innerHTML = '';

    if (!entries || entries.length === 0) {
      container.innerHTML = '<div class="empty-state">No history yet</div>';
      return;
    }

    // Show most recent first
    var reversed = entries.slice().reverse();
    reversed.forEach(function(entry, idx) {
      var div = document.createElement('div');
      div.className = 'track-history-item';

      var name = cleanTrackName(entry.track);
      var nameEl = document.createElement('span');
      nameEl.className = 'track-history-name';
      nameEl.textContent = name;
      nameEl.title = name;
      div.appendChild(nameEl);

      if (idx === 0) {
        var nowBadge = document.createElement('span');
        nowBadge.className = 'now-badge';
        nowBadge.textContent = 'NOW';
        div.appendChild(nowBadge);
      } else {
        var timeEl = document.createElement('span');
        timeEl.className = 'track-history-time';
        timeEl.textContent = timeAgo(entry.ts);
        div.appendChild(timeEl);
      }

      if (entry.bpm) {
        var bpmEl = document.createElement('span');
        bpmEl.className = 'track-history-bpm';
        bpmEl.textContent = Math.round(entry.bpm);
        div.appendChild(bpmEl);
      }

      container.appendChild(div);
    });
  }

  loadTrackHistory();
  setInterval(loadTrackHistory, 15000);

  // ============================
  // RESTREAM STATUS WIDGET
  // ============================
  var lastRtmpHealth = null;

  function updateRestreamStatus(healthData) {
    lastRtmpHealth = healthData;
    var container = document.getElementById('restream-status-list');
    container.innerHTML = '';

    var outputs = (healthData && healthData.outputs) ? healthData.outputs : {};
    var keys = Object.keys(outputs);

    if (keys.length === 0) {
      loadRestreamStatusFallback();
      return;
    }

    keys.forEach(function(name) {
      var info = outputs[name];
      var status = info.status || 'offline';
      var div = document.createElement('div');
      div.className = 'restream-status-item';

      var dotClass = 'restream-status-dot';
      var statusText = 'OFF';
      if (status === 'live') {
        dotClass += ' live';
        statusText = 'LIVE';
      } else if (status === 'error') {
        dotClass += ' error';
        statusText = 'ERROR';
      } else {
        dotClass += ' off';
        statusText = 'OFF';
      }

      var dot = document.createElement('span');
      dot.className = dotClass;
      div.appendChild(dot);

      var nameEl = document.createElement('span');
      nameEl.textContent = name;
      div.appendChild(nameEl);

      var statusEl = document.createElement('span');
      statusEl.className = 'restream-status-text ' + status;
      statusEl.textContent = statusText;
      div.appendChild(statusEl);

      if (status === 'error' && info.error) {
        div.title = info.error;
      }

      container.appendChild(div);
    });
  }

  function loadRestreamStatusFallback() {
    fetch('/api/stream-keys')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var platforms = data.platforms || data;
        var container = document.getElementById('restream-status-list');
        container.innerHTML = '';
        Object.entries(platforms).forEach(function(entry) {
          var name = entry[0];
          var config = entry[1];
          var div = document.createElement('div');
          div.className = 'restream-status-item';
          div.innerHTML =
            '<span class="restream-status-dot ' + (config.enabled ? 'on' : 'off') + '"></span>' +
            '<span>' + name + '</span>' +
            '<span class="restream-status-text off">' + (config.enabled ? 'READY' : 'OFF') + '</span>';
          container.appendChild(div);
        });
        if (Object.keys(platforms).length === 0) {
          container.innerHTML = '<div class="empty-state">No platforms</div>';
        }
      })
      .catch(function() {});
  }

  loadRestreamStatusFallback();

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

    var headerRow = document.createElement('div');
    headerRow.className = 'sched-header-row';
    headerRow.innerHTML = '<div class="sched-time-col"></div>';
    DAYS.forEach(function(d) {
      headerRow.innerHTML += '<div class="sched-day-col">' + d + '</div>';
    });
    grid.appendChild(headerRow);

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

        var slots = Object.values(scheduleData.weekly || {}).filter(function(s) {
          if (s.day !== d) return false;
          var startH = parseInt(s.startTime.split(':')[0]);
          var endH = parseInt(s.endTime.split(':')[0]);
          if (endH <= startH) endH += 24;
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

    document.getElementById('vp-activate-btn').onclick = function() {
      fetch('/api/visual-profiles/' + profile.id + '/activate', { method: 'POST' })
        .then(function() {
          log('visual: activated ' + profile.name);
          loadVisualProfiles();
        })
        .catch(function(e) { showError('Activate failed: ' + e); });
    };

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

      if (layer.type === 'now_playing' || layer.type === 'scrolling_now_playing' || layer.type === 'static_text' || layer.type === 'clock' || layer.type === 'scrolling_text') {
        var isScrolling = layer.type === 'scrolling_text' || layer.type === 'scrolling_now_playing';
        body.innerHTML =
          '<div class="overlay-props">' +
          (layer.type === 'static_text' || layer.type === 'scrolling_text' ? '<div class="form-group"><label>Text</label><input type="text" value="' + (layer.text || '') + '" onchange="updateOverlayLayer(' + idx + ', \'text\', this.value)"></div>' : '') +
          (layer.type === 'scrolling_now_playing' ? '<div class="form-group"><label>Source</label><span class="text-secondary">Current track (auto)</span></div>' : '') +
          (isScrolling ? '<div class="form-group"><label>Speed (px/sec)</label><input type="number" value="' + (layer.speed || 100) + '" onchange="updateOverlayLayer(' + idx + ', \'speed\', parseInt(this.value))"></div>' : '') +
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
          layer.text = 'SYSTEM 23';
          layer.fontsize = 18;
          layer.fontcolor = 'white';
        } else if (type === 'scrolling_text') {
          layer.text = 'SYSTEM 23 RADIO - HARD TECHNO 24/7';
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
        drawTopTracksChart(data.topTracks || []);
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

      ctx.fillStyle = '#243244';
      ctx.fillRect(labelW, y, w - labelW - 60, barH);
      ctx.fillStyle = '#c4ffcb';
      ctx.fillRect(labelW, y, barW, barH);

      ctx.fillStyle = '#d7e1ea';
      ctx.font = '11px monospace';
      var name = t.track.length > 28 ? t.track.substr(0, 28) + '...' : t.track;
      ctx.fillText(name, 4, y + 15);

      ctx.fillStyle = '#9fb6cc';
      ctx.fillText(t.count + 'x', w - 50, y + 15);
    });
  }

  // ============================
  // STREAM PLATFORMS (Studio sidebar)
  // ============================
  var PLATFORM_PRESETS = {
    youtube:  { name: 'YouTube',  rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2' },
    kick:     { name: 'Kick',     rtmpUrl: '' },
    twitch:   { name: 'Twitch',   rtmpUrl: 'rtmp://live.twitch.tv/app' },
    facebook: { name: 'Facebook', rtmpUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/' },
    custom:   { name: '',         rtmpUrl: '' }
  };

  var platformList = document.getElementById('platform-list');
  var addPlatformBtn = document.getElementById('add-platform-btn');
  var platformModal = document.getElementById('platform-modal');
  var platformNameInput = document.getElementById('platform-name-input');
  var streamKeyInput = document.getElementById('stream-key-input');
  var rtmpUrlInput = document.getElementById('rtmp-url-input');
  var rtmpHelp = document.getElementById('rtmp-help');
  var platformEnabled = document.getElementById('platform-enabled');
  var presetGroup = document.getElementById('preset-group');
  var presetSelect = document.getElementById('platform-preset-select');
  var restreamAutoStartCheckbox = document.getElementById('restream-autostart-checkbox');

  function uniquePlatformName(base) {
    if (currentPlatformNames.indexOf(base) === -1) return base;
    for (var i = 2; i <= 99; i++) {
      var candidate = base + ' ' + i;
      if (currentPlatformNames.indexOf(candidate) === -1) return candidate;
    }
    return base + ' ' + Date.now();
  }

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

  presetSelect.onchange = function() { applyPreset(presetSelect.value); };

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

  var maxPlatforms = 3;
  var currentPlatformNames = [];

  function loadPlatforms() {
    fetch('/api/stream-keys')
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
      delBtn.textContent = '\u00d7';
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
    streamKeyInput.value = '';
    platformEnabled.checked = true;
    presetGroup.style.display = '';
    presetSelect.value = 'youtube';
    applyPreset('youtube');
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
      .then(function(r) {
        if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || 'save failed'); });
        log('platform saved: ' + name);
        closePlatformModal();
        loadPlatforms();
      })
      .catch(function(e) { showError('Save failed: ' + e.message); });
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

  // --- Broadcast Control (OFF → PREVIEW → LIVE) ---
  var broadcastModeTag = document.getElementById('broadcast-mode-tag');
  var btnGoLive = document.getElementById('btn-golive');
  var btnPlay = document.getElementById('btn-play');
  var btnStop = document.getElementById('btn-stop');
  var standbyVisualSelect = document.getElementById('standby-visual-select');
  var standbyVisualWrapper = document.getElementById('standby-visual-wrapper');
  var playerOverlay = document.getElementById('player-overlay');
  var playerOverlayText = document.getElementById('player-overlay-text');
  var modeHint = document.getElementById('transport-mode-hint');
  var modePills = document.querySelectorAll('.bmode-pill');

  // State: streaming=ffmpeg running (HLS alive), broadcast=sending to RTMP, streamMode=live|standby
  var broadcastState = { streaming: false, broadcast: false, streamMode: 'standby', standbyVisual: null, visualMode: 'visual-radio' };
  // Derived state: STANDBY (standby mode), PREVIEW (live, no broadcast), LIVE (live + broadcast)
  function getBroadcastPhase() {
    if (broadcastState.streamMode === 'standby') return 'standby';
    if (!broadcastState.broadcast) return 'preview';
    return 'live';
  }

  var MODE_HINTS = {
    standby: {
      'radio': 'Standby. Press PLAY to start.',
      'visual-radio': 'Standby. Press PLAY to start.',
      'video-playlist': 'Standby. Press PLAY to start.'
    },
    preview: {
      'radio': 'Preview: DJ music + one looping video. Press GO LIVE to broadcast.',
      'visual-radio': 'Preview: DJ music + shuffled videos. Press GO LIVE to broadcast.',
      'video-playlist': 'Preview: videos with own audio, no DJ. Press GO LIVE to broadcast.'
    },
    live: {
      'radio': 'Broadcasting: DJ music + one looping video.',
      'visual-radio': 'Broadcasting: DJ music + shuffled videos.',
      'video-playlist': 'Broadcasting: videos with own audio, no DJ.'
    }
  };

  function updateBroadcastUI() {
    var phase = getBroadcastPhase();
    var s = broadcastState;
    var isBroadcasting = s.broadcast;

    if (phase === 'standby') {
      broadcastModeTag.textContent = isBroadcasting ? 'STANDBY' : 'OFF';
      broadcastModeTag.className = 'mode-tag ' + (isBroadcasting ? 'standby' : 'off');
      btnPlay.disabled = false;
      btnGoLive.textContent = isBroadcasting ? 'END LIVE' : 'GO LIVE';
      btnGoLive.disabled = !isBroadcasting;
      btnStop.disabled = true;
    } else if (phase === 'preview') {
      broadcastModeTag.textContent = 'PREVIEW';
      broadcastModeTag.className = 'mode-tag preview';
      btnPlay.disabled = true;
      btnGoLive.textContent = 'GO LIVE';
      btnGoLive.disabled = false;
      btnStop.disabled = false;
    } else {
      broadcastModeTag.textContent = 'LIVE';
      broadcastModeTag.className = 'mode-tag live';
      btnPlay.disabled = true;
      btnGoLive.textContent = 'END LIVE';
      btnGoLive.disabled = false;
      btnStop.disabled = false;
    }

    // Update pill buttons
    modePills.forEach(function(pill) {
      pill.classList.toggle('active', pill.dataset.vmode === s.visualMode);
    });

    // Show video picker in Radio mode (to pick the looping video) or when OFF
    var showVisualPicker = s.visualMode === 'radio';
    standbyVisualWrapper.style.display = showVisualPicker ? '' : 'none';

    // Mode-aware queue: rebind skip/clear, update titles
    var isVideoMode = s.visualMode === 'video-playlist';
    queuePanelTitle.textContent = isVideoMode ? 'Video Queue' : 'Queue';
    queueSelectorTitle.textContent = isVideoMode ? 'Add Video' : 'Add to Queue';
    queueSearch.placeholder = isVideoMode ? 'Search videos...' : 'Search tracks...';
    skipBtn.style.opacity = '';
    skipBtn.onclick = isVideoMode ? skipVideo : function() {
      fetch('/api/queue/skip', { method: 'POST' })
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
    clearQueueBtn.onclick = isVideoMode ? clearVideoQueue : function() {
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

    if (standbyVisualSelect.value !== (s.standbyVisual || '')) {
      standbyVisualSelect.value = s.standbyVisual || '';
    }

    // Mode hint
    var hints = MODE_HINTS[phase] || {};
    modeHint.textContent = hints[s.visualMode] || '';
  }

  // Pill button clicks — seamless mode switch (no player restart needed)
  modePills.forEach(function(pill) {
    pill.addEventListener('click', function() {
      var newMode = pill.dataset.vmode;
      var oldMode = broadcastState.visualMode;
      if (newMode === oldMode) return;
      broadcastState.visualMode = newMode;

      log('MODE pill ' + oldMode + ' → ' + newMode);

      // Show overlay until mode actually applies (next clip boundary via WS 'video' event).
      // Safety timer (20s) in showLoading prevents permanent stuck overlay.
      // Only show when in live mode (not standby — static noise doesn't need transition overlay)
      if (broadcastState.streamMode === 'live') {
        pendingModeSwitch = true;
        var modeName = pill.querySelector('.bmode-pill-label').textContent;
        showLoading('Switching to ' + modeName + '...', 'pill', 30000);
      }

      fetch('/api/visual-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode })
      })
        .then(function() {
          updateBroadcastUI();
          loadActiveQueue();
          renderTrackSelector(queueSearch.value);
        })
        .catch(function(e) {
          showError('Mode change failed: ' + e);
        });
    });
  });

  // PLAY: STANDBY → PREVIEW/LIVE (flash + wait for HLS content)
  btnPlay.onclick = function() {
    btnPlay.disabled = true;
    flashTransition();
    log('MODE PLAY clicked');
    fetch('/api/stream/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'live', standbyVisual: standbyVisualSelect.value || null })
    })
      .then(function() {
        broadcastState.streamMode = 'live';
        updateBroadcastUI();
        setTimeout(function() {
          stopStaticNoise();
          flashTransition();
          studioPlayer.muted = !playerMuteBtn.classList.contains('unmuted');
        }, 2000);
        log('MODE PLAY → ' + getBroadcastPhase().toUpperCase());
      })
      .catch(function(e) { showError('Play failed: ' + e); btnPlay.disabled = false; });
  };

  // GO LIVE / END LIVE: toggle RTMP broadcast (triggers ffmpeg restart to add/remove RTMP outputs)
  btnGoLive.onclick = function() {
    var newBroadcast = !broadcastState.broadcast;
    btnGoLive.disabled = true;
    showLoading(newBroadcast ? 'Going live...' : 'Ending broadcast...', 'go-live', 4000);
    fetch('/api/stream/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streaming: true, broadcast: newBroadcast })
    })
      .then(function(r) { return r.json(); })
      .then(function() {
        broadcastState.broadcast = newBroadcast;
        updateBroadcastUI();
        log('MODE ' + (newBroadcast ? 'GO LIVE → LIVE' : 'END LIVE → RTMP removed') + ', restart in 3s');
        setTimeout(function() { restartPlayer(newBroadcast ? 'go-live' : 'end-live'); }, 3000);
      })
      .catch(function(e) {
        showError((newBroadcast ? 'Go live' : 'End live') + ' failed: ' + e);
        btnGoLive.disabled = false;
      });
  };

  // STOP: PREVIEW/LIVE → STANDBY (instant noise overlay masks HLS latency)
  btnStop.onclick = function() {
    btnStop.disabled = true;
    startStaticNoise();
    flashTransition();
    studioPlayer.muted = true;
    log('MODE STOP clicked (broadcast=' + broadcastState.broadcast + ')');

    // Only set mode to standby — broadcast stays untouched, RTMP keeps streaming static
    fetch('/api/stream/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'standby' })
    })
      .then(function() {
        broadcastState.streamMode = 'standby';
        updateBroadcastUI();
        log('MODE STOP → STANDBY');
      })
      .catch(function(e) {
        showError('Stop failed: ' + e);
        stopStaticNoise();
        btnStop.disabled = false;
      });
  };

  // Radio visual selection change
  standbyVisualSelect.onchange = function() {
    var visual = standbyVisualSelect.value || null;
    broadcastState.standbyVisual = visual;
    // Write to stream mode (standby visual)
    fetch('/api/stream/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ standbyVisual: visual })
    }).catch(function(e) { showError('Set visual failed: ' + e); });
    // Also write to visual mode (radio visual) if in radio mode
    if (broadcastState.visualMode === 'radio') {
      fetch('/api/visual-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ radioVisual: visual })
      }).catch(function() {});
    }
    log('broadcast: visual → ' + (visual || 'default'));
  };

  // Load processed visuals for dropdown
  function loadProcessedVisuals() {
    fetch('/api/visuals-processed')
      .then(function(r) { return r.json(); })
      .then(function(files) {
        processedVisualFiles = files;
        var current = standbyVisualSelect.value;
        standbyVisualSelect.innerHTML = '<option value="">-- select video --</option>';
        files.forEach(function(f) {
          var opt = document.createElement('option');
          opt.value = f.name;
          opt.textContent = f.name;
          standbyVisualSelect.appendChild(opt);
        });
        standbyVisualSelect.value = current || broadcastState.standbyVisual || '';
      })
      .catch(function(e) { log('visuals-processed: error: ' + e); });
  }

  // Poll broadcast state + visual mode
  function loadBroadcastState() {
    Promise.all([
      fetch('/api/stream/control').then(function(r) { return r.json(); }),
      fetch('/api/stream/mode').then(function(r) { return r.json(); }),
      fetch('/api/visual-mode').then(function(r) { return r.json(); })
    ])
      .then(function(results) {
        broadcastState.streaming = results[0].streaming;
        broadcastState.broadcast = !!results[0].broadcast;
        broadcastState.streamMode = results[1].mode || 'standby';
        broadcastState.standbyVisual = results[1].standbyVisual;
        broadcastState.visualMode = results[2].mode || 'visual-radio';
        updateBroadcastUI();
        if (broadcastState.streamMode === 'standby' && !noiseActive) {
          startStaticNoise();
          studioPlayer.muted = true;
        } else if (broadcastState.streamMode === 'live' && noiseActive) {
          stopStaticNoise();
          studioPlayer.muted = !playerMuteBtn.classList.contains('unmuted');
        }
      })
      .catch(function(e) { log('broadcast state: error: ' + e); });
  }

  loadProcessedVisuals();
  loadBroadcastState();
  setInterval(loadBroadcastState, 5000);
  setInterval(loadProcessedVisuals, 30000);

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
        }
      })
      .catch(function(e) { showError('Quality change failed: ' + e); });
  };

  loadQuality();

  // --- Audio Enhancement Settings ---
  var audioEnhanceCheck = document.getElementById('audio-enhance');

  function loadAudioSettings() {
    fetch('/api/audio')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (audioEnhanceCheck) {
          audioEnhanceCheck.checked = data.enhanced === true;
          log('audio: enhancement = ' + (data.enhanced ? 'ON' : 'OFF'));
        }
      })
      .catch(function(e) { log('audio: error loading settings: ' + e); });
  }

  if (audioEnhanceCheck) {
    audioEnhanceCheck.onchange = function() {
      var enabled = audioEnhanceCheck.checked;
      fetch('/api/audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enhanced: enabled })
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success) {
            log('audio: enhancement ' + (enabled ? 'ENABLED' : 'DISABLED'));
          }
        })
        .catch(function(e) { showError('Audio settings change failed: ' + e); });
    };
  }

  loadAudioSettings();

  // --- Video Enhancement Settings ---
  var videoEnhanceCheck = document.getElementById('video-enhance');

  function loadVideoSettings() {
    fetch('/api/video')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (videoEnhanceCheck) {
          videoEnhanceCheck.checked = data.enhanced === true;
          log('video: enhancement = ' + (data.enhanced ? 'ON' : 'OFF'));
        }
      })
      .catch(function(e) { log('video: error loading settings: ' + e); });
  }

  if (videoEnhanceCheck) {
    videoEnhanceCheck.onchange = function() {
      var enabled = videoEnhanceCheck.checked;
      fetch('/api/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enhanced: enabled })
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success) {
            log('video: enhancement ' + (enabled ? 'ENABLED' : 'DISABLED'));
          }
        })
        .catch(function(e) { showError('Video settings change failed: ' + e); });
    };
  }

  loadVideoSettings();

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
