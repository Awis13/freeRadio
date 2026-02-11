const fs = require('fs');

const QUALITY_FILE = '/shared/stream_quality.json';

const PRESETS = {
  high: {
    name: 'High (1080p 8Mbps)',
    videoBitrate: '8000k',
    audioBitrate: '256k',
    preset: 'medium',
    scale: '1920:1080'
  },
  medium: {
    name: 'Medium (720p 4Mbps)',
    videoBitrate: '4000k',
    audioBitrate: '192k',
    preset: 'fast',
    scale: '1280:720'
  },
  low: {
    name: 'Low (480p 2Mbps)',
    videoBitrate: '2000k',
    audioBitrate: '128k',
    preset: 'fast',
    scale: '854:480'
  }
};

function getQuality() {
  try {
    if (fs.existsSync(QUALITY_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUALITY_FILE, 'utf8'));
      return { preset: data.preset, settings: PRESETS[data.preset] || PRESETS.high };
    }
  } catch (e) {}
  return { preset: 'high', settings: PRESETS.high };
}

function setQuality(preset) {
  if (!PRESETS[preset]) {
    throw new Error('Invalid preset: ' + preset);
  }
  fs.writeFileSync(QUALITY_FILE, JSON.stringify({ preset, timestamp: Date.now() }));
  return { preset, settings: PRESETS[preset] };
}

function getPresets() {
  return Object.entries(PRESETS).map(([key, value]) => ({
    key,
    name: value.name
  }));
}

module.exports = { getQuality, setQuality, getPresets };
