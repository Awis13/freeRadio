const fs = require('fs');

const TIER_FILE = '/shared/tier.json';

const TIER_LIMITS = {
  free:    { maxQuality: 'medium', maxPlatforms: 1, watermark: true, dsp: false, customOverlays: false },
  starter: { maxQuality: 'medium', maxPlatforms: 1, watermark: false, dsp: false, customOverlays: false },
  pro:     { maxQuality: 'standard', maxPlatforms: 3, watermark: false, dsp: true, customOverlays: true },
  studio:  { maxQuality: 'godmode', maxPlatforms: 3, watermark: false, dsp: true, customOverlays: true }
};

const QUALITY_ORDER = ['low', 'medium', 'high', 'standard', 'kick', 'ultra', 'godmode'];

function getTier() {
  try {
    if (fs.existsSync(TIER_FILE)) {
      const data = JSON.parse(fs.readFileSync(TIER_FILE, 'utf8'));
      if (data.tier && TIER_LIMITS[data.tier]) return data.tier;
    }
  } catch (e) {}
  return 'free';
}

function setTier(tier) {
  const safeTier = TIER_LIMITS[tier] ? tier : 'free';
  try {
    fs.writeFileSync(TIER_FILE, JSON.stringify({ tier: safeTier, updatedAt: Date.now() }));
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
