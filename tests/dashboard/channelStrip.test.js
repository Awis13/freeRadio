/**
 * tests/dashboard/channelStrip.test.js
 *
 * Unit tests for dashboard/lib/channelStrip.js — audio channel strip.
 * Tests: validateConfig, PARAM_RANGES, DEFAULTS, PRESETS, saveConfig, loadConfig.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

const CONFIG_PATH = '/shared/channel_strip.json';
let files = {};

vi.mock('../../dashboard/lib/liqClient', () => ({
  default: {
    getStripConfig: vi.fn().mockResolvedValue({ data: {} }),
    setStripConfig: vi.fn().mockResolvedValue({ data: { ok: true } }),
    getStripMetering: vi.fn().mockResolvedValue({ data: {} })
  }
}));

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

const { validateConfig, PARAM_RANGES, DEFAULTS, PRESETS, saveConfig, loadConfig } =
  await import('../../dashboard/lib/channelStrip.js');

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------
describe('validateConfig', () => {
  it('clamps numeric values to min/max range', () => {
    const result = validateConfig({
      gate_threshold: -100, // min is -80
      comp_ratio: 50       // max is 20
    });
    expect(result.gate_threshold).toBe(-80);
    expect(result.comp_ratio).toBe(20);
  });

  it('passes values within range unchanged', () => {
    const result = validateConfig({
      gate_threshold: -30,
      comp_ratio: 4,
      output_gain: 2
    });
    expect(result.gate_threshold).toBe(-30);
    expect(result.comp_ratio).toBe(4);
    expect(result.output_gain).toBe(2);
  });

  it('handles bypass as boolean', () => {
    const result = validateConfig({ bypass: true });
    expect(result.bypass).toBe(true);
  });

  it('coerces falsy bypass to false', () => {
    const result = validateConfig({ bypass: 0 });
    expect(result.bypass).toBe(false);
  });

  it('coerces truthy bypass to true', () => {
    const result = validateConfig({ bypass: 1 });
    expect(result.bypass).toBe(true);
  });

  it('ignores unknown parameters', () => {
    const result = validateConfig({ unknown_param: 42, gate_threshold: -20 });
    expect(result.unknown_param).toBeUndefined();
    expect(result.gate_threshold).toBe(-20);
  });

  it('skips NaN values', () => {
    const result = validateConfig({ comp_ratio: 'not_a_number' });
    expect(result.comp_ratio).toBeUndefined();
  });

  it('handles string numbers by parsing', () => {
    const result = validateConfig({ comp_ratio: '5.5' });
    expect(result.comp_ratio).toBe(5.5);
  });

  it('returns empty object for all-unknown input', () => {
    const result = validateConfig({ foo: 1, bar: 2 });
    expect(Object.keys(result).length).toBe(0);
  });

  it('handles edge: value at exact min boundary', () => {
    const result = validateConfig({ gate_threshold: -80 });
    expect(result.gate_threshold).toBe(-80);
  });

  it('handles edge: value at exact max boundary', () => {
    const result = validateConfig({ gate_threshold: 0 });
    expect(result.gate_threshold).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PARAM_RANGES
// ---------------------------------------------------------------------------
describe('PARAM_RANGES', () => {
  it('has range for every DEFAULTS key', () => {
    for (const key of Object.keys(DEFAULTS)) {
      expect(PARAM_RANGES[key]).toBeDefined();
    }
  });

  it('has valid min < max for all numeric ranges', () => {
    for (const [key, range] of Object.entries(PARAM_RANGES)) {
      if (range.type === 'bool') continue;
      expect(range.min).toBeLessThanOrEqual(range.max);
    }
  });
});

// ---------------------------------------------------------------------------
// DEFAULTS
// ---------------------------------------------------------------------------
describe('DEFAULTS', () => {
  it('has bypass set to true', () => {
    expect(DEFAULTS.bypass).toBe(true);
  });

  it('all numeric defaults are within their ranges', () => {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      const range = PARAM_RANGES[key];
      if (range.type === 'bool') continue;
      expect(value).toBeGreaterThanOrEqual(range.min);
      expect(value).toBeLessThanOrEqual(range.max);
    }
  });
});

// ---------------------------------------------------------------------------
// PRESETS
// ---------------------------------------------------------------------------
describe('PRESETS', () => {
  it('has bypass preset', () => {
    expect(PRESETS.bypass).toBeDefined();
    expect(PRESETS.bypass.bypass).toBe(true);
  });

  it('all presets have all DEFAULTS keys', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      for (const key of Object.keys(DEFAULTS)) {
        expect(preset[key]).toBeDefined();
      }
    }
  });

  it('all preset values are within valid ranges', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      for (const [key, value] of Object.entries(preset)) {
        const range = PARAM_RANGES[key];
        if (!range || range.type === 'bool') continue;
        expect(value).toBeGreaterThanOrEqual(range.min);
        expect(value).toBeLessThanOrEqual(range.max);
      }
    }
  });

  it('has expected preset names', () => {
    expect(Object.keys(PRESETS)).toContain('bypass');
    expect(Object.keys(PRESETS)).toContain('clean_voice');
    expect(Object.keys(PRESETS)).toContain('warm_radio');
    expect(Object.keys(PRESETS)).toContain('podcast');
    expect(Object.keys(PRESETS)).toContain('lo_fi');
  });
});

// ---------------------------------------------------------------------------
// saveConfig / loadConfig
// ---------------------------------------------------------------------------
describe('saveConfig', () => {
  it('writes config to JSON file', () => {
    saveConfig({ bypass: true, comp_ratio: 4 });
    expect(files[CONFIG_PATH]).toBeDefined();
    const saved = JSON.parse(files[CONFIG_PATH]);
    expect(saved.comp_ratio).toBe(4);
  });
});

describe('loadConfig', () => {
  it('returns null when no file exists', () => {
    expect(loadConfig()).toBeNull();
  });

  it('reads config from file', () => {
    files[CONFIG_PATH] = JSON.stringify({ bypass: false, comp_ratio: 6 });
    const config = loadConfig();
    expect(config.bypass).toBe(false);
    expect(config.comp_ratio).toBe(6);
  });

  it('returns null on corrupt JSON', () => {
    files[CONFIG_PATH] = 'broken';
    expect(loadConfig()).toBeNull();
  });
});
