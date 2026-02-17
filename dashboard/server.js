const fs = require('fs');
const express = require('express');
const http = require('http');
const path = require('path');
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
const videoQueue = require('./lib/videoQueue');
const createQueueRouter = require('./lib/queue');
const { createPlaylistRouter } = require('./lib/playlist');
const { createTrackRouter } = require('./lib/trackMeta');
const { createVisualProfileRouter } = require('./lib/visualProfile');
const { createOverlayRouter } = require('./lib/overlay');
const { createScheduleRouter, startExecutor, onTrackChange } = require('./lib/schedule');
const { createHistoryRouter } = require('./lib/history');

const PORT = process.env.PORT || 9090;
const HLS_DIR = process.env.HLS_DIR || '/hls';
const MUSIC_DIR = process.env.MUSIC_DIR || '/music';
const VISUALS_DIR = process.env.VISUALS_DIR || '/visuals';
const FFMPEG_PROGRESS_FILE = process.env.FFMPEG_PROGRESS_FILE || '';
const OUTPUT_MODE = process.env.OUTPUT_MODE || 'hls';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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

// --- WebSocket ---
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

wss.on('connection', (ws) => {
  const initState = {
    ...state,
    track: state.audio,
    rtmpHealth: state.rtmpHealth
  };
  ws.send(JSON.stringify({ type: 'init', data: initState }));
});

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public')));

// hls.js
app.get('/js/hls.min.js', (req, res) => {
  res.sendFile('/app/hls.min.js');
});

// --- HLS segments ---
app.use('/hls', express.static(HLS_DIR, {
  setHeaders(res) {
    res.set('Cache-Control', 'no-cache, no-store');
    res.set('Access-Control-Allow-Origin', '*');
  }
}));

// --- REST API: status ---
app.get('/api/status', (req, res) => {
  res.json(state);
});

// --- REST API: file management ---
app.use('/api/music', fileManager(MUSIC_DIR));
app.use('/api/visuals', fileManager(VISUALS_DIR));

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

// --- REST API: overlays ---
app.use('/api/overlays', createOverlayRouter());

// --- REST API: stream keys management ---
app.use(express.json());

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
  const { mode, radioVisual } = req.body;
  const result = visualMode.setVisualMode(mode, radioVisual);
  res.json({ success: true, ...result });
});

// --- REST API: processed visuals list ---
app.get('/api/visuals-processed', (req, res) => {
  const processedDir = path.join(VISUALS_DIR, '.processed');
  try {
    const files = fs.readdirSync(processedDir)
      .filter(f => /\.(mp4|mov|mkv)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(processedDir, f));
        return { name: f, size: stat.size };
      });
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

// --- Start ---
// Local HLS streaming always starts on boot (preview mode).
// autoStart controls whether RTMP broadcast is active on boot.
const restreamCfg = restreamSettings.getSettings();
streamControl.setControlState(true, !!restreamCfg.autoStart);
streamControl.setModeState('live');
console.log(`[boot] streaming=true, broadcast=${!!restreamCfg.autoStart}, mode=live`);

icecastPoller.start();
trackPoller.start();
videoPoller.start();
ffmpegPoller.start();
bpmPoller.start();
rtmpHealthPoller.start();

// Start schedule executor daemon
startExecutor(getBpmMap);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[dashboard] http://0.0.0.0:${PORT}`);
  console.log(`[dashboard] mode=${OUTPUT_MODE} hls=${HLS_DIR}`);
});
