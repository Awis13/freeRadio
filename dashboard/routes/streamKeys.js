const express = require('express');
const streamKeys = require('../lib/streamKeys');

function createStreamKeysRouter() {
  const router = express.Router();

  router.get('/', (req, res) => {
    const platforms = streamKeys.getPlatforms();
    const maxPlatforms = parseInt(process.env.MAX_PLATFORMS) || 3;
    res.json({ platforms, maxPlatforms });
  });

  router.post('/:platform', (req, res) => {
    const { platform } = req.params;
    const { enabled, streamKey, rtmpUrl } = req.body;
    const maxPlatforms = parseInt(process.env.MAX_PLATFORMS) || 3;
    const existing = streamKeys.getPlatforms();
    if (!existing[platform] && Object.keys(existing).length >= maxPlatforms) {
      return res.status(400).json({ error: `Platform limit reached (max ${maxPlatforms})` });
    }
    streamKeys.setPlatform(platform, { enabled, streamKey, rtmpUrl });
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
