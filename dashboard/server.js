const fs = require('fs');
const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { createIcecastPoller } = require('./lib/icecast');
const { createTrackPoller } = require('./lib/track');
const { createVideoPoller } = require('./lib/video');
const { createFfmpegPoller } = require('./lib/ffmpeg');
const { createBpmMapPoller } = require('./lib/bpmMap');
const { createRtmpHealthPoller } = require('./lib/rtmpHealth');
const fileManager = require('./lib/fileManager');
const streamKeys = require('./lib/streamKeys');
const quality = require('./lib/quality');
const audioSettings = require('./lib/audioSettings');
const videoSettings = require('./lib/videoSettings');
const streamControl = require('./lib/streamControl');
const restreamSettings = require('./lib/restreamSettings');
const visualMode = require('./lib/visualMode');
const liveMode = require('./lib/liveMode');
const videoQueue = require('./lib/videoQueue');
const createQueueRouter = require('./lib/queue');
const { createPlaylistRouter } = require('./lib/playlist');
const { createTrackRouter } = require('./lib/trackMeta');
const { createVisualProfileRouter } = require('./lib/visualProfile');
const { createOverlayRouter } = require('./lib/overlay');
const { createVideoPlaylistRouter } = require('./lib/videoPlaylist');
const { createScheduleRouter, startExecutor, onTrackChange } = require('./lib/schedule');
const { createHistoryRouter } = require('./lib/history');
const createVoiceRouter = require('./lib/voice');
const createMixingRouter = require('./lib/mixing');
const liqClient = require('./lib/liqClient');
const channelStrip = require("./lib/channelStrip");
const s3 = require('./lib/s3');
const cacheManager = require('./lib/cacheManager');
const syncWatcher = require('./lib/syncWatcher');
// const { FftAnalyzer } = require("./lib/fftAnalyzer"); // DISABLED: WebKit bug 180696

const PORT = process.env.PORT || 9090;
const HLS_DIR = process.env.HLS_DIR || '/hls';
const MUSIC_DIR = process.env.MUSIC_DIR || '/music';
const VISUALS_DIR = process.env.VISUALS_DIR || '/visuals';
const FFMPEG_PROGRESS_FILE = process.env.FFMPEG_PROGRESS_FILE || '';
const OUTPUT_MODE = process.env.OUTPUT_MODE || 'hls';
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';
const S3_CACHE_MAX_MB = parseInt(process.env.S3_CACHE_MAX_MB) || 4000; // 4 GB default

// --- Auth: WebSocket token verification ---
function verifyWsClient(info) {
  if (!DASHBOARD_TOKEN) return true;
  const url = new URL(info.req.url, 'http://localhost');
  return url.searchParams.get('token') === DASHBOARD_TOKEN;
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, verifyClient: verifyWsClient });

// --- State ---
const state = {
  outputMode: OUTPUT_MODE,
  audio: { title: '', filename: '' },
  video: { title: '', filename: '' },
  track: { title: '', filename: '' },  // for compatibility
  icecast: { listeners: 0, bitrate: 0, serverStart: '' },
  ffmpeg: { fps: '', speed: '', bitrate: '', frame: '', time: '' },
  bpm: {},
  rtmpHealth: {}
};

// Boot abort flag: set by /api/dj/stop to cancel auto-restore during startup
let bootAborted = false;

// BPM getter for playlist/track modules
function getBpmMap() {
  return state.bpm;
}

// --- Pollers ---
const icecastPoller = createIcecastPoller((data) => {
  state.icecast = data;
  broadcast('icecast', data);
  if (data.title && !state.track.title) {
    state.track = { title: data.title, filename: '' };
    broadcast('track', state.track);
  }
});

const trackPoller = createTrackPoller((data) => {
  // Log track change to history
  if (data.filename && data.filename !== state.audio.filename) {
    onTrackChange(data.filename);
  }
  state.audio = data;
  broadcast('audio', data);
});

const videoPoller = createVideoPoller((data) => {
  state.video = data;
  broadcast('video', data);
});

const ffmpegPoller = createFfmpegPoller(FFMPEG_PROGRESS_FILE, (data) => {
  state.ffmpeg = data;
  broadcast('ffmpeg', data);
});

const bpmPoller = createBpmMapPoller(path.join(MUSIC_DIR, '.bpm_map'), (data) => {
  state.bpm = data;
  broadcast('bpm', data);
});

const rtmpHealthPoller = createRtmpHealthPoller((data) => {
  state.rtmpHealth = data;
  broadcast('rtmp-health', data);
});

// --- Server-side FFT analyzer (Safari equalizer sync) ---
// const fftAnalyzer = new FftAnalyzer(); // DISABLED
// fftAnalyzer.start();

// --- WebSocket ---
let broadcast = function(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
};

wss.on('connection', (ws) => {
  const initState = {
    ...state,
    track: state.audio,
    rtmpHealth: state.rtmpHealth,
    liveMode: liveMode.getLiveMode(),
    streamControl: streamControl.getControlState(),
    streamMode: streamControl.getModeState(),
    visualMode: visualMode.getVisualMode()
  };
  ws.send(JSON.stringify({ type: 'init', data: initState }));

  // Handle client messages (FFT subscribe, etc.)
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      // if (msg.type === 'fft-subscribe') fftAnalyzer.subscribe(ws);
      // else if (msg.type === 'fft-unsubscribe') fftAnalyzer.unsubscribe(ws);
    } catch(e) {}
  });
  // ws.on('close', () => { fftAnalyzer.unsubscribe(ws); });
});

// --- CSP header ---
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; font-src 'self'");
  next();
});

// --- Static files (no-cache for JS to avoid stale code after deploys) ---
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.html') || filePath.endsWith('.css')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
    }
  }
}));

// hls.js
app.get('/js/hls.min.js', (req, res) => {
  res.sendFile('/app/hls.min.js');
});

// --- Audio stream proxy (for Web Audio API analyzer in Safari) ---
// Safari's decodeAudioData can't handle raw AAC ADTS, so ffmpeg transcodes to MP3.
app.get('/api/audio-stream', (req, res) => {
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'http://icecast:8000/live',
    '-f', 'mp3', '-codec:a', 'libmp3lame', '-b:a', '128k',
    'pipe:1'
  ]);
  res.set('Content-Type', 'audio/mpeg');
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-cache, no-store');
  ff.stdout.pipe(res);
  ff.stderr.on('data', (d) => console.error('[audio-proxy]', d.toString().trim()));
  res.on('close', () => ff.kill('SIGKILL'));
  ff.on('error', () => res.status(502).end());
});

// --- HLS segments ---
app.use('/hls', express.static(HLS_DIR, {
  setHeaders(res) {
    res.set('Cache-Control', 'no-cache, no-store');
    res.set('Access-Control-Allow-Origin', '*');
  }
}));

// --- Body parser (before API routes) ---
app.use(express.json());

// --- Auth middleware ---
const PUBLIC_PATHS = [
  '/api/status',
  '/api/audio-stream',
  '/api/rtmp-urls',
  '/api/rtmp-health',
  '/api/live/on_publish',
  '/api/live/on_done',
  '/api/auth/verify'
];

app.use('/api/', (req, res, next) => {
  if (!DASHBOARD_TOKEN) return next();
  const fullPath = req.baseUrl + req.path;
  if (PUBLIC_PATHS.some(p => fullPath === p || fullPath.startsWith(p + '/'))) return next();
  const auth = req.headers.authorization;
  if (auth === 'Bearer ' + DASHBOARD_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

// --- Auth verify endpoint ---
app.post('/api/auth/verify', (req, res) => {
  if (!DASHBOARD_TOKEN) return res.json({ ok: true });
  const { token } = req.body || {};
  if (token === DASHBOARD_TOKEN) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// --- REST API: status ---
app.get('/api/status', (req, res) => {
  // Full state included in status for batch-polling (1 request instead of 4)
  res.json({
    ...state,
    streamControl: streamControl.getControlState(),
    streamMode: streamControl.getModeState(),
    visualMode: visualMode.getVisualMode(),
    liveMode: liveMode.getLiveMode()
  });
});

// --- REST API: file management ---
app.use('/api/music', fileManager(MUSIC_DIR));
app.use('/api/visuals', fileManager(path.join(VISUALS_DIR, 'incoming')));

// --- REST API: queue control ---
app.use('/api/queue', createQueueRouter(MUSIC_DIR, getBpmMap));

// --- REST API: video queue ---
app.get('/api/video-queue', (req, res) => {
  res.json(videoQueue.getQueue());
});
app.post('/api/video-queue/push', express.text({ type: '*/*' }), (req, res) => {
  const filename = (typeof req.body === 'string' ? req.body : '').trim();
  if (!filename) return res.status(400).json({ error: 'no filename' });
  videoQueue.push(filename);
  res.json({ ok: true });
});
app.post('/api/video-queue/skip', (req, res) => {
  videoQueue.skip();
  res.json({ ok: true });
});
app.post('/api/video-queue/clear', (req, res) => {
  videoQueue.clear();
  res.json({ ok: true });
});

// --- REST API: playlists ---
app.use('/api/playlists', createPlaylistRouter(MUSIC_DIR, getBpmMap));

// --- REST API: track metadata ---
app.use('/api/tracks', createTrackRouter(MUSIC_DIR, getBpmMap));

// --- REST API: schedule ---
app.use('/api/schedule', createScheduleRouter());

// --- REST API: history ---
app.use('/api/history', createHistoryRouter());

// --- REST API: visual profiles ---
app.use('/api/visual-profiles', createVisualProfileRouter(VISUALS_DIR));
app.use('/api/video-playlists', createVideoPlaylistRouter(VISUALS_DIR));

// --- REST API: overlays ---
app.use('/api/overlays', createOverlayRouter());

// --- REST API: voice (push-to-talk) ---
app.use('/api/voice', createVoiceRouter(broadcast));

// --- REST API: mixing mode ---
app.use('/api/mixing', createMixingRouter(broadcast));

// --- REST API: DJ playback control ---
app.post('/api/dj/start', async (req, res) => {
  try {
    const result = await liqClient.startPlayback();
    res.json({ ok: true, data: result.data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/dj/resume', async (req, res) => {
  try {
    const result = await liqClient.resumePlayback();
    // Write cued track to current_audio.txt so transport bar updates immediately
    if (cuedTrackPath) {
      try { fs.writeFileSync('/shared/current_audio.txt', cuedTrackPath); } catch (e) {}
      cuedTrackPath = null;
    }
    res.json({ ok: true, data: result.data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cue a random track into queue (cross-buffered pipeline, ~5s fill time)
let cuedTrackPath = null;
app.post('/api/dj/cue', async (req, res) => {
  try {
    const musicDir = '/music/processed';
    const files = (await fs.promises.readdir(musicDir)).filter(f => /\.(wav|mp3|flac|ogg|aac|m4a)$/i.test(f));
    if (files.length === 0) return res.status(404).json({ error: 'No tracks found' });
    const track = files[Math.floor(Math.random() * files.length)];
    const fullPath = path.join(musicDir, track);
    cuedTrackPath = fullPath;
    const result = await liqClient.cueTrack(fullPath);
    res.json({ ok: true, track, data: result.data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/dj/stop', async (req, res) => {
  try {
    bootAborted = true;
    const result = await liqClient.stopPlayback();
    res.json({ ok: true, data: result.data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- REST API: stream keys management ---
app.get('/api/stream-keys', (req, res) => {
  const platforms = streamKeys.getPlatforms();
  const maxPlatforms = parseInt(process.env.MAX_PLATFORMS) || 3;
  res.json({ platforms, maxPlatforms });
});

app.post('/api/stream-keys/:platform', (req, res) => {
  const { platform } = req.params;
  const { enabled, streamKey, rtmpUrl } = req.body;
  const maxPlatforms = parseInt(process.env.MAX_PLATFORMS) || 3;
  const existing = streamKeys.getPlatforms();
  if (!existing[platform] && Object.keys(existing).length >= maxPlatforms) {
    return res.status(400).json({ error: `Platform limit reached (max ${maxPlatforms})` });
  }
  streamKeys.setPlatform(platform, { enabled, streamKey, rtmpUrl });
  res.json({ success: true });
});

app.patch('/api/stream-keys/:platform/enabled', (req, res) => {
  const { platform } = req.params;
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be boolean' });
  }
  const result = streamKeys.setPlatformEnabled(platform, enabled);
  if (!result) {
    return res.status(404).json({ error: 'platform not found' });
  }
  res.json({ success: true, ...result });
});

app.delete('/api/stream-keys/:platform', (req, res) => {
  const { platform } = req.params;
  streamKeys.deletePlatform(platform);
  res.json({ success: true });
});

app.get('/api/rtmp-urls', (req, res) => {
  const { broadcast } = streamControl.getControlState();
  if (!broadcast) return res.json([]);
  res.json(streamKeys.getEnabledRtmpUrls());
});

app.get('/api/rtmp-health', (req, res) => {
  res.json(state.rtmpHealth);
});

// --- REST API: quality settings ---
app.get('/api/quality', (req, res) => {
  res.json({
    current: quality.getQuality(),
    presets: quality.getPresets()
  });
});

app.post('/api/quality', (req, res) => {
  const { preset } = req.body;
  try {
    const result = quality.setQuality(preset);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- REST API: audio settings ---
app.get('/api/audio', (req, res) => {
  res.json(audioSettings.getAudioSettings());
});

app.post('/api/audio', (req, res) => {
  const { enhanced } = req.body;
  try {
    const result = audioSettings.setAudioSettings({ enhanced });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// --- REST API: channel strip ---
app.get("/api/channel-strip", async (req, res) => {
  try {
    const config = await channelStrip.getConfig();
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/channel-strip", express.json(), async (req, res) => {
  try {
    const result = await channelStrip.setConfig(req.body);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/channel-strip/preset", express.json(), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "missing preset name" });
    const result = await channelStrip.setPreset(name);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/channel-strip/metering", async (req, res) => {
  try {
    const data = await channelStrip.getMetering();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// --- REST API: video settings ---
app.get('/api/video', (req, res) => {
  res.json(videoSettings.getVideoSettings());
});

app.post('/api/video', (req, res) => {
  const { enhanced } = req.body;
  try {
    const result = videoSettings.setVideoSettings({ enhanced });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- REST API: stream control ---
app.get('/api/stream/control', (req, res) => {
  res.json(streamControl.getControlState());
});

app.post('/api/stream/control', (req, res) => {
  const { streaming, broadcast } = req.body;
  const result = streamControl.setControlState(streaming, broadcast);
  res.json({ success: true, ...result });
});

// --- REST API: stream mode (standby/live) ---
app.get('/api/stream/mode', (req, res) => {
  res.json(streamControl.getModeState());
});

app.post('/api/stream/mode', (req, res) => {
  const { mode, standbyVisual } = req.body;
  const result = streamControl.setModeState(mode, standbyVisual);
  res.json({ success: true, ...result });
});

// --- REST API: visual mode ---
app.get('/api/visual-mode', (req, res) => {
  res.json(visualMode.getVisualMode());
});

app.post('/api/visual-mode', (req, res) => {
  const { mode } = req.body;
  const result = visualMode.setVisualMode(mode);
  res.json({ success: true, ...result });
});

// --- REST API: live mode ---
app.get('/api/live-mode', (req, res) => {
  res.json(liveMode.getLiveMode());
});

app.post('/api/live-mode', (req, res) => {
  const { source, afkFallback } = req.body;
  const result = liveMode.setLiveMode({ source, afkFallback });
  broadcast('live-mode', result);
  res.json({ success: true, ...result });
});

app.post('/api/live-mode/generate-key', (req, res) => {
  const result = liveMode.regenerateIngestKey();
  broadcast('live-mode', result);
  res.json({ success: true, ...result });
});

// nginx-rtmp callbacks (form-urlencoded by default)
app.post('/api/live/on_publish', express.urlencoded({ extended: false }), (req, res) => {
  const streamName = req.body.name || '';
  const current = liveMode.getLiveMode();
  // Validate stream key: OBS publishes to rtmp://host:1935/ingest/{key}
  if (streamName !== current.ingestKey) {
    console.log(`[live] on_publish rejected: key mismatch (got ${streamName})`);
    return res.status(403).send('Forbidden');
  }
  console.log('[live] OBS connected');
  const result = liveMode.setObsStatus('connected');
  broadcast('live-mode', result);
  res.send('OK');
});

app.post('/api/live/on_done', express.urlencoded({ extended: false }), (req, res) => {
  console.log('[live] OBS disconnected');
  const result = liveMode.setObsStatus('disconnected');
  broadcast('live-mode', result);
  res.send('OK');
});

// --- REST API: processed visuals list ---
app.get('/api/visuals-processed', async (req, res) => {
  const processedDir = path.join(VISUALS_DIR, '.processed');
  try {
    const names = (await fs.promises.readdir(processedDir))
      .filter(f => /\.(mp4|mov|mkv)$/i.test(f) && !f.startsWith('_standby_'));
    const files = [];
    for (const f of names) {
      try {
        const stat = await fs.promises.stat(path.join(processedDir, f));
        files.push({ name: f, size: stat.size });
      } catch (e) { /* skip files that disappeared */ }
    }
    res.json(files);
  } catch (e) {
    res.json([]);
  }
});

// --- REST API: restream settings ---
app.get('/api/restream/settings', (req, res) => {
  res.json(restreamSettings.getSettings());
});

app.post('/api/restream/settings', (req, res) => {
  const { autoStart } = req.body;
  if (typeof autoStart !== 'boolean') {
    return res.status(400).json({ error: 'autoStart must be boolean' });
  }
  const result = restreamSettings.setAutoStart(autoStart);
  res.json({ success: true, ...result });
});

// --- Overlay assets serving ---
app.use('/overlay-assets', express.static('/shared/overlay_assets'));

// S3 status endpoint
app.get('/api/s3/status', (req, res) => {
  if (!s3.S3_ENABLED) return res.json({ enabled: false });
  const musicSize = cacheManager.getCacheSize(MUSIC_DIR);
  const visualsSize = cacheManager.getCacheSize(path.join(VISUALS_DIR, '.processed'));
  res.json({
    enabled: true,
    tenantId: s3.TENANT_ID,
    cache: {
      musicBytes: musicSize,
      visualsBytes: visualsSize,
      totalMB: Math.round((musicSize + visualsSize) / 1024 / 1024),
      maxMB: S3_CACHE_MAX_MB
    }
  });
});

// --- Auto-restore: cue + resume Liquidsoap ---
// Всегда запускается при boot (24/7 radio). Если Liquidsoap уже играет — просто ставит mode=live.
// Если нет — ждёт autoplay, затем fallback cue+resume. bootAborted отменяет при /api/dj/stop.
async function autoRestore() {
  bootAborted = false;
  const MAX_RETRIES = 30;
  const RETRY_INTERVAL = 2000;
  const start = Date.now();

  function probeStatus() {
    const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    return new Promise((resolve, reject) => {
      const req = http.get({
        hostname: 'dj', port: 7000, path: '/playback/status',
        timeout: 3000, agent
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          agent.destroy();
          try { resolve(JSON.parse(d)); } catch(e) { resolve(d); }
        });
      });
      req.on('error', (e) => { agent.destroy(); reject(e); });
      req.on('timeout', () => { req.destroy(); agent.destroy(); reject(new Error('timeout')); });
    });
  }

  // Phase 1: wait for Liquidsoap to respond to HTTP (retryable)
  await new Promise(r => setTimeout(r, 1000));
  let probeResult = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (bootAborted) { console.log('[boot] Aborted by user'); return; }
    try {
      probeResult = await probeStatus();
      break;
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        console.log(`[boot] Liquidsoap not ready (${attempt}/${MAX_RETRIES}): ${e.message}`);
        await new Promise(r => setTimeout(r, RETRY_INTERVAL));
      } else {
        console.log(`[boot] Auto-restore gave up after ${MAX_RETRIES} attempts: ${e.message}`);
      }
    }
  }
  if (!probeResult) return;

  const playing = (typeof probeResult === 'object') ? probeResult.playing : false;
  if (playing) {
    streamControl.setModeState('live');
    console.log('[boot] Liquidsoap already playing, mode set to live');
    return;
  }

  // Phase 2: Liquidsoap not playing yet — wait for autoplay (8s from its start + 4s margin)
  const elapsed = (Date.now() - start) / 1000;
  const waitForAutoplay = Math.max(0, 12 - elapsed) * 1000;
  if (waitForAutoplay > 0) {
    await new Promise(r => setTimeout(r, waitForAutoplay));
  }
  if (bootAborted) { console.log('[boot] Aborted by user'); return; }

  // Check again — autoplay should have triggered by now
  try {
    const status = await probeStatus();
    if (status && status.playing) {
      streamControl.setModeState('live');
      console.log('[boot] Liquidsoap autoplay active, mode set to live');
      return;
    }
  } catch (e) {
    // Continue to fallback
  }

  // Phase 3: fallback — manual cue + resume (autoplay didn't trigger)
  if (bootAborted) { console.log('[boot] Aborted by user'); return; }
  try {
    const musicDir = '/music/processed';
    const files = (await fs.promises.readdir(musicDir)).filter(f => /\.(wav|mp3|flac|ogg|aac|m4a)$/i.test(f));
    if (files.length === 0) {
      console.log('[boot] No tracks found, cannot auto-restore');
      return;
    }
    // Re-check: autoplay may have triggered while reading disk
    try {
      const recheck = await probeStatus();
      if (recheck && recheck.playing) {
        streamControl.setModeState('live');
        console.log('[boot] Liquidsoap started playing during fallback prep, mode set to live');
        return;
      }
    } catch (e) { /* continue with fallback */ }

    if (bootAborted) { console.log('[boot] Aborted by user'); return; }
    const track = files[Math.floor(Math.random() * files.length)];
    const fullPath = path.join(musicDir, track);

    await liqClient.cueTrack(fullPath);
    await new Promise(resolve => setTimeout(resolve, 6000));
    if (bootAborted) { console.log('[boot] Aborted by user during buffer wait'); return; }
    await liqClient.resumePlayback();
    fs.writeFileSync('/shared/current_audio.txt', fullPath);
    streamControl.setModeState('live');
    const totalElapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[boot] Auto-restored (fallback): cued ${track}, gate opened (${totalElapsed}s)`);
  } catch (e) {
    console.log(`[boot] Auto-restore cue/resume failed: ${e.message}`);
  }
}

// --- Boot sequence ---
async function boot() {
  const start = Date.now();

  // Stream control: always start HLS, autoStart controls RTMP
  const restreamCfg = restreamSettings.getSettings();
  streamControl.setControlState(true, !!restreamCfg.autoStart);
  const bootMode = streamControl.getModeState().mode || 'standby';
  console.log(`[boot] streaming=true, broadcast=${!!restreamCfg.autoStart}, mode=${bootMode}`);

  // 1-3. S3 restore (каждый шаг в try/catch — boot продолжается даже если S3 недоступен)
  if (s3.S3_ENABLED) {
    try { await syncWatcher.init(); } catch (e) {
      console.error(`[boot] syncWatcher init failed: ${e.message}`);
    }
    try { await s3.syncDir('music/processed/', path.join(MUSIC_DIR, 'processed')); } catch (e) {
      console.error(`[boot] music sync failed: ${e.message}`);
    }
    try { await s3.syncDir('visuals/processed/', path.join(VISUALS_DIR, '.processed')); } catch (e) {
      console.error(`[boot] visuals sync failed: ${e.message}`);
    }
    const syncElapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[s3] boot sync completed in ${syncElapsed}s`);
  }

  // 4. Запуск pollers
  icecastPoller.start();
  trackPoller.start();
  videoPoller.start();
  ffmpegPoller.start();
  bpmPoller.start();
  rtmpHealthPoller.start();

  // 5. Schedule executor
  startExecutor(getBpmMap, VISUALS_DIR);

  // 6. Фоновый sync TO S3
  if (s3.S3_ENABLED) {
    syncWatcher.start();
  }

  // 7. Cache eviction
  if (s3.S3_ENABLED) {
    setInterval(() => {
      const processedDir = path.join(VISUALS_DIR, '.processed');
      const maxBytes = S3_CACHE_MAX_MB * 1024 * 1024;
      const currentSize = cacheManager.getCacheSize(processedDir);
      if (currentSize > maxBytes) {
        cacheManager.evictOldest(processedDir, maxBytes);
      }
    }, 60000);
    console.log(`[s3] cache eviction enabled (max ${S3_CACHE_MAX_MB} MB for visuals)`);
  }

  // 8. Auto-restore: cue + resume (файлы уже на месте)
  await autoRestore();
}

// --- Start: listen first, then boot ---
server.keepAliveTimeout = 61000;
server.headersTimeout = 65000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[dashboard] http://0.0.0.0:${PORT}`);
  console.log(`[dashboard] mode=${OUTPUT_MODE} hls=${HLS_DIR}`);

  // Boot sequence (async, API already accepting requests)
  boot().catch(e => console.error(`[boot] fatal: ${e.message}`));
});

// --- HTTPS (for getUserMedia / secure context) ---
const TLS_PORT = process.env.TLS_PORT;
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;

if (TLS_PORT && TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
  const tlsOpts = {
    cert: fs.readFileSync(TLS_CERT),
    key: fs.readFileSync(TLS_KEY)
  };
  const tlsServer = https.createServer(tlsOpts, app);
  const wssTls = new WebSocketServer({ server: tlsServer, verifyClient: verifyWsClient });
  wssTls.on('connection', (ws) => {
    const initState = { ...state, track: state.audio, rtmpHealth: state.rtmpHealth, liveMode: liveMode.getLiveMode(), streamControl: streamControl.getControlState(), streamMode: streamControl.getModeState(), visualMode: visualMode.getVisualMode() };
    ws.send(JSON.stringify({ type: 'init', data: initState }));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        // if (msg.type === 'fft-subscribe') fftAnalyzer.subscribe(ws);
        // else if (msg.type === 'fft-unsubscribe') fftAnalyzer.unsubscribe(ws);
      } catch(e) {}
    });
    // ws.on('close', () => { fftAnalyzer.unsubscribe(ws); });
  });
  // Patch broadcast to send to both WS servers
  const origBroadcast = broadcast;
  broadcast = function(type, data) {
    const msg = JSON.stringify({ type, data });
    wss.clients.forEach((c) => { if (c.readyState === 1) c.send(msg); });
    wssTls.clients.forEach((c) => { if (c.readyState === 1) c.send(msg); });
  };
  tlsServer.listen(TLS_PORT, '0.0.0.0', () => {
    console.log(`[dashboard] https://0.0.0.0:${TLS_PORT}`);
  });
} else {
  if (TLS_PORT) console.log('[dashboard] TLS configured but cert/key not found, skipping HTTPS');
}
