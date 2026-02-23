const express = require('express');
const liqClient = require('./liqClient');

const VALID_MODES = ['smart', 'cut', 'crossfade'];

function createMixingRouter(broadcast) {
  const router = express.Router();

  router.get('/config', async (req, res) => {
    try {
      const result = await liqClient.getMixingConfig();
      res.json(result.data);
    } catch (e) {
      res.json({ mode: 'smart' });
    }
  });

  router.post('/config', express.json(), async (req, res) => {
    const { mode } = req.body;
    if (!mode || !VALID_MODES.includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode. Valid: ' + VALID_MODES.join(', ') });
    }

    try {
      const result = await liqClient.setMixingConfig({ mode });
      console.log(`[mixing] mode changed to ${mode}`);
      broadcast('mixing-config', { mode });
      res.json(result.data);
    } catch (e) {
      res.status(502).json({ error: 'DJ unavailable' });
    }
  });

  return router;
}

module.exports = createMixingRouter;
