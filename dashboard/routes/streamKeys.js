const express = require('express');
const streamKeys = require('../lib/streamKeys');
const tierLimits = require('../lib/tierLimits');

function createStreamKeysRouter() {
  const router = express.Router();

  router.get('/', (req, res) => {
    const platforms = streamKeys.getPlatforms();
    const limits = tierLimits.getLimits(tierLimits.getTier());
    res.json({ platforms, maxPlatforms: limits.maxPlatforms });
  });

  router.post('/:platform', (req, res) => {
    const { platform } = req.params;
    const { enabled, streamKey, rtmpUrl } = req.body;
    const result = streamKeys.setPlatform(platform, { enabled, streamKey, rtmpUrl });
    if (result && result.error) {
      return res.status(400).json({ error: result.error, maxPlatforms: result.maxPlatforms });
    }
    res.json({ success: true });
  });

  router.patch('/:platform/enabled', (req, res) => {
    const { platform } = req.params;
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be boolean' });
    }
    const result = streamKeys.setPlatformEnabled(platform, enabled);
    if (!result) {
      return res.status(404).json({ error: 'platform not found' });
    }
    res.json({ success: true, ...result });
  });

  router.delete('/:platform', (req, res) => {
    const { platform } = req.params;
    streamKeys.deletePlatform(platform);
    res.json({ success: true });
  });

  return router;
}

module.exports = createStreamKeysRouter;
