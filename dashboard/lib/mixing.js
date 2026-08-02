const express = require('express');
const liqClient = require('./liqClient');
const { upstreamError } = require('./httpErrors');

const VALID_MODES = ['smart', 'cut', 'crossfade'];

function createMixingRouter(broadcast) {
  const router = express.Router();

  router.get('/config', async (req, res) => {
    try {
      const result = await liqClient.getMixingConfig();
      res.json(result.data);
    } catch (e) {
      // Was a 200 { mode: 'smart' }: an unreachable DJ was indistinguishable
      // from one genuinely set to smart, so the UI showed a confident reading
      // of a config it had never received.
      upstreamError(res, e, 'DJ');
    }
  });

  router.post('/config', async (req, res) => {
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
      upstreamError(res, e, 'DJ');
    }
  });

  return router;
}

module.exports = createMixingRouter;
