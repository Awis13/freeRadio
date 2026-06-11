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
});
