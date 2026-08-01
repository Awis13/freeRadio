const fs = require('fs');
const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const { createIcecastPoller } = require('./lib/icecast');
const { createTrackPoller } = require('./lib/track');
const { createVideoPoller } = require('./lib/video');
const { createFfmpegPoller } = require('./lib/ffmpeg');
const { createBpmMapPoller } = require('./lib/bpmMap');
const { createRtmpHealthPoller } = require('./lib/rtmpHealth');
const fileManager = require('./lib/fileManager');
const streamControl = require('./lib/streamControl');
const restreamSettings = require('./lib/restreamSettings');
const liveMode = require('./lib/liveMode');
const visualMode = require('./lib/visualMode');
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
const s3 = require('./lib/s3');
const cacheManager = require('./lib/cacheManager');
const { setupWs, setupTlsWs, broadcast } = require('./lib/wsServer');
const { boot } = require('./lib/boot');
const rateLimit = require('express-rate-limit');
const createDjRouter = require('./routes/dj');
const createStreamKeysRouter = require('./routes/streamKeys');
const createSettingsRouter = require('./routes/settings');
const createStatusRouter = require('./routes/status');
const createVideoQueueRouter = require('./routes/videoQueue');
const createLiveRouter = require('./routes/live');
const ssoHandler = require('./routes/sso');
const tierLimits = require('./lib/tierLimits');
const paths = require('./lib/paths');
const authGate = require('./lib/authGate');

// --- Config ---
const PORT = process.env.PORT || 9090;
const HLS_DIR = paths.HLS_DIR;
const MUSIC_DIR = paths.MUSIC_DIR;
const VISUALS_DIR = paths.VISUALS_DIR;
const FFMPEG_PROGRESS_FILE = process.env.FFMPEG_PROGRESS_FILE || '';
const OUTPUT_MODE = process.env.OUTPUT_MODE || 'hls';
const S3_CACHE_MAX_MB = parseInt(process.env.S3_CACHE_MAX_MB) || 4000;

// --- App + Server ---
const app = express();
const server = http.createServer(app);

// --- State ---
const state = {
  outputMode: OUTPUT_MODE,
  audio: { title: '', filename: '' },
  video: { title: '', filename: '' },
  track: { title: '', filename: '' },
  icecast: { listeners: 0, bitrate: 0, serverStart: '' },
  ffmpeg: { fps: '', speed: '', bitrate: '', frame: '', time: '' },
  bpm: {},
  rtmpHealth: {}
};

function getBpmMap() { return state.bpm; }

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

function getInitState() {
  return {
    ...state,
    track: state.audio,
    rtmpHealth: state.rtmpHealth,
    liveMode: liveMode.getLiveMode(),
    streamControl: streamControl.getControlState(),
    streamMode: streamControl.getModeState(),
    visualMode: visualMode.getVisualMode()
  };
}

const wss = setupWs(server, null, getInitState);

// --- Middleware ---
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; font-src 'self'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 3000, standardHeaders: true });
app.use('/api/', apiLimiter);

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.html') || filePath.endsWith('.css')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
    }
  }
}));

app.get('/js/hls.min.js', (req, res) => { res.sendFile(paths.HLS_JS_PATH); });

app.use('/hls', express.static(HLS_DIR, {
  setHeaders(res) {
    res.set('Cache-Control', 'no-cache, no-store');
    res.set('Access-Control-Allow-Origin', '*');
  }
}));

app.use(express.json());

// --- SSO endpoint (before auth middleware, no Bearer token required) ---
app.get('/auth/sso', ssoHandler);

// --- Health endpoint for controlplane (public, no auth) ---
app.get('/api/health', (req, res) => {
  const uptime = process.uptime();
  const streamActive = state.ffmpeg && state.ffmpeg.speed && state.ffmpeg.speed !== '0x';
  res.json({
    status: 'ok',
    listeners: state.icecast ? state.icecast.listeners : 0,
    uptime: Math.floor(uptime),
    stream_active: !!streamActive
  });
});

// --- Tier endpoint (public, no auth) ---
app.get('/api/tier', (req, res) => {
  const tier = tierLimits.getTier();
  res.json({ tier, limits: tierLimits.getLimits(tier) });
});

// --- Auth middleware ---
// Say which posture this process is in before serving anything.
authGate.logStartupPosture();

const PUBLIC_PATHS = [
  '/api/status', '/api/health', '/api/audio-stream', '/api/rtmp-health',
  '/api/live/on_publish', '/api/live/on_done', '/api/auth/verify', '/api/tier'
];

app.use('/api/', (req, res, next) => {
  if (authGate.isOpen()) return next();
  const fullPath = req.baseUrl + req.path;
  if (PUBLIC_PATHS.some(p => fullPath === p || fullPath.startsWith(p + '/'))) return next();
  // No token configured and no explicit opt-out: deny rather than let everyone in.
  if (authGate.isClosed()) {
    return res.status(401).json({ error: 'Auth is not configured' });
  }
  const auth = req.headers.authorization || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
  if (authGate.accepts(presented)) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

// --- Routes ---
app.use('/api', createStatusRouter(state));
app.use('/api/music', fileManager(path.join(MUSIC_DIR, 'processed')));
app.use('/api/visuals', fileManager(path.join(VISUALS_DIR, 'incoming')));
app.use('/api/queue', createQueueRouter(MUSIC_DIR, getBpmMap));
app.use('/api/video-queue', createVideoQueueRouter());
app.use('/api/playlists', createPlaylistRouter(MUSIC_DIR, getBpmMap));
app.use('/api/tracks', createTrackRouter(MUSIC_DIR, getBpmMap));
app.use('/api/schedule', createScheduleRouter());
app.use('/api/history', createHistoryRouter());
app.use('/api/visual-profiles', createVisualProfileRouter(VISUALS_DIR));
app.use('/api/video-playlists', createVideoPlaylistRouter(VISUALS_DIR));
app.use('/api/overlays', createOverlayRouter());
app.use('/api/voice', createVoiceRouter(broadcast));
app.use('/api/mixing', createMixingRouter(broadcast));
app.use('/api/dj', createDjRouter(MUSIC_DIR));
app.use('/api/stream-keys', createStreamKeysRouter());
app.use('/api', createSettingsRouter());
app.use('/api/live', createLiveRouter());
app.use('/overlay-assets', express.static(paths.shared('overlay_assets')));

// --- Start ---
const restreamCfg = restreamSettings.getSettings();
streamControl.setControlState(true, !!restreamCfg.autoStart);
const bootMode = streamControl.getModeState().mode || 'standby';
console.log(`[boot] streaming=true, broadcast=${!!restreamCfg.autoStart}, mode=${bootMode}`);

server.keepAliveTimeout = 61000;
server.headersTimeout = 65000;

// Startup tail (listen + pollers + boot + TLS) is skipped under tests so the app
// can be imported without binding ports. Production entrypoint runs `node server.js`
// with NODE_ENV unset, so the production path is unchanged.
if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[dashboard] http://0.0.0.0:${PORT}`);
    console.log(`[dashboard] mode=${OUTPUT_MODE} hls=${HLS_DIR}`);

    // Start pollers
    icecastPoller.start();
    trackPoller.start();
    videoPoller.start();
    ffmpegPoller.start();
    bpmPoller.start();
    rtmpHealthPoller.start();
    startExecutor(getBpmMap, VISUALS_DIR);

    // Boot: S3 sync + auto-restore (async, API already accepting requests)
    boot({ musicDir: MUSIC_DIR, visualsDir: VISUALS_DIR })
      .catch(e => console.error(`[boot] fatal: ${e.message}`));

    // S3 cache eviction
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
  });

  // --- HTTPS ---
  const TLS_PORT = process.env.TLS_PORT;
  const TLS_CERT = process.env.TLS_CERT;
  const TLS_KEY = process.env.TLS_KEY;

  if (TLS_PORT && TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
    try {
    const tlsOpts = { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) };
    const tlsServer = https.createServer(tlsOpts, app);
    setupTlsWs(tlsServer, null, getInitState, wss);
    tlsServer.listen(TLS_PORT, '0.0.0.0', () => {
      console.log(`[dashboard] https://0.0.0.0:${TLS_PORT}`);
    });
    } catch (e) {
      console.log(`[dashboard] TLS cert/key not readable, skipping HTTPS: ${e.message}`);
    }
  } else {
    if (TLS_PORT) console.log('[dashboard] TLS configured but cert/key not found, skipping HTTPS');
  }
}

// Test-only exports for the characterization harness (tests/dashboard/server.test.js).
// `state` is exported so tests can drive /api/health and getInitState() pins;
// nothing in production reads these exports (entrypoint just runs this file).
module.exports = { app, server, state, getInitState };
