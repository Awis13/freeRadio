const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createIcecastPoller } = require('./lib/icecast');
const { createTrackPoller } = require('./lib/track');
const { createVideoPoller } = require('./lib/video');
const { createFfmpegPoller } = require('./lib/ffmpeg');
const { createBpmMapPoller } = require('./lib/bpmMap');
const fileManager = require('./lib/fileManager');
const streamKeys = require('./lib/streamKeys');
const quality = require('./lib/quality');
const streamControl = require('./lib/streamControl');

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
  track: { title: '', filename: '' },  // для совместимости
  icecast: { listeners: 0, bitrate: 0, serverStart: '' },
  ffmpeg: { fps: '', speed: '', bitrate: '', frame: '', time: '' },
  bpm: {}
};

// --- Pollers ---
const icecastPoller = createIcecastPoller((data) => {
  state.icecast = data;
  broadcast('icecast', data);
  // Also update track title from icecast if liquidsoap doesn't provide it
  if (data.title && !state.track.title) {
    state.track = { title: data.title, filename: '' };
    broadcast('track', state.track);
  }
});

const trackPoller = createTrackPoller((data) => {
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

// --- WebSocket ---
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

wss.on('connection', (ws) => {
  // Для совместимости с фронтендом
  const initState = {
    ...state,
    track: state.audio  // track = audio для совместимости
  };
  ws.send(JSON.stringify({ type: 'init', data: initState }));
});

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public')));

// hls.js — скачанный при сборке Docker образа
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

// --- REST API: stream keys management ---
app.use(express.json());

// Get all platforms (with masked keys)
app.get('/api/stream-keys', (req, res) => {
  res.json(streamKeys.getPlatforms());
});

// Add/update platform
app.post('/api/stream-keys/:platform', (req, res) => {
  const { platform } = req.params;
  const { enabled, streamKey, rtmpUrl } = req.body;
  
  streamKeys.setPlatform(platform, { enabled, streamKey, rtmpUrl });
  res.json({ success: true });
});

// Toggle platform enabled/disabled without changing key/url
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

// Delete platform
app.delete('/api/stream-keys/:platform', (req, res) => {
  const { platform } = req.params;
  streamKeys.deletePlatform(platform);
  res.json({ success: true });
});

// Get RTMP URLs for streamer (internal use)
app.get('/api/rtmp-urls', (req, res) => {
  res.json(streamKeys.getEnabledRtmpUrls());
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

// --- REST API: stream control (start/stop) ---
app.get('/api/stream/control', (req, res) => {
  res.json(streamControl.getControlState());
});

app.post('/api/stream/control', (req, res) => {
  const { streaming } = req.body;
  const result = streamControl.setControlState(streaming);
  res.json({ success: true, ...result });
});

// --- Start ---
icecastPoller.start();
trackPoller.start();
videoPoller.start();
ffmpegPoller.start();
bpmPoller.start();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[dashboard] http://0.0.0.0:${PORT}`);
  console.log(`[dashboard] mode=${OUTPUT_MODE} hls=${HLS_DIR}`);
});
