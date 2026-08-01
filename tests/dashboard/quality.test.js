/**
 * tests/dashboard/quality.test.js
 *
 * Unit tests for dashboard/lib/quality.js — quality presets.
 * Tests: getQuality, setQuality, getPresets.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

const QUALITY_FILE = '/shared/stream_quality.json';
const TIER_FILE = '/shared/tier.json';
let files = {};

beforeEach(() => {
  files = {};
  // Set tier to 'studio' so all quality presets are allowed in tests
  files[TIER_FILE] = JSON.stringify({ tier: 'studio' });
  vi.restoreAllMocks();

  vi.spyOn(fs, 'existsSync').mockImplementation(p => p in files);
  vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
    if (p in files) return files[p];
    throw new Error('ENOENT');
  });
  vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
    files[p] = data;
  });
  // jsonStore writes <file>.tmp and renames it into place, so the mock fs has
  // to model the move (and tolerate the mkdir) or a store write vanishes.
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (from in files) {
      files[to] = files[from];
      delete files[from];
    }
  });
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});

});

const { getQuality, setQuality, getPresets } =
  await import('../../dashboard/lib/quality.js');

// ---------------------------------------------------------------------------
// getQuality
// ---------------------------------------------------------------------------
describe('getQuality', () => {
  it('returns high preset as default when no file exists', () => {
    const q = getQuality();
    expect(q.preset).toBe('high');
    expect(q.settings.name).toBe('High (1080p 6Mbps)');
  });

  it('reads preset from file', () => {
    files[QUALITY_FILE] = JSON.stringify({ preset: 'ultra' });
    const q = getQuality();
    expect(q.preset).toBe('ultra');
    expect(q.settings.videoBitrate).toBe('12000k');
  });

  it('falls back to high when file has unknown preset', () => {
    files[QUALITY_FILE] = JSON.stringify({ preset: 'nonexistent' });
    const q = getQuality();
    expect(q.settings.name).toBe('High (1080p 6Mbps)');
  });

  it('falls back to high on corrupt JSON', () => {
    files[QUALITY_FILE] = 'not json';
    const q = getQuality();
    expect(q.preset).toBe('high');
  });

  it('reads low preset correctly', () => {
    files[QUALITY_FILE] = JSON.stringify({ preset: 'low' });
    const q = getQuality();
    expect(q.preset).toBe('low');
    expect(q.settings.scale).toBe('854:480');
    expect(q.settings.videoBitrate).toBe('2000k');
  });

  it('reads godmode preset correctly', () => {
    files[QUALITY_FILE] = JSON.stringify({ preset: 'godmode' });
    const q = getQuality();
    expect(q.settings.forceVp9).toBe(true);
    expect(q.settings.scale).toBe('2560:1440');
  });
});

// ---------------------------------------------------------------------------
// setQuality
// ---------------------------------------------------------------------------
describe('setQuality', () => {
  it('writes preset to file', () => {
    const result = setQuality('standard');
    expect(result.preset).toBe('standard');
    expect(result.settings.scale).toBe('1920:1080');
    expect(files[QUALITY_FILE]).toBeDefined();
  });

  it('throws on invalid preset', () => {
    expect(() => setQuality('imaginary')).toThrow('Invalid preset');
  });

  it('includes timestamp in written data', () => {
    setQuality('medium');
    const written = JSON.parse(files[QUALITY_FILE]);
    expect(written.preset).toBe('medium');
    expect(written.timestamp).toBeDefined();
  });

  it('returns settings for the preset', () => {
    const result = setQuality('kick');
    expect(result.settings.name).toBe('Kick Safe (1080p 6Mbps)');
  });
});

// ---------------------------------------------------------------------------
// getPresets
// ---------------------------------------------------------------------------
describe('getPresets', () => {
  it('returns array of all presets', () => {
    const presets = getPresets();
    expect(presets.length).toBe(7);
  });

  it('each preset has key and name', () => {
    const presets = getPresets();
    presets.forEach(p => {
      expect(p.key).toBeDefined();
      expect(p.name).toBeDefined();
      expect(typeof p.key).toBe('string');
      expect(typeof p.name).toBe('string');
    });
  });

  it('includes all expected preset keys', () => {
    const keys = getPresets().map(p => p.key);
    expect(keys).toContain('godmode');
    expect(keys).toContain('ultra');
    expect(keys).toContain('high');
    expect(keys).toContain('standard');
    expect(keys).toContain('kick');
    expect(keys).toContain('medium');
    expect(keys).toContain('low');
  });
});
