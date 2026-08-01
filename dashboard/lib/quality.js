const tierLimits = require('./tierLimits');
const paths = require('./paths');
const { readStore, writeStore } = require('./jsonStore');

const QUALITY_FILE = paths.shared('stream_quality.json');

const PRESETS = {
  godmode: {
    name: 'God Mode (1440p VP9 Force)',
    videoBitrate: '12000k',
    audioBitrate: '320k',
    preset: 'veryfast',
    tune: 'animation',
    scale: '2560:1440',
    forceVp9: true
  },
  ultra: {
    name: 'Ultra (1080p 12Mbps)',
    videoBitrate: '12000k',
    audioBitrate: '320k',
    preset: 'fast',
    tune: 'animation',
    scale: '1920:1080'
  },
  standard: {
    name: 'Standard (1080p 6Mbps)',
    videoBitrate: '6000k',
    audioBitrate: '192k',
    preset: 'veryfast',
    scale: '1920:1080'
  },
  kick: {
    name: 'Kick Safe (1080p 6Mbps)',
    videoBitrate: '6000k',
    audioBitrate: '192k',
    preset: 'veryfast',
    scale: '1920:1080'
  },
  high: {
    name: 'High (1080p 6Mbps)',
    videoBitrate: '6000k',
    audioBitrate: '256k',
    preset: 'veryfast',
    scale: '1920:1080'
  },
  medium: {
    name: 'Medium (720p 4Mbps)',
    videoBitrate: '4000k',
    audioBitrate: '192k',
    preset: 'veryfast',
    scale: '1280:720'
  },
  low: {
    name: 'Low (480p 2Mbps)',
    videoBitrate: '2000k',
    audioBitrate: '128k',
    preset: 'veryfast',
    scale: '854:480'
  }
};

function getQuality() {
  // readStore never throws — no catch needed around it.
  const data = readStore(QUALITY_FILE, null);
  if (data) {
    return { preset: data.preset, settings: { ...(PRESETS[data.preset] || PRESETS.high) } };
  }
  // Copies, not the PRESETS entries themselves: callers used to receive the
  // shared objects, so anything mutating a returned `settings` edited the
  // preset table for the whole process.
  return { preset: 'high', settings: { ...PRESETS.high } };
}

function setQuality(preset) {
  if (!PRESETS[preset]) {
    throw new Error('Invalid preset: ' + preset);
  }
  const tier = tierLimits.getTier();
  if (!tierLimits.isQualityAllowed(preset, tier)) {
    const limits = tierLimits.getLimits(tier);
    return { error: 'Quality preset exceeds tier limit', maxAllowed: limits.maxQuality };
  }
  writeStore(QUALITY_FILE, { preset, timestamp: Date.now() }, { indent: 0 });
  return { preset, settings: { ...PRESETS[preset] } };
}

function getPresets() {
  return Object.entries(PRESETS).map(([key, value]) => ({
    key,
    name: value.name
  }));
}

module.exports = { getQuality, setQuality, getPresets };
