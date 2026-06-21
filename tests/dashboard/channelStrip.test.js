/**
 * tests/dashboard/channelStrip.test.js
 *
 * Unit tests for dashboard/lib/channelStrip.js — audio channel strip.
 * Tests: validateConfig, PARAM_RANGES, DEFAULTS, PRESETS, saveConfig, loadConfig.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import { createRequire } from 'module';

// channelStrip uses CJS `require('./liqClient')` — the ESM vi.mock below does not
// intercept that require path, so for the async API we spy on the SAME shared CJS
// instance (sibling idiom: voice.test.js / mixing.test.js).
const nodeRequire = createRequire(import.meta.url);
const liqClient = nodeRequire('../../dashboard/lib/liqClient');

const CONFIG_PATH = '/shared/channel_strip.json';
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
  validateConfig, PARAM_RANGES, DEFAULTS, PRESETS, saveConfig, loadConfig,
  getConfig, setConfig, setPreset, getMetering
} = await import('../../dashboard/lib/channelStrip.js');

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

// ---------------------------------------------------------------------------
// saveConfig — error path (pinned as-is)
// ---------------------------------------------------------------------------
describe('saveConfig error path', () => {
  it('swallows write errors and logs to console.error (does not throw)', () => {
    // writeFileSync is spied in beforeEach; override it to throw for this test.
    fs.writeFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // pinned as-is: catch swallows the error, returns undefined, never re-throws.
    let r;
    expect(() => { r = saveConfig({ bypass: true }); }).not.toThrow();
    expect(r).toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith('[channel-strip] save error:', 'disk full');
  });
});

// ---------------------------------------------------------------------------
// getConfig — async API
// ---------------------------------------------------------------------------
describe('getConfig', () => {
  it('returns res.data from liqClient.getStripConfig', async () => {
    const spy = vi.spyOn(liqClient, 'getStripConfig')
      .mockResolvedValue({ data: { bypass: false, comp_ratio: 3 } });
    const result = await getConfig();
    expect(result).toEqual({ bypass: false, comp_ratio: 3 });
    expect(spy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getMetering — async API
// ---------------------------------------------------------------------------
describe('getMetering', () => {
  it('returns res.data from liqClient.getStripMetering', async () => {
    const spy = vi.spyOn(liqClient, 'getStripMetering')
      .mockResolvedValue({ data: { peak: -3.2 } });
    const result = await getMetering();
    expect(result).toEqual({ peak: -3.2 });
    expect(spy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// setConfig — async API
// ---------------------------------------------------------------------------
describe('setConfig', () => {
  it('returns {ok:false} when no valid params, without calling liqClient', async () => {
    const setSpy = vi.spyOn(liqClient, 'setStripConfig').mockResolvedValue({ data: {} });
    // pinned as-is: all-unknown input -> validated is empty -> early return, no liq call.
    const result = await setConfig({ unknown_param: 1 });
    expect(result).toEqual({ ok: false, error: 'no valid params' });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('validates/clamps params, sends to liqClient, and returns setStripConfig res.data', async () => {
    const setSpy = vi.spyOn(liqClient, 'setStripConfig')
      .mockResolvedValue({ data: { ok: true, applied: 1 } });
    // getStripConfig used to fetch full config for persistence.
    vi.spyOn(liqClient, 'getStripConfig')
      .mockResolvedValue({ data: { bypass: false, comp_ratio: 20 } });

    // comp_ratio 50 is above max 20 -> clamped to 20 before send (pinned as-is).
    const result = await setConfig({ comp_ratio: 50, unknown_param: 'x' });

    expect(setSpy).toHaveBeenCalledWith({ comp_ratio: 20 });
    // return value is setStripConfig's res.data (the SET response), not the fetched full config.
    expect(result).toEqual({ ok: true, applied: 1 });
  });

  it('persists the full config fetched from liqClient to file when fullConfig.data is present', async () => {
    vi.spyOn(liqClient, 'setStripConfig').mockResolvedValue({ data: { ok: true } });
    vi.spyOn(liqClient, 'getStripConfig')
      .mockResolvedValue({ data: { bypass: true, comp_ratio: 4 } });

    await setConfig({ comp_ratio: 4 });

    // pinned as-is: file holds the full config from getStripConfig, not the partial input.
    expect(files[CONFIG_PATH]).toBeDefined();
    const saved = JSON.parse(files[CONFIG_PATH]);
    expect(saved).toEqual({ bypass: true, comp_ratio: 4 });
  });

  it('does NOT write file when fullConfig.data is falsy', async () => {
    vi.spyOn(liqClient, 'setStripConfig').mockResolvedValue({ data: { ok: true } });
    vi.spyOn(liqClient, 'getStripConfig').mockResolvedValue({ data: null });

    await setConfig({ comp_ratio: 4 });

    // pinned as-is: `if (fullConfig.data)` guard skips saveConfig when data is null.
    expect(files[CONFIG_PATH]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// setPreset — async API
// ---------------------------------------------------------------------------
describe('setPreset', () => {
  it('returns error object for unknown preset, without calling liqClient', async () => {
    const setSpy = vi.spyOn(liqClient, 'setStripConfig').mockResolvedValue({ data: {} });
    // pinned as-is: error message interpolates the name with no quoting.
    const result = await setPreset('does_not_exist');
    expect(result).toEqual({ ok: false, error: 'unknown preset: does_not_exist' });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('sends the preset object to liqClient and saves it to file', async () => {
    const setSpy = vi.spyOn(liqClient, 'setStripConfig')
      .mockResolvedValue({ data: { ok: true, n: 5 } });

    const result = await setPreset('clean_voice');

    // pinned as-is: the raw PRESETS object is sent (not validated/clamped).
    expect(setSpy).toHaveBeenCalledWith(PRESETS.clean_voice);
    // file holds the preset object itself.
    const saved = JSON.parse(files[CONFIG_PATH]);
    expect(saved).toEqual(PRESETS.clean_voice);
    // return shape wraps liq res.data under `data`.
    expect(result).toEqual({ ok: true, preset: 'clean_voice', data: { ok: true, n: 5 } });
  });

  it('handles the bypass preset name', async () => {
    const setSpy = vi.spyOn(liqClient, 'setStripConfig').mockResolvedValue({ data: {} });
    const result = await setPreset('bypass');
    expect(result.ok).toBe(true);
    expect(result.preset).toBe('bypass');
    expect(setSpy).toHaveBeenCalledWith(PRESETS.bypass);
  });
});
