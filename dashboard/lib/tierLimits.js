const paths = require('./paths');
const { readStore, writeStore } = require('./jsonStore');

const TIER_FILE = paths.shared('tier.json');

const TIER_LIMITS = {
  free:    { maxQuality: 'medium', maxPlatforms: 1, watermark: true, dsp: false, customOverlays: false },
  starter: { maxQuality: 'medium', maxPlatforms: 1, watermark: false, dsp: false, customOverlays: false },
  pro:     { maxQuality: 'kick', maxPlatforms: 3, watermark: false, dsp: true, customOverlays: true },
  studio:  { maxQuality: 'godmode', maxPlatforms: 3, watermark: false, dsp: true, customOverlays: true }
};

const QUALITY_ORDER = ['low', 'medium', 'high', 'standard', 'kick', 'ultra', 'godmode'];

function getTier() {
  try {
    const data = readStore(TIER_FILE, null);
    if (data && data.tier && TIER_LIMITS[data.tier]) return data.tier;
  } catch (e) {}
  return 'free';
}

function setTier(tier) {
  const safeTier = TIER_LIMITS[tier] ? tier : 'free';
  try {
    writeStore(TIER_FILE, { tier: safeTier, updatedAt: Date.now() }, { indent: 0 });
  } catch (e) {
    console.error('[tierLimits] failed to write tier file:', e.message);
  }
}

function getLimits(tier) {
  return TIER_LIMITS[tier] || TIER_LIMITS.free;
}

function isQualityAllowed(preset, tier) {
  const limits = getLimits(tier || getTier());
  const maxIdx = QUALITY_ORDER.indexOf(limits.maxQuality);
  const presetIdx = QUALITY_ORDER.indexOf(preset);
  if (maxIdx === -1 || presetIdx === -1) return false;
  return presetIdx <= maxIdx;
}

function isWithinPlatformLimit(currentCount, tier) {
  const limits = getLimits(tier || getTier());
  return currentCount <= limits.maxPlatforms;
}

module.exports = { TIER_LIMITS, QUALITY_ORDER, getTier, setTier, getLimits, isQualityAllowed, isWithinPlatformLimit };
