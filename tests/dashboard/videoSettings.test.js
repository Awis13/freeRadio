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

  it('treats a missing enhanced key as false (undefined !== true)', () => {
    files[VIDEO_FILE] = JSON.stringify({ timestamp: 5000 });
    expect(getVideoSettings().enhanced).toBe(false);
  });

  it('returns {enhanced:false} when readFileSync throws (swallowed catch)', () => {
    // existsSync says the file is present, but the read blows up -> the
    // empty catch swallows it and the default {enhanced:false} is returned.
    files[VIDEO_FILE] = JSON.stringify({ enhanced: true });
    fs.readFileSync.mockImplementationOnce(() => { throw new Error('EIO'); });
    expect(getVideoSettings().enhanced).toBe(false);
  });

  it('returns {enhanced:false} when existsSync throws (swallowed catch)', () => {
    fs.existsSync.mockImplementationOnce(() => { throw new Error('EACCES'); });
    expect(getVideoSettings().enhanced).toBe(false);
  });

  it('returns exactly the shape {enhanced} with no extra keys (timestamp dropped on read)', () => {
    files[VIDEO_FILE] = JSON.stringify({ enhanced: true, timestamp: 9999 });
    expect(getVideoSettings()).toEqual({ enhanced: true });
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

  it('stamps timestamp from Date.now()', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1234567890);
    const result = setVideoSettings({ enhanced: true });
    expect(result.timestamp).toBe(1234567890);
    expect(JSON.parse(files[VIDEO_FILE]).timestamp).toBe(1234567890);
    nowSpy.mockRestore();
  });

  it('writes a compact JSON string (no pretty-print) with both keys', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(42);
    setVideoSettings({ enhanced: true });
    // No indentation arg passed to JSON.stringify -> single-line output.
    expect(files[VIDEO_FILE]).toBe('{"enhanced":true,"timestamp":42}');
    nowSpy.mockRestore();
  });

  it('returns the same object that was serialized (enhanced + timestamp only)', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(7);
    const result = setVideoSettings({ enhanced: false });
    expect(result).toEqual({ enhanced: false, timestamp: 7 });
    nowSpy.mockRestore();
  });

  it('propagates a writeFileSync failure (no swallow on write path)', () => {
    fs.writeFileSync.mockImplementationOnce(() => { throw new Error('ENOSPC'); });
    expect(() => setVideoSettings({ enhanced: true })).toThrow('ENOSPC');
  });

  it('treats a missing enhanced key as false (undefined !== true)', () => {
    const result = setVideoSettings({});
    expect(result.enhanced).toBe(false);
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

  it('returns the exact enhancement filter chain when enabled', () => {
    files[VIDEO_FILE] = JSON.stringify({ enhanced: true });
    expect(getVideoEnhancementFilter()).toBe(
      'eq=saturation=1.15:contrast=1.03,unsharp=3:3:0.5,deband'
    );
  });

  it('returns null when enhanced is a truthy non-true value (strict equality upstream)', () => {
    files[VIDEO_FILE] = JSON.stringify({ enhanced: 'true' });
    expect(getVideoEnhancementFilter()).toBeNull();
  });

  it('returns null when the file read throws (swallowed -> default false)', () => {
    files[VIDEO_FILE] = JSON.stringify({ enhanced: true });
    fs.readFileSync.mockImplementationOnce(() => { throw new Error('EIO'); });
    expect(getVideoEnhancementFilter()).toBeNull();
  });
});
