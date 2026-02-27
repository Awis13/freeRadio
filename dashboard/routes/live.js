const express = require('express');
const liveMode = require('../lib/liveMode');
const { broadcast } = require('../lib/wsServer');

function createLiveRouter() {
  const router = express.Router();

  // nginx-rtmp on_publish callback (form-urlencoded by default)
  router.post('/on_publish', express.urlencoded({ extended: false }), (req, res) => {
    const streamName = req.body.name || '';
    const current = liveMode.getLiveMode();
    if (streamName !== current.ingestKey) {
      console.log(`[live] on_publish rejected: key mismatch (got ${streamName})`);
      return res.status(403).send('Forbidden');
    }
    console.log('[live] OBS connected');
    const result = liveMode.setObsStatus('connected');
    broadcast('live-mode', result);
    res.send('OK');
  });

  // nginx-rtmp on_done callback
  router.post('/on_done', express.urlencoded({ extended: false }), (req, res) => {
    console.log('[live] OBS disconnected');
    const result = liveMode.setObsStatus('disconnected');
    broadcast('live-mode', result);
    res.send('OK');
  });

  return router;
}

module.exports = createLiveRouter;
