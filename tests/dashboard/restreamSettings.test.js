/**
 * tests/dashboard/restreamSettings.test.js
 *
 * Unit tests for dashboard/lib/restreamSettings.js — restream auto-start settings.
 * Tests: getSettings (default, corrupt, valid), setAutoStart (boolean normalization).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

const SETTINGS_FILE = '/shared/restream_settings.json';

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
  vi.spyOn(fs, 'renameSync').mockImplementation((src, dst) => {
    files[dst] = files[src];
    delete files[src];
  });
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
});

const { getSettings, setAutoStart } =
  await import('../../dashboard/lib/restreamSettings.js');

// ---------------------------------------------------------------------------
// getSettings
// ---------------------------------------------------------------------------
describe('getSettings', () => {
  it('returns {autoStart:false} when no file exists', () => {
    expect(getSettings().autoStart).toBe(false);
  });

  it('returns {autoStart:false} on corrupt JSON', () => {
    files[SETTINGS_FILE] = 'not json{{{';
    expect(getSettings().autoStart).toBe(false);
  });

  it('reads autoStart=true from valid file', () => {
    files[SETTINGS_FILE] = JSON.stringify({ autoStart: true, updatedAt: 1000 });
    expect(getSettings().autoStart).toBe(true);
  });

  it('reads autoStart=false from valid file', () => {
    files[SETTINGS_FILE] = JSON.stringify({ autoStart: false, updatedAt: 1000 });
    expect(getSettings().autoStart).toBe(false);
  });

  it('normalizes string "true" to true', () => {
    files[SETTINGS_FILE] = JSON.stringify({ autoStart: 'true' });
    expect(getSettings().autoStart).toBe(true);
  });

  it('normalizes numeric 1 to true', () => {
    files[SETTINGS_FILE] = JSON.stringify({ autoStart: 1 });
    expect(getSettings().autoStart).toBe(true);
  });

  it('normalizes string "1" to true', () => {
    files[SETTINGS_FILE] = JSON.stringify({ autoStart: '1' });
    expect(getSettings().autoStart).toBe(true);
  });

  it('normalizes string "false" to false', () => {
    files[SETTINGS_FILE] = JSON.stringify({ autoStart: 'false' });
    expect(getSettings().autoStart).toBe(false);
  });

  it('normalizes numeric 0 to false', () => {
    files[SETTINGS_FILE] = JSON.stringify({ autoStart: 0 });
    expect(getSettings().autoStart).toBe(false);
  });

  it('normalizes string "0" to false', () => {
    files[SETTINGS_FILE] = JSON.stringify({ autoStart: '0' });
    expect(getSettings().autoStart).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// setAutoStart
// ---------------------------------------------------------------------------
describe('setAutoStart', () => {
  it('writes autoStart=true to file', () => {
    const result = setAutoStart(true);
    expect(result.autoStart).toBe(true);
    const written = JSON.parse(files[SETTINGS_FILE]);
    expect(written.autoStart).toBe(true);
  });

  it('writes autoStart=false to file', () => {
    const result = setAutoStart(false);
    expect(result.autoStart).toBe(false);
    const written = JSON.parse(files[SETTINGS_FILE]);
    expect(written.autoStart).toBe(false);
  });

  it('normalizes string "true" to true', () => {
    const result = setAutoStart('true');
    expect(result.autoStart).toBe(true);
  });

  it('normalizes string "false" to false', () => {
    const result = setAutoStart('false');
    expect(result.autoStart).toBe(false);
  });

  it('normalizes numeric 1 to true', () => {
    const result = setAutoStart(1);
    expect(result.autoStart).toBe(true);
  });

  it('normalizes numeric 0 to false', () => {
    const result = setAutoStart(0);
    expect(result.autoStart).toBe(false);
  });

  it('normalizes string "1" to true', () => {
    const result = setAutoStart('1');
    expect(result.autoStart).toBe(true);
  });

  it('normalizes string "0" to false', () => {
    const result = setAutoStart('0');
    expect(result.autoStart).toBe(false);
  });

  it('uses atomic write via rename', () => {
    setAutoStart(true);
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it('includes updatedAt in written data', () => {
    setAutoStart(true);
    const written = JSON.parse(files[SETTINGS_FILE]);
    expect(written.updatedAt).toBeDefined();
    expect(typeof written.updatedAt).toBe('number');
  });
});
