const path = require('path');
const express = require('express');
const liq = require('./liqClient');
const { resolvePlaylist } = require('./playlist');

// Map original filename to processed WAV path (transcoder outputs all audio as .wav)
function toProcessedPath(filename) {
  const base = path.basename(filename, path.extname(filename));
  return '/music/processed/' + base + '.wav';
}

function createQueueRouter(musicDir, getBpmMap) {
  const router = express.Router();

  // GET /api/queue — list queued tracks
  router.get('/', async (req, res) => {
    try {
      const result = await liq.getQueue();
      res.json(result.data);
    } catch (e) {
      res.status(502).json({ error: 'liquidsoap unavailable' });
    }
  });

  // POST /api/queue/push — add track to queue
  router.post('/push', express.text({ type: '*/*' }), async (req, res) => {
    try {
      const filename = (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)).trim();
      if (!filename) return res.status(400).json({ error: 'no filename' });
      const filePath = toProcessedPath(filename);
      const result = await liq.pushTrack(filePath);
      res.json(result.data);
    } catch (e) {
      res.status(502).json({ error: 'liquidsoap unavailable' });
    }
  });

  // POST /api/queue/skip — skip current track
  router.post('/skip', async (req, res) => {
    try {
      const result = await liq.skip();
      res.json(result.data);
    } catch (e) {
      res.status(502).json({ error: 'liquidsoap unavailable' });
    }
  });

  // POST /api/queue/clear — clear queue
  router.post('/clear', async (req, res) => {
    try {
      const result = await liq.clearQueue();
      res.json(result.data);
    } catch (e) {
      res.status(502).json({ error: 'liquidsoap unavailable' });
    }
  });

  // POST /api/queue/load-playlist — load playlist into queue
  router.post('/load-playlist', express.json(), async (req, res) => {
    try {
      const { playlistId, clear } = req.body;
      if (!playlistId) return res.status(400).json({ error: 'playlistId required' });

      const tracks = resolvePlaylist(playlistId, musicDir, getBpmMap());
      if (tracks.length === 0) {
        return res.status(404).json({ error: 'playlist empty or not found' });
      }

      // Clear queue first if requested (default: true)
      if (clear !== false) {
        try { await liq.clearQueue(); } catch (e) {}
        try { await liq.skip(); } catch (e) {}
      }

      // Push tracks to queue (first batch of 5)
      const batch = tracks.slice(0, 5);
      const results = [];
      for (const track of batch) {
        try {
          const r = await liq.pushTrack(toProcessedPath(track));
          results.push({ track, ok: true });
        } catch (e) {
          results.push({ track, ok: false, error: e.message });
        }
      }

      res.json({
        ok: true,
        loaded: results.filter(r => r.ok).length,
        total: tracks.length,
        results
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createQueueRouter;
