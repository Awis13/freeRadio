const express = require('express');
const fs = require('fs');
const path = require('path');
const liqClient = require('../lib/liqClient');
const s3 = require('../lib/s3');
const { setBootAborted } = require('../lib/boot');
const paths = require('../lib/paths');

let cuedTrackPath = null;

function createDjRouter(musicDir) {
  const router = express.Router();
  const PROCESSED_DIR = path.join(musicDir, 'processed');

  router.post('/start', async (req, res) => {
    try {
      const result = await liqClient.startPlayback();
      // Signal streamer to restart pipeline with fresh audio
      try { fs.writeFileSync(paths.shared('restart_stream'), ''); } catch (e) {}
      res.json({ ok: true, data: result.data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/resume', async (req, res) => {
    try {
      const result = await liqClient.resumePlayback();
      if (cuedTrackPath) {
        try { fs.writeFileSync(paths.shared('current_audio.txt'), cuedTrackPath); } catch (e) {}
        cuedTrackPath = null;
      }
      res.json({ ok: true, data: result.data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/cue', async (req, res) => {
    try {
      const files = (await fs.promises.readdir(PROCESSED_DIR)).filter(f => /\.(wav|mp3|flac|ogg|aac|m4a)$/i.test(f));
      if (files.length === 0) return res.status(404).json({ error: 'No tracks found' });
      const track = files[Math.floor(Math.random() * files.length)];
      const fullPath = path.join(PROCESSED_DIR, track);

      if (s3.S3_ENABLED) {
        await s3.ensureCached(`music/processed/${track}`, fullPath);
      }

      cuedTrackPath = fullPath;
      const result = await liqClient.cueTrack(fullPath);
      res.json({ ok: true, track, data: result.data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/stop', async (req, res) => {
    try {
      setBootAborted(true);
      const result = await liqClient.stopPlayback();
      res.json({ ok: true, data: result.data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createDjRouter;
