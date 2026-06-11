/**
 * tests/dashboard/audioSettings.test.js
 *
 * Unit tests for dashboard/lib/audioSettings.js — audio enhancement settings.
 * Tests: getAudioSettings, setAudioSettings, getAudioFilter.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

const AUDIO_FILE = '/shared/stream_audio.json';

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

const { getAudioSettings, setAudioSettings, getAudioFilter } =
  await import('../../dashboard/lib/audioSettings.js');

// ---------------------------------------------------------------------------
// getAudioSettings
// ---------------------------------------------------------------------------
describe('getAudioSettings', () => {
  it('returns {enhanced:false} when no file exists', () => {
    expect(getAudioSettings().enhanced).toBe(false);
  });

  it('returns {enhanced:false} on corrupt JSON', () => {
    files[AUDIO_FILE] = 'not json{{{';
    expect(getAudioSettings().enhanced).toBe(false);
  });

  it('reads enhanced=true from valid file', () => {
    files[AUDIO_FILE] = JSON.stringify({ enhanced: true, timestamp: 1000 });
    expect(getAudioSettings().enhanced).toBe(true);
  });

  it('reads enhanced=false from valid file', () => {
    files[AUDIO_FILE] = JSON.stringify({ enhanced: false, timestamp: 1000 });
    expect(getAudioSettings().enhanced).toBe(false);
  });

  it('treats string "true" as false (strict equality)', () => {
    files[AUDIO_FILE] = JSON.stringify({ enhanced: 'true' });
    expect(getAudioSettings().enhanced).toBe(false);
  });

  it('treats numeric 1 as false (strict equality)', () => {
    files[AUDIO_FILE] = JSON.stringify({ enhanced: 1 });
    expect(getAudioSettings().enhanced).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// setAudioSettings
// ---------------------------------------------------------------------------
describe('setAudioSettings', () => {
  it('writes enhanced=true to file', () => {
    const result = setAudioSettings({ enhanced: true });
    expect(result.enhanced).toBe(true);
    const written = JSON.parse(files[AUDIO_FILE]);
    expect(written.enhanced).toBe(true);
  });

  it('writes enhanced=false to file', () => {
    const result = setAudioSettings({ enhanced: false });
    expect(result.enhanced).toBe(false);
    const written = JSON.parse(files[AUDIO_FILE]);
    expect(written.enhanced).toBe(false);
  });

  it('normalizes string "true" to false (strict equality)', () => {
    const result = setAudioSettings({ enhanced: 'true' });
    expect(result.enhanced).toBe(false);
  });

  it('includes timestamp in written data', () => {
    setAudioSettings({ enhanced: true });
    const written = JSON.parse(files[AUDIO_FILE]);
    expect(written.timestamp).toBeDefined();
    expect(typeof written.timestamp).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// getAudioFilter
// ---------------------------------------------------------------------------
describe('getAudioFilter', () => {
  it('returns null when enhanced is false', () => {
    expect(getAudioFilter()).toBeNull();
  });

  it('returns filter string when enhanced is true', () => {
    files[AUDIO_FILE] = JSON.stringify({ enhanced: true });
    const filter = getAudioFilter();
    expect(filter).toBeTypeOf('string');
    expect(filter).toContain('loudnorm');
  });

  it('returns null when no file exists', () => {
    expect(getAudioFilter()).toBeNull();
  });
});
