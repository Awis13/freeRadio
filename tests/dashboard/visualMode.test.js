/**
 * tests/dashboard/visualMode.test.js
 *
 * Unit tests for dashboard/lib/visualMode.js — visual mode state management.
 * Tests: getVisualMode, setVisualMode.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

const VISUAL_MODE_FILE = '/shared/visual_mode.json';

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

const { getVisualMode, setVisualMode } =
  await import('../../dashboard/lib/visualMode.js');

// ---------------------------------------------------------------------------
// getVisualMode
// ---------------------------------------------------------------------------
describe('getVisualMode', () => {
  it('returns visual-radio as default when no file exists', () => {
    expect(getVisualMode().mode).toBe('visual-radio');
  });

  it('returns visual-radio on corrupt JSON', () => {
    files[VISUAL_MODE_FILE] = 'not json{{{';
    expect(getVisualMode().mode).toBe('visual-radio');
  });

  it('migrates legacy radio mode to live', () => {
    files[VISUAL_MODE_FILE] = JSON.stringify({ mode: 'radio' });
    expect(getVisualMode().mode).toBe('live');
  });

  it('reads live mode from file', () => {
    files[VISUAL_MODE_FILE] = JSON.stringify({ mode: 'live' });
    expect(getVisualMode().mode).toBe('live');
  });

  it('reads visual-radio mode from file', () => {
    files[VISUAL_MODE_FILE] = JSON.stringify({ mode: 'visual-radio' });
    expect(getVisualMode().mode).toBe('visual-radio');
  });

  it('reads video-playlist mode from file', () => {
    files[VISUAL_MODE_FILE] = JSON.stringify({ mode: 'video-playlist' });
    expect(getVisualMode().mode).toBe('video-playlist');
  });

  it('falls back to visual-radio for unknown mode', () => {
    files[VISUAL_MODE_FILE] = JSON.stringify({ mode: 'garbage' });
    expect(getVisualMode().mode).toBe('visual-radio');
  });

  it('falls back to visual-radio when file has no mode key', () => {
    // QUIRK: a valid JSON object lacking `mode` yields parsed.mode === undefined,
    // which is not in VALID_MODES, so the default visual-radio is returned.
    files[VISUAL_MODE_FILE] = JSON.stringify({ other: 'x' });
    expect(getVisualMode().mode).toBe('visual-radio');
  });

  it('swallows readFileSync errors and returns visual-radio default', () => {
    // existsSync says the file is present, but readFileSync throws — the catch
    // block swallows it and the trailing default is returned.
    files[VISUAL_MODE_FILE] = JSON.stringify({ mode: 'live' });
    fs.readFileSync.mockImplementation(() => { throw new Error('boom'); });
    expect(getVisualMode().mode).toBe('visual-radio');
  });

  it('returns only a mode property (no timestamp passthrough on read)', () => {
    // QUIRK: even if the stored file carries a timestamp, getVisualMode returns
    // an object with ONLY a `mode` key — timestamp is dropped on read.
    files[VISUAL_MODE_FILE] = JSON.stringify({ mode: 'live', timestamp: 123 });
    const result = getVisualMode();
    expect(result).toEqual({ mode: 'live' });
    expect(result.timestamp).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// setVisualMode
// ---------------------------------------------------------------------------
describe('setVisualMode', () => {
  it('writes live mode to file', () => {
    const result = setVisualMode('live');
    expect(result.mode).toBe('live');
    expect(files[VISUAL_MODE_FILE]).toBeDefined();
  });

  it('writes visual-radio mode to file', () => {
    const result = setVisualMode('visual-radio');
    expect(result.mode).toBe('visual-radio');
  });

  it('writes video-playlist mode to file', () => {
    const result = setVisualMode('video-playlist');
    expect(result.mode).toBe('video-playlist');
  });

  it('migrates legacy radio mode to live on set', () => {
    const result = setVisualMode('radio');
    expect(result.mode).toBe('live');
  });

  it('rejects invalid mode and keeps current', () => {
    files[VISUAL_MODE_FILE] = JSON.stringify({ mode: 'live' });
    const result = setVisualMode('nonsense');
    expect(result.mode).toBe('live');
  });

  it('uses atomic write via rename', () => {
    setVisualMode('live');
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it('includes timestamp in written data', () => {
    setVisualMode('live');
    const written = JSON.parse(files[VISUAL_MODE_FILE]);
    expect(written.timestamp).toBeDefined();
    expect(typeof written.timestamp).toBe('number');
  });

  it('writes correct JSON structure', () => {
    setVisualMode('video-playlist');
    const written = JSON.parse(files[VISUAL_MODE_FILE]);
    expect(written.mode).toBe('video-playlist');
  });

  it('falls back to current default visual-radio for invalid mode when no file exists', () => {
    // QUIRK: with no existing file, getVisualMode() returns visual-radio, so an
    // invalid requested mode is persisted as visual-radio (current.mode).
    const result = setVisualMode('bogus');
    expect(result.mode).toBe('visual-radio');
    expect(JSON.parse(files[VISUAL_MODE_FILE]).mode).toBe('visual-radio');
  });

  it('keeps visual-radio when the stored current mode was itself invalid', () => {
    // The existing file holds an unknown mode 'garbage'; getVisualMode sanitizes
    // it to visual-radio, so setting another invalid mode keeps visual-radio.
    files[VISUAL_MODE_FILE] = JSON.stringify({ mode: 'garbage' });
    const result = setVisualMode('alsoBad');
    expect(result.mode).toBe('visual-radio');
  });

  it('migrates legacy radio then validates (radio is set as live even if live were invalid)', () => {
    // 'radio' is rewritten to 'live' BEFORE the VALID_MODES check, so it always
    // passes validation regardless of the current stored mode.
    files[VISUAL_MODE_FILE] = JSON.stringify({ mode: 'video-playlist' });
    const result = setVisualMode('radio');
    expect(result.mode).toBe('live');
  });

  it('writes via tmp file first then renames over the target', () => {
    // Atomic write: tmp path is `${VISUAL_MODE_FILE}.tmp`; after rename the tmp
    // key no longer exists in the mock fs and the target holds the payload.
    setVisualMode('live');
    expect(files[`${VISUAL_MODE_FILE}.tmp`]).toBeUndefined();
    expect(files[VISUAL_MODE_FILE]).toBeDefined();
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      `${VISUAL_MODE_FILE}.tmp`,
      expect.any(String),
    );
  });

  it('creates the parent directory recursively before writing', () => {
    setVisualMode('live');
    expect(fs.mkdirSync).toHaveBeenCalledWith('/shared', { recursive: true });
  });

  it('returns the parsed payload including the timestamp (set echoes timestamp)', () => {
    // QUIRK asymmetry: setVisualMode returns the FULL payload (mode + timestamp),
    // unlike getVisualMode which returns only { mode }.
    const result = setVisualMode('live');
    expect(result.mode).toBe('live');
    expect(typeof result.timestamp).toBe('number');
  });
});
