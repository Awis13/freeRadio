const express = require('express');
const fs = require('fs');
const path = require('path');
const authGate = require('../lib/authGate');
const { spawn } = require('child_process');
const streamControl = require('../lib/streamControl');
const streamKeys = require('../lib/streamKeys');
const visualMode = require('../lib/visualMode');
const liveMode = require('../lib/liveMode');
const s3 = require('../lib/s3');
const cacheManager = require('../lib/cacheManager');
const paths = require('../lib/paths');

function createStatusRouter(state) {
  const router = express.Router();

  const MUSIC_DIR = paths.MUSIC_DIR;
  const VISUALS_DIR = paths.VISUALS_DIR;
  const S3_CACHE_MAX_MB = parseInt(process.env.S3_CACHE_MAX_MB) || 4000;

  // --- Auth verify ---
  router.post('/auth/verify', (req, res) => {
    const { token } = req.body || {};
    if (authGate.accepts(token)) return res.json({ ok: true });
    if (authGate.isClosed()) {
      return res.status(401).json({ error: 'Auth is not configured' });
    }
    res.status(401).json({ error: 'Invalid token' });
  });

  // --- Full status ---
  router.get('/status', (req, res) => {
    res.json({
      ...state,
      streamControl: streamControl.getControlState(),
      streamMode: streamControl.getModeState(),
      visualMode: visualMode.getVisualMode(),
      liveMode: liveMode.getLiveMode()
    });
  });

  // --- Audio stream proxy (for Web Audio API analyzer in Safari) ---
  router.get('/audio-stream', (req, res) => {
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

  // --- RTMP URLs ---
  router.get('/rtmp-urls', (req, res) => {
    const { broadcast } = streamControl.getControlState();
    if (!broadcast) return res.json([]);
    res.json(streamKeys.getEnabledRtmpUrls());
  });

  // --- RTMP health ---
  router.get('/rtmp-health', (req, res) => {
    res.json(state.rtmpHealth);
  });

  // --- Processed visuals list ---
  router.get('/visuals-processed', async (req, res) => {
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

  // --- S3 status ---
  router.get('/s3/status', (req, res) => {
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

  return router;
}

module.exports = createStatusRouter;
