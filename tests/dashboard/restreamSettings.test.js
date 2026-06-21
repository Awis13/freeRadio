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

  // pinned as-is: missing autoStart key -> normalizeAutoStart(undefined) -> false
  it('returns autoStart:false when key is absent from valid JSON', () => {
    files[SETTINGS_FILE] = JSON.stringify({ updatedAt: 1000 });
    expect(getSettings().autoStart).toBe(false);
  });

  // pinned as-is: the returned object is shaped {autoStart} ONLY; updatedAt from
  // the file is dropped and never re-exposed by getSettings.
  it('drops updatedAt from the returned object (only exposes autoStart)', () => {
    files[SETTINGS_FILE] = JSON.stringify({ autoStart: true, updatedAt: 1000 });
    const result = getSettings();
    expect(Object.keys(result)).toEqual(['autoStart']);
    expect(result.updatedAt).toBeUndefined();
  });

  // pinned as-is: existsSync true but readFileSync throws -> catch swallows and
  // falls back to the safe default rather than propagating the error.
  it('falls back to default when existsSync is true but readFileSync throws', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockImplementation(() => { throw new Error('EIO'); });
    expect(() => getSettings()).not.toThrow();
    expect(getSettings().autoStart).toBe(false);
  });

  // pinned as-is: truthy non-canonical values (e.g. string "yes", number 2) are
  // NOT recognized by normalizeAutoStart and normalize to false.
  it('normalizes unrecognized truthy values to false', () => {
    files[SETTINGS_FILE] = JSON.stringify({ autoStart: 'yes' });
    expect(getSettings().autoStart).toBe(false);
    files[SETTINGS_FILE] = JSON.stringify({ autoStart: 2 });
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

  // pinned as-is: updatedAt is sourced from Date.now() at write time.
  it('stamps updatedAt with the current Date.now() value', () => {
    const now = 1717000000000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    setAutoStart(true);
    const written = JSON.parse(files[SETTINGS_FILE]);
    expect(written.updatedAt).toBe(now);
  });

  // pinned as-is: write is atomic via a sibling ".tmp" path that is created,
  // written, then renamed onto the final SETTINGS_FILE. The tmp file does not
  // linger after the rename.
  it('writes to "<file>.tmp" then renames onto the final file', () => {
    setAutoStart(true);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      `${SETTINGS_FILE}.tmp`,
      expect.any(String)
    );
    expect(fs.renameSync).toHaveBeenCalledWith(
      `${SETTINGS_FILE}.tmp`,
      SETTINGS_FILE
    );
    expect(`${SETTINGS_FILE}.tmp` in files).toBe(false);
    expect(SETTINGS_FILE in files).toBe(true);
  });

  // pinned as-is: the parent directory is ensured via mkdirSync(recursive:true)
  // on dirname(SETTINGS_FILE) before any write.
  it('ensures the parent directory with mkdirSync recursive', () => {
    setAutoStart(true);
    expect(fs.mkdirSync).toHaveBeenCalledWith('/shared', { recursive: true });
  });

  // pinned as-is: the written payload contains ONLY autoStart + updatedAt;
  // setAutoStart does not persist any extra/passthrough fields.
  it('persists only autoStart and updatedAt keys', () => {
    setAutoStart(true);
    const written = JSON.parse(files[SETTINGS_FILE]);
    expect(Object.keys(written).sort()).toEqual(['autoStart', 'updatedAt']);
  });

  // pinned as-is: the object returned by setAutoStart is the {autoStart} shape
  // (no updatedAt) — the timestamp lives only in the persisted file.
  it('returns only {autoStart} (without updatedAt) to the caller', () => {
    const result = setAutoStart(true);
    expect(Object.keys(result)).toEqual(['autoStart']);
    expect(result.updatedAt).toBeUndefined();
  });

  // pinned as-is: unrecognized truthy values normalize to false on the write path too.
  it('normalizes unrecognized truthy input to false when writing', () => {
    const result = setAutoStart('yes');
    expect(result.autoStart).toBe(false);
    const written = JSON.parse(files[SETTINGS_FILE]);
    expect(written.autoStart).toBe(false);
  });
});
