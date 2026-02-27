const express = require('express');
const quality = require('../lib/quality');
const audioSettings = require('../lib/audioSettings');
const videoSettings = require('../lib/videoSettings');
const channelStrip = require('../lib/channelStrip');
const streamControl = require('../lib/streamControl');
const visualMode = require('../lib/visualMode');
const liveMode = require('../lib/liveMode');
const restreamSettings = require('../lib/restreamSettings');
const { broadcast } = require('../lib/wsServer');

function createSettingsRouter() {
  const router = express.Router();

  // --- Quality ---
  router.get('/quality', (req, res) => {
    res.json({
      current: quality.getQuality(),
      presets: quality.getPresets()
    });
  });

  router.post('/quality', (req, res) => {
    const { preset } = req.body;
    try {
      const result = quality.setQuality(preset);
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // --- Audio ---
  router.get('/audio', (req, res) => {
    res.json(audioSettings.getAudioSettings());
  });

  router.post('/audio', (req, res) => {
    const { enhanced } = req.body;
    try {
      const result = audioSettings.setAudioSettings({ enhanced });
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // --- Channel strip ---
  router.get('/channel-strip', async (req, res) => {
    try {
      const config = await channelStrip.getConfig();
      res.json(config);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/channel-strip', express.json(), async (req, res) => {
    try {
      const result = await channelStrip.setConfig(req.body);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/channel-strip/preset', express.json(), async (req, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'missing preset name' });
      const result = await channelStrip.setPreset(name);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/channel-strip/metering', async (req, res) => {
    try {
      const data = await channelStrip.getMetering();
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- Video ---
  router.get('/video', (req, res) => {
    res.json(videoSettings.getVideoSettings());
  });

  router.post('/video', (req, res) => {
    const { enhanced } = req.body;
    try {
      const result = videoSettings.setVideoSettings({ enhanced });
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // --- Stream control ---
  router.get('/stream/control', (req, res) => {
    res.json(streamControl.getControlState());
  });

  router.post('/stream/control', (req, res) => {
    const { streaming, broadcast: bcast } = req.body;
    const result = streamControl.setControlState(streaming, bcast);
    res.json({ success: true, ...result });
  });

  router.get('/stream/mode', (req, res) => {
    res.json(streamControl.getModeState());
  });

  router.post('/stream/mode', (req, res) => {
    const { mode, standbyVisual } = req.body;
    const result = streamControl.setModeState(mode, standbyVisual);
    res.json({ success: true, ...result });
  });

  // --- Visual mode ---
  router.get('/visual-mode', (req, res) => {
    res.json(visualMode.getVisualMode());
  });

  router.post('/visual-mode', (req, res) => {
    const { mode } = req.body;
    const result = visualMode.setVisualMode(mode);
    res.json({ success: true, ...result });
  });

  // --- Live mode ---
  router.get('/live-mode', (req, res) => {
    res.json(liveMode.getLiveMode());
  });

  router.post('/live-mode', (req, res) => {
    const { source, afkFallback } = req.body;
    const result = liveMode.setLiveMode({ source, afkFallback });
    broadcast('live-mode', result);
    res.json({ success: true, ...result });
  });

  router.post('/live-mode/generate-key', (req, res) => {
    const result = liveMode.regenerateIngestKey();
    broadcast('live-mode', result);
    res.json({ success: true, ...result });
  });

  // --- Restream settings ---
  router.get('/restream/settings', (req, res) => {
    res.json(restreamSettings.getSettings());
  });

  router.post('/restream/settings', (req, res) => {
    const { autoStart } = req.body;
    if (typeof autoStart !== 'boolean') {
      return res.status(400).json({ error: 'autoStart must be boolean' });
    }
    const result = restreamSettings.setAutoStart(autoStart);
    res.json({ success: true, ...result });
  });

  return router;
}

module.exports = createSettingsRouter;
