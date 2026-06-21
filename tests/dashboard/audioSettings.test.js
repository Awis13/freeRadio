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

  it('treats missing enhanced key as false (undefined !== true)', () => {
    // pinned as-is: file present but no `enhanced` field -> defaults to false
    files[AUDIO_FILE] = JSON.stringify({ timestamp: 1000 });
    expect(getAudioSettings()).toEqual({ enhanced: false });
  });

  it('returns ONLY {enhanced} from a valid file, dropping all other keys', () => {
    // pinned as-is: timestamp / extra fields are not echoed back on read
    files[AUDIO_FILE] = JSON.stringify({ enhanced: true, timestamp: 1000, extra: 'x' });
    expect(getAudioSettings()).toEqual({ enhanced: true });
  });

  it('swallows a readFileSync throw and returns the default', () => {
    // pinned as-is: existsSync true but read throws -> catch swallows -> {enhanced:false}
    files[AUDIO_FILE] = 'present';
    fs.readFileSync.mockImplementationOnce(() => {
      throw new Error('EIO');
    });
    expect(getAudioSettings()).toEqual({ enhanced: false });
  });

  it('swallows an existsSync throw and returns the default', () => {
    // pinned as-is: existsSync itself throwing is also caught -> {enhanced:false}
    fs.existsSync.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    expect(getAudioSettings()).toEqual({ enhanced: false });
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

  it('stamps timestamp from Date.now()', () => {
    // pinned as-is: timestamp is taken from Date.now() at write time
    vi.spyOn(Date, 'now').mockReturnValue(123456789);
    const result = setAudioSettings({ enhanced: false });
    expect(result.timestamp).toBe(123456789);
    expect(JSON.parse(files[AUDIO_FILE]).timestamp).toBe(123456789);
  });

  it('returns the exact same object that was written (enhanced + timestamp only)', () => {
    // pinned as-is: return value === the data object, no extra keys, no `path`
    vi.spyOn(Date, 'now').mockReturnValue(999);
    const result = setAudioSettings({ enhanced: true, ignored: 'nope' });
    expect(result).toEqual({ enhanced: true, timestamp: 999 });
  });

  it('writes to the hard-coded /shared/stream_audio.json path', () => {
    // pinned as-is: target path is a module constant, not configurable
    setAudioSettings({ enhanced: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/shared/stream_audio.json',
      expect.any(String)
    );
  });

  it('serializes compactly (no indentation)', () => {
    // pinned as-is: JSON.stringify called without a spacer arg
    vi.spyOn(Date, 'now').mockReturnValue(7);
    setAudioSettings({ enhanced: true });
    expect(files[AUDIO_FILE]).toBe('{"enhanced":true,"timestamp":7}');
  });

  it('propagates a writeFileSync throw (no try/catch around the write)', () => {
    // pinned as-is: setAudioSettings does NOT swallow write errors
    fs.writeFileSync.mockImplementationOnce(() => {
      throw new Error('EROFS');
    });
    expect(() => setAudioSettings({ enhanced: true })).toThrow('EROFS');
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

  it('returns the exact enhancement filter constant verbatim', () => {
    // pinned as-is: the precise ffmpeg filter chain currently shipped
    files[AUDIO_FILE] = JSON.stringify({ enhanced: true });
    expect(getAudioFilter()).toBe(
      'loudnorm=I=-14:TP=-1.5:LRA=11,mcompand=0.005,0.1 6.3--0.003,0.05 6.3--0.002,0.05 6.3,highpass=f=40,lowpass=f=18000'
    );
  });

  it('returns null when enhanced is a truthy-but-not-true value', () => {
    // pinned as-is: getAudioFilter inherits strict === true via getAudioSettings
    files[AUDIO_FILE] = JSON.stringify({ enhanced: 'true' });
    expect(getAudioFilter()).toBeNull();
  });

  it('returns null when getAudioSettings hits its swallowed catch', () => {
    // pinned as-is: read error -> default {enhanced:false} -> null filter
    files[AUDIO_FILE] = 'present';
    fs.readFileSync.mockImplementationOnce(() => {
      throw new Error('EIO');
    });
    expect(getAudioFilter()).toBeNull();
  });
});
