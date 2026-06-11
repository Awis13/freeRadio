/**
 * tests/dashboard/tierLimits.test.js
 *
 * Characterization tests for dashboard/lib/tierLimits.js — the tier/monetization layer.
 * Pins: the TIER_LIMITS monetization matrix, QUALITY_ORDER, getTier fallback behavior,
 * setTier normalization and file shape, getLimits fallback, isQualityAllowed truth
 * table, isWithinPlatformLimit boundaries.
 *
 * These contracts gate paid features (quality presets, platform count, watermark,
 * DSP, custom overlays). Any change here is a pricing/product decision, not a refactor.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

const TIER_FILE = '/shared/tier.json';
let files = {};

beforeEach(() => {
  files = {};
  vi.restoreAllMocks();

  vi.spyOn(fs, 'existsSync').mockImplementation(p => p in files);
  vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
    if (p in files) return files[p];
    throw new Error('ENOENT');
  });
  vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
    files[p] = data;
  });
});

const {
  TIER_LIMITS,
  QUALITY_ORDER,
  getTier,
  setTier,
  getLimits,
  isQualityAllowed,
  isWithinPlatformLimit
} = await import('../../dashboard/lib/tierLimits.js');

// ---------------------------------------------------------------------------
// TIER_LIMITS — the monetization matrix (exact snapshot)
// ---------------------------------------------------------------------------
describe('TIER_LIMITS matrix', () => {
  it('matches the exact monetization table', () => {
    expect(TIER_LIMITS).toEqual({
      free:    { maxQuality: 'medium', maxPlatforms: 1, watermark: true, dsp: false, customOverlays: false },
      starter: { maxQuality: 'medium', maxPlatforms: 1, watermark: false, dsp: false, customOverlays: false },
      pro:     { maxQuality: 'kick', maxPlatforms: 3, watermark: false, dsp: true, customOverlays: true },
      studio:  { maxQuality: 'godmode', maxPlatforms: 3, watermark: false, dsp: true, customOverlays: true }
    });
  });

  it('QUALITY_ORDER is the exact preset ladder used for limit comparisons', () => {
    expect(QUALITY_ORDER).toEqual(['low', 'medium', 'high', 'standard', 'kick', 'ultra', 'godmode']);
  });
});

// ---------------------------------------------------------------------------
// getTier — reads /shared/tier.json on EVERY call, falls back to 'free'
// ---------------------------------------------------------------------------
describe('getTier', () => {
  it('returns free when tier file is missing', () => {
    expect(getTier()).toBe('free');
  });

  it('returns free on corrupt JSON', () => {
    files[TIER_FILE] = 'not json {{{';
    expect(getTier()).toBe('free');
  });

  it('returns free for unknown tier value', () => {
    files[TIER_FILE] = JSON.stringify({ tier: 'unknown' });
    expect(getTier()).toBe('free');
  });

  it('returns free for empty object (no tier field)', () => {
    files[TIER_FILE] = JSON.stringify({});
    expect(getTier()).toBe('free');
  });

  it.each(['free', 'starter', 'pro', 'studio'])('round-trips valid tier %s', (tier) => {
    files[TIER_FILE] = JSON.stringify({ tier });
    expect(getTier()).toBe(tier);
  });

  it('re-reads the file on every call (no caching)', () => {
    files[TIER_FILE] = JSON.stringify({ tier: 'free' });
    expect(getTier()).toBe('free');
    files[TIER_FILE] = JSON.stringify({ tier: 'studio' });
    expect(getTier()).toBe('studio');
  });

  it('returns free when readFileSync throws', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('EACCES'); });
    expect(getTier()).toBe('free');
  });
});

// ---------------------------------------------------------------------------
// setTier — normalizes unknown tiers to free, swallows write errors
// ---------------------------------------------------------------------------
describe('setTier', () => {
  it('writes {tier, updatedAt} to the tier file for a valid tier', () => {
    setTier('pro');
    const written = JSON.parse(files[TIER_FILE]);
    expect(written.tier).toBe('pro');
    expect(typeof written.updatedAt).toBe('number');
    expect(Object.keys(written).sort()).toEqual(['tier', 'updatedAt']);
  });

  it('normalizes unknown tier to free', () => {
    setTier('enterprise-platinum');
    expect(JSON.parse(files[TIER_FILE]).tier).toBe('free');
  });

  it('normalizes undefined tier to free', () => {
    setTier(undefined);
    expect(JSON.parse(files[TIER_FILE]).tier).toBe('free');
  });

  it('swallows write errors (does not throw)', () => {
    // Production code logs and continues — pinned so a future refactor that
    // starts throwing here is caught (SSO handler relies on this not throwing).
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('EACCES'); });
    expect(() => setTier('pro')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getLimits — unknown tier falls back to free limits
// ---------------------------------------------------------------------------
describe('getLimits', () => {
  it.each(['free', 'starter', 'pro', 'studio'])('returns the matrix entry for %s', (tier) => {
    expect(getLimits(tier)).toEqual(TIER_LIMITS[tier]);
  });

  it('returns free limits for unknown tier', () => {
    expect(getLimits('vip')).toEqual(TIER_LIMITS.free);
  });

  it('returns free limits for undefined tier', () => {
    expect(getLimits(undefined)).toEqual(TIER_LIMITS.free);
  });
});

// ---------------------------------------------------------------------------
// isQualityAllowed — truth table across tiers and boundary presets
// ---------------------------------------------------------------------------
describe('isQualityAllowed', () => {
  it.each([
    // [preset, tier, expected]
    ['low', 'free', true],
    ['medium', 'free', true],      // free boundary: medium is the max
    ['high', 'free', false],       // first preset above free's max
    ['godmode', 'free', false],
    ['medium', 'starter', true],
    ['high', 'starter', false],
    ['kick', 'pro', true],         // pro boundary: kick is the max
    ['standard', 'pro', true],
    ['ultra', 'pro', false],       // first preset above pro's max
    ['godmode', 'pro', false],
    ['godmode', 'studio', true],   // studio: everything allowed
    ['low', 'studio', true]
  ])('preset %s on tier %s -> %s', (preset, tier, expected) => {
    expect(isQualityAllowed(preset, tier)).toBe(expected);
  });

  it('returns false for unknown preset on any tier', () => {
    expect(isQualityAllowed('imaginary', 'studio')).toBe(false);
    expect(isQualityAllowed('imaginary', 'free')).toBe(false);
  });

  it('uses tier from file when tier argument is omitted', () => {
    files[TIER_FILE] = JSON.stringify({ tier: 'free' });
    expect(isQualityAllowed('high')).toBe(false);
    files[TIER_FILE] = JSON.stringify({ tier: 'studio' });
    expect(isQualityAllowed('high')).toBe(true);
  });

  it('falls back to free limits when tier file is missing and tier omitted', () => {
    expect(isQualityAllowed('medium')).toBe(true);
    expect(isQualityAllowed('high')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isWithinPlatformLimit — boundary counts per tier
// ---------------------------------------------------------------------------
describe('isWithinPlatformLimit', () => {
  it.each([
    // [count, tier, expected]
    [1, 'free', true],
    [2, 'free', false],
    [1, 'starter', true],
    [2, 'starter', false],
    [3, 'pro', true],
    [4, 'pro', false],
    [3, 'studio', true],
    [4, 'studio', false],
    [0, 'free', true],
    [0, 'studio', true]
  ])('count %i on tier %s -> %s', (count, tier, expected) => {
    expect(isWithinPlatformLimit(count, tier)).toBe(expected);
  });

  it('uses tier from file when tier argument is omitted', () => {
    files[TIER_FILE] = JSON.stringify({ tier: 'pro' });
    expect(isWithinPlatformLimit(3)).toBe(true);
    files[TIER_FILE] = JSON.stringify({ tier: 'free' });
    expect(isWithinPlatformLimit(3)).toBe(false);
  });

  it('falls back to free limit (1) when tier file is missing and tier omitted', () => {
    expect(isWithinPlatformLimit(1)).toBe(true);
    expect(isWithinPlatformLimit(2)).toBe(false);
  });
});
