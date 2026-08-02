const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const liqClient = require('./liqClient');
const paths = require('./paths');
const { upstreamError } = require('./httpErrors');

const VOICE_DIR = paths.shared('voice');
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

function createVoiceRouter(broadcast) {
  const router = express.Router();

  // Ensure voice directory exists
  fs.mkdirSync(VOICE_DIR, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: VOICE_DIR,
      filename(req, file, cb) {
        const ext = path.extname(file.originalname) || '.webm';
        cb(null, `ptt_${Date.now()}${ext}`);
      }
    }),
    limits: { fileSize: 50 * 1024 * 1024 }
  });

  // Clean up old voice files
  function cleanup() {
    try {
      const now = Date.now();
      const files = fs.readdirSync(VOICE_DIR);
      for (const f of files) {
        const fp = path.join(VOICE_DIR, f);
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          fs.unlinkSync(fp);
        }
      }
    } catch (e) { /* ignore */ }
  }

  router.post('/send', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No audio file' });

    const filePath = req.file.path;
    console.log(`[voice] received ${req.file.filename} (${req.file.size} bytes)`);

    try {
      await liqClient.pushVoice(filePath);
      broadcast('voice-status', { status: 'on-air', filename: req.file.filename });
      console.log(`[voice] pushed to liquidsoap: ${filePath}`);
      res.json({ ok: true, filename: req.file.filename });
    } catch (e) {
      // The message used to be echoed to the client, and a connection error
      // carries the upstream's host and port ("connect ECONNREFUSED dj:7000").
      // The cause still reaches the log, where it belongs.
      upstreamError(res, e, 'DJ');
    }

    // Cleanup in background
    cleanup();
  });

  // Voice config: get current duck/gain
  router.get('/config', async (req, res) => {
    try {
      const result = await liqClient.getVoiceConfig();
      res.json(result.data);
    } catch (e) {
      upstreamError(res, e, 'DJ');
    }
  });

  // Voice config: set duck/gain
  router.post('/config', async (req, res) => {
    const { duck, gain } = req.body;
    const config = {};
    if (duck !== undefined) config.duck = parseFloat(duck);
    if (gain !== undefined) config.gain = parseFloat(gain);

    try {
      const result = await liqClient.setVoiceConfig(config);
      console.log(`[voice] config updated: duck=${config.duck} gain=${config.gain}`);
      broadcast('voice-config', result.data);
      res.json(result.data);
    } catch (e) {
      upstreamError(res, e, 'DJ');
    }
  });

  return router;
}

module.exports = createVoiceRouter;
