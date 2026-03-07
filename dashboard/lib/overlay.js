const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const tierLimits = require('./tierLimits');

const OVERLAY_CONFIG = '/shared/overlays.json';
const FILTER_STRING_FILE = '/shared/overlay_filter_string.txt';
const ASSETS_DIR = '/shared/overlay_assets';

function loadOverlays() {
  try {
    if (fs.existsSync(OVERLAY_CONFIG)) {
      return JSON.parse(fs.readFileSync(OVERLAY_CONFIG, 'utf8'));
    }
  } catch (e) {}
  return { enabled: false, layers: [] };
}

function saveOverlays(data) {
  fs.writeFileSync(OVERLAY_CONFIG, JSON.stringify(data, null, 2));
  generateFilterString(data);
}

function generateFilterString(config) {
  if (!config.enabled || !config.layers || config.layers.length === 0) {
    // No overlays — empty filter so streamer stays in copy mode (0% CPU)
    fs.writeFileSync(FILTER_STRING_FILE, '');
    return;
  }

  const enabledLayers = config.layers.filter(l => l.enabled);
  if (enabledLayers.length === 0) {
    fs.writeFileSync(FILTER_STRING_FILE, '');
    return;
  }

  // Build filter chain
  // We need to count logo inputs for overlay filters
  const logoLayers = enabledLayers.filter(l => l.type === 'logo' && l.asset);
  const textLayers = enabledLayers.filter(l => l.type !== 'logo');

  const filters = [];

  // Add drawtext filters for text-based layers
  for (const layer of textLayers) {
    const dt = buildDrawtext(layer);
    if (dt) filters.push(dt);
  }

  filters.push('format=yuv420p');

  // Logo overlays need separate input files, which requires changing FFmpeg command
  // For now, store logo info separately for stream_entry.sh to handle
  const logoInputs = logoLayers.map(l => ({
    asset: path.join(ASSETS_DIR, l.asset),
    x: l.x || '20',
    y: l.y || '20',
    opacity: l.opacity || 1.0
  }));

  const output = {
    filterChain: filters.join(','),
    logoInputs: logoInputs
  };

  // Write both the simple filter string and the full config
  fs.writeFileSync(FILTER_STRING_FILE, filters.join(','));
  fs.writeFileSync('/shared/overlay_compiled.json', JSON.stringify(output, null, 2));
}

function buildDrawtext(layer) {
  const common = [];

  if (layer.fontsize) common.push(`fontsize=${layer.fontsize}`);
  if (layer.fontcolor) common.push(`fontcolor=${layer.fontcolor}`);
  if (layer.x) common.push(`x=${layer.x}`);
  if (layer.y) common.push(`y=${layer.y}`);
  if (layer.boxcolor) {
    common.push('box=1');
    common.push(`boxcolor=${layer.boxcolor}`);
    common.push('boxborderw=8');
  }

  switch (layer.type) {
    case 'now_playing':
      common.push('textfile=/shared/current_audio.txt');
      common.push('reload=1');
      break;
    case 'static_text':
      if (layer.text) {
        // Escape special chars for FFmpeg drawtext
        const escaped = layer.text
          .replace(/\\/g, '\\\\\\\\')
          .replace(/'/g, "\\'")
          .replace(/:/g, '\\:');
        common.push(`text='${escaped}'`);
      }
      break;
    case 'clock':
      common.push(`text='%{localtime\\:${(layer.format || '%H\\:%M').replace(/:/g, '\\:')}}'`);
      break;
    case 'scrolling_text':
      if (layer.text) {
        // Escape special chars for FFmpeg drawtext
        const escaped = layer.text
          .replace(/\\/g, '\\\\\\\\')
          .replace(/'/g, "\\'")
          .replace(/:/g, '\\:');
        common.push(`text='${escaped}'`);
      }
      // Scrolling animation: move from right to left
      // x=w-mod(t*speed,w+text_w) - starts at w, moves left at speed pixels/sec
      var scrollSpeed = layer.speed || 100;
      common.push(`x=w-mod(t*${scrollSpeed},w+text_w)`);
      // Center vertically or use specified y
      if (!layer.y) common.push('y=(h-text_h)/2');
      break;
    case 'scrolling_now_playing':
      // Read from file and scroll - same as now_playing but scrolling
      // Uses cleaned track name (no path, no extension, no underscores)
      common.push('textfile=/shared/current_track_clean.txt');
      common.push('reload=1');
      var scrollSpeed2 = layer.speed || 100;
      common.push(`x=w-mod(t*${scrollSpeed2},w+text_w)`);
      if (!layer.y) common.push('y=(h-text_h)/2');
      break;
    default:
      return null;
  }

  if (common.length === 0) return null;
  return 'drawtext=' + common.join(':');
}

function createOverlayRouter() {
  const router = express.Router();

  // Ensure assets dir exists
  if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
  }

  const upload = multer({
    dest: ASSETS_DIR,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (/\.(png|jpg|jpeg|gif|svg|webp|bmp)$/i.test(file.originalname)) {
        cb(null, true);
      } else {
        cb(new Error('Only image files allowed'));
      }
    }
  });

  // GET /api/overlays — get config
  router.get('/', (req, res) => {
    res.json(loadOverlays());
  });

  // PUT /api/overlays — update full config
  router.put('/', express.json(), (req, res) => {
    const config = req.body;
    // Check tier for custom overlays (system watermark is always allowed)
    const limits = tierLimits.getLimits(tierLimits.getTier());
    if (!limits.customOverlays) {
      // Allow only if there are no user-defined layers (system watermark is not user-chosen)
      const hasCustomLayers = config.layers && config.layers.some(l => l.type !== 'watermark');
      if (hasCustomLayers && config.enabled) {
        return res.status(403).json({ error: 'Custom overlays not available in your tier' });
      }
    }
    saveOverlays(config);
    res.json(config);
  });

  // POST /api/overlays/assets — upload asset
  router.post('/assets', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no file' });

    // Rename to original name
    const dest = path.join(ASSETS_DIR, req.file.originalname);
    fs.renameSync(req.file.path, dest);

    res.json({ name: req.file.originalname, path: dest });
  });

  // GET /api/overlays/assets — list assets
  router.get('/assets', (req, res) => {
    try {
      const files = fs.readdirSync(ASSETS_DIR)
        .filter(f => !f.startsWith('.'))
        .map(name => {
          const stat = fs.statSync(path.join(ASSETS_DIR, name));
          return { name, size: stat.size };
        });
      res.json(files);
    } catch (e) {
      res.json([]);
    }
  });

  // DELETE /api/overlays/assets/:name
  router.delete('/assets/:name', (req, res) => {
    const filePath = path.join(ASSETS_DIR, req.params.name);
    if (filePath.indexOf(ASSETS_DIR) !== 0) {
      return res.status(400).json({ error: 'invalid path' });
    }
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createOverlayRouter, loadOverlays, generateFilterString };
