const express = require('express');
const fs = require('fs');
const path = require('path');
const liqClient = require('../lib/liqClient');
const s3 = require('../lib/s3');
const { setBootAborted } = require('../lib/boot');
const paths = require('../lib/paths');
const { upstreamError } = require('../lib/httpErrors');

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
      upstreamError(res, e, 'DJ');
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
      upstreamError(res, e, 'DJ');
    }
  });

  router.post('/cue', async (req, res) => {
    // Three different things can fail here and they are NOT the same fault:
    // reading the local directory, fetching the object from S3, and cueing on
    // the DJ. One shared catch cannot tell them apart, so a missing local
    // directory would be reported as whichever upstream the message happened to
    // name — the exact misattribution fixed in queue.js's push path.
    let files;
    try {
      files = (await fs.promises.readdir(PROCESSED_DIR)).filter(f => /\.(wav|mp3|flac|ogg|aac|m4a)$/i.test(f));
    } catch (e) {
      // Local filesystem: an honest 500, not an upstream.
      return res.status(500).json({ error: e.message });
    }
    if (files.length === 0) return res.status(404).json({ error: 'No tracks found' });
    const track = files[Math.floor(Math.random() * files.length)];
    const fullPath = path.join(PROCESSED_DIR, track);

    if (s3.S3_ENABLED) {
      try {
        await s3.ensureCached(`music/processed/${track}`, fullPath);
      } catch (e) {
        return upstreamError(res, e, 's3');
      }
    }

    try {
      cuedTrackPath = fullPath;
      const result = await liqClient.cueTrack(fullPath);
      res.json({ ok: true, track, data: result.data });
    } catch (e) {
      upstreamError(res, e, 'DJ');
    }
  });

  router.post('/stop', async (req, res) => {
    try {
      setBootAborted(true);
      const result = await liqClient.stopPlayback();
      res.json({ ok: true, data: result.data });
    } catch (e) {
      upstreamError(res, e, 'DJ');
    }
  });

  return router;
}

module.exports = createDjRouter;
