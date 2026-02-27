const express = require('express');
const videoQueue = require('../lib/videoQueue');

function createVideoQueueRouter() {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json(videoQueue.getQueue());
  });

  router.post('/push', express.text({ type: '*/*' }), (req, res) => {
    const filename = (typeof req.body === 'string' ? req.body : '').trim();
    if (!filename) return res.status(400).json({ error: 'no filename' });
    videoQueue.push(filename);
    res.json({ ok: true });
  });

  router.post('/skip', (req, res) => {
    videoQueue.skip();
    res.json({ ok: true });
  });

  router.post('/clear', (req, res) => {
    videoQueue.clear();
    res.json({ ok: true });
  });

  return router;
}

module.exports = createVideoQueueRouter;
