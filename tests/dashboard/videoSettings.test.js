/**
 * tests/dashboard/videoSettings.test.js
 *
 * Unit tests for dashboard/lib/videoSettings.js — video enhancement settings.
 * Tests: getVideoSettings, setVideoSettings, getVideoEnhancementFilter.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

const VIDEO_FILE = '/shared/stream_video.json';

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

const { getVideoSettings, setVideoSettings, getVideoEnhancementFilter } =
  await import('../../dashboard/lib/videoSettings.js');

// ---------------------------------------------------------------------------
// getVideoSettings
// ---------------------------------------------------------------------------
describe('getVideoSettings', () => {
  it('returns {enhanced:false} when no file exists', () => {
    expect(getVideoSettings().enhanced).toBe(false);
  });

  it('returns {enhanced:false} on corrupt JSON', () => {
    files[VIDEO_FILE] = 'not json{{{';
    expect(getVideoSettings().enhanced).toBe(false);
  });

  it('reads enhanced=true from valid file', () => {
    files[VIDEO_FILE] = JSON.stringify({ enhanced: true, timestamp: 1000 });
    expect(getVideoSettings().enhanced).toBe(true);
  });

  it('reads enhanced=false from valid file', () => {
    files[VIDEO_FILE] = JSON.stringify({ enhanced: false, timestamp: 1000 });
    expect(getVideoSettings().enhanced).toBe(false);
  });

  it('treats string "true" as false (strict equality)', () => {
    files[VIDEO_FILE] = JSON.stringify({ enhanced: 'true' });
    expect(getVideoSettings().enhanced).toBe(false);
  });

  it('treats numeric 1 as false (strict equality)', () => {
    files[VIDEO_FILE] = JSON.stringify({ enhanced: 1 });
    expect(getVideoSettings().enhanced).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// setVideoSettings
// ---------------------------------------------------------------------------
describe('setVideoSettings', () => {
  it('writes enhanced=true to file', () => {
    const result = setVideoSettings({ enhanced: true });
    expect(result.enhanced).toBe(true);
    const written = JSON.parse(files[VIDEO_FILE]);
    expect(written.enhanced).toBe(true);
  });

  it('writes enhanced=false to file', () => {
    const result = setVideoSettings({ enhanced: false });
    expect(result.enhanced).toBe(false);
    const written = JSON.parse(files[VIDEO_FILE]);
    expect(written.enhanced).toBe(false);
  });

  it('normalizes string "true" to false (strict equality)', () => {
    const result = setVideoSettings({ enhanced: 'true' });
    expect(result.enhanced).toBe(false);
  });

  it('includes timestamp in written data', () => {
    setVideoSettings({ enhanced: true });
    const written = JSON.parse(files[VIDEO_FILE]);
    expect(written.timestamp).toBeDefined();
    expect(typeof written.timestamp).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// getVideoEnhancementFilter
// ---------------------------------------------------------------------------
describe('getVideoEnhancementFilter', () => {
  it('returns null when enhanced is false', () => {
    expect(getVideoEnhancementFilter()).toBeNull();
  });

  it('returns filter string when enhanced is true', () => {
    files[VIDEO_FILE] = JSON.stringify({ enhanced: true });
    const filter = getVideoEnhancementFilter();
    expect(filter).toBeTypeOf('string');
    expect(filter).toContain('eq=');
  });

  it('returns null when no file exists', () => {
    expect(getVideoEnhancementFilter()).toBeNull();
  });
});
