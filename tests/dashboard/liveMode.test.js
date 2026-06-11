/**
 * tests/dashboard/liveMode.test.js
 *
 * Unit tests for dashboard/lib/liveMode.js — live mode configuration.
 * Tests: getLiveMode, setLiveMode, setObsStatus, regenerateIngestKey.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import crypto from 'crypto';

const LIVE_MODE_FILE = '/shared/live_mode.json';

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

const { getLiveMode, setLiveMode, setObsStatus, regenerateIngestKey } =
  await import('../../dashboard/lib/liveMode.js');

// ---------------------------------------------------------------------------
// getLiveMode
// ---------------------------------------------------------------------------
describe('getLiveMode', () => {
  it('returns defaults when no file exists', () => {
    const config = getLiveMode();
    expect(config.source).toBe('obs');
    expect(config.afkFallback).toBe('visual-radio');
    expect(config.obsStatus).toBe('offline');
  });

  it('generates an ingest key on first run', () => {
    const config = getLiveMode();
    expect(config.ingestKey).toBeDefined();
    expect(typeof config.ingestKey).toBe('string');
    expect(config.ingestKey.length).toBeGreaterThan(0);
  });

  it('persists defaults to file on first run', () => {
    getLiveMode();
    expect(files[LIVE_MODE_FILE]).toBeDefined();
    const written = JSON.parse(files[LIVE_MODE_FILE]);
    expect(written.source).toBe('obs');
  });

  it('returns defaults on corrupt JSON', () => {
    files[LIVE_MODE_FILE] = 'not json{{{';
    const config = getLiveMode();
    expect(config.source).toBe('obs');
    expect(config.afkFallback).toBe('visual-radio');
  });

  it('reads valid config from file', () => {
    files[LIVE_MODE_FILE] = JSON.stringify({
      source: 'browser-mic',
      afkFallback: 'video-playlist',
      obsStatus: 'connected',
      ingestKey: 'test-key-123',
      timestamp: 1000
    });
    const config = getLiveMode();
    expect(config.source).toBe('browser-mic');
    expect(config.afkFallback).toBe('video-playlist');
    expect(config.obsStatus).toBe('connected');
    expect(config.ingestKey).toBe('test-key-123');
  });

  it('falls back to obs for unknown source', () => {
    files[LIVE_MODE_FILE] = JSON.stringify({
      source: 'garbage',
      afkFallback: 'visual-radio',
      obsStatus: 'offline',
      ingestKey: 'key-1'
    });
    expect(getLiveMode().source).toBe('obs');
  });

  it('falls back to visual-radio for unknown afkFallback', () => {
    files[LIVE_MODE_FILE] = JSON.stringify({
      source: 'obs',
      afkFallback: 'nonsense',
      obsStatus: 'offline',
      ingestKey: 'key-1'
    });
    expect(getLiveMode().afkFallback).toBe('visual-radio');
  });

  it('generates ingest key when missing from file', () => {
    files[LIVE_MODE_FILE] = JSON.stringify({
      source: 'obs',
      afkFallback: 'visual-radio',
      obsStatus: 'offline'
    });
    const config = getLiveMode();
    expect(config.ingestKey).toBeDefined();
    expect(config.ingestKey.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// setLiveMode
// ---------------------------------------------------------------------------
describe('setLiveMode', () => {
  it('updates source to browser-mic', () => {
    const result = setLiveMode({ source: 'browser-mic' });
    expect(result.source).toBe('browser-mic');
  });

  it('updates afkFallback to video-playlist', () => {
    const result = setLiveMode({ afkFallback: 'video-playlist' });
    expect(result.afkFallback).toBe('video-playlist');
  });

  it('rejects invalid source and keeps current', () => {
    files[LIVE_MODE_FILE] = JSON.stringify({
      source: 'browser-mic',
      afkFallback: 'visual-radio',
      obsStatus: 'offline',
      ingestKey: 'key-1',
      timestamp: 1000
    });
    const result = setLiveMode({ source: 'invalid' });
    expect(result.source).toBe('browser-mic');
  });

  it('rejects invalid afkFallback and keeps current', () => {
    files[LIVE_MODE_FILE] = JSON.stringify({
      source: 'obs',
      afkFallback: 'video-playlist',
      obsStatus: 'offline',
      ingestKey: 'key-1',
      timestamp: 1000
    });
    const result = setLiveMode({ afkFallback: 'invalid' });
    expect(result.afkFallback).toBe('video-playlist');
  });

  it('preserves ingest key across updates', () => {
    files[LIVE_MODE_FILE] = JSON.stringify({
      source: 'obs',
      afkFallback: 'visual-radio',
      obsStatus: 'offline',
      ingestKey: 'stable-key-999',
      timestamp: 1000
    });
    const result = setLiveMode({ source: 'browser-mic' });
    expect(result.ingestKey).toBe('stable-key-999');
  });

  it('preserves obsStatus across updates', () => {
    files[LIVE_MODE_FILE] = JSON.stringify({
      source: 'obs',
      afkFallback: 'visual-radio',
      obsStatus: 'connected',
      ingestKey: 'key-1',
      timestamp: 1000
    });
    const result = setLiveMode({ source: 'browser-mic' });
    expect(result.obsStatus).toBe('connected');
  });

  it('uses atomic write via rename', () => {
    setLiveMode({ source: 'obs' });
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it('includes timestamp in written data', () => {
    setLiveMode({ source: 'obs' });
    const written = JSON.parse(files[LIVE_MODE_FILE]);
    expect(typeof written.timestamp).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// setObsStatus
// ---------------------------------------------------------------------------
describe('setObsStatus', () => {
  it('updates obsStatus', () => {
    files[LIVE_MODE_FILE] = JSON.stringify({
      source: 'obs',
      afkFallback: 'visual-radio',
      obsStatus: 'offline',
      ingestKey: 'key-1',
      timestamp: 1000
    });
    const result = setObsStatus('connected');
    expect(result.obsStatus).toBe('connected');
  });

  it('preserves other fields', () => {
    files[LIVE_MODE_FILE] = JSON.stringify({
      source: 'browser-mic',
      afkFallback: 'video-playlist',
      obsStatus: 'offline',
      ingestKey: 'key-abc',
      timestamp: 1000
    });
    const result = setObsStatus('connected');
    expect(result.source).toBe('browser-mic');
    expect(result.afkFallback).toBe('video-playlist');
    expect(result.ingestKey).toBe('key-abc');
  });
});

// ---------------------------------------------------------------------------
// regenerateIngestKey
// ---------------------------------------------------------------------------
describe('regenerateIngestKey', () => {
  it('returns a new ingest key', () => {
    files[LIVE_MODE_FILE] = JSON.stringify({
      source: 'obs',
      afkFallback: 'visual-radio',
      obsStatus: 'offline',
      ingestKey: 'old-key',
      timestamp: 1000
    });
    const result = regenerateIngestKey();
    expect(result.ingestKey).not.toBe('old-key');
  });

  it('persists the new key to file', () => {
    files[LIVE_MODE_FILE] = JSON.stringify({
      source: 'obs',
      afkFallback: 'visual-radio',
      obsStatus: 'offline',
      ingestKey: 'old-key',
      timestamp: 1000
    });
    regenerateIngestKey();
    const written = JSON.parse(files[LIVE_MODE_FILE]);
    expect(written.ingestKey).not.toBe('old-key');
  });

  it('preserves other fields after regeneration', () => {
    files[LIVE_MODE_FILE] = JSON.stringify({
      source: 'browser-mic',
      afkFallback: 'video-playlist',
      obsStatus: 'connected',
      ingestKey: 'old-key',
      timestamp: 1000
    });
    const result = regenerateIngestKey();
    expect(result.source).toBe('browser-mic');
    expect(result.afkFallback).toBe('video-playlist');
    expect(result.obsStatus).toBe('connected');
  });
});

// ---------------------------------------------------------------------------
// ingest key stability
// ---------------------------------------------------------------------------
describe('ingest key stability', () => {
  it('returns same key on consecutive reads', () => {
    const first = getLiveMode();
    const second = getLiveMode();
    expect(second.ingestKey).toBe(first.ingestKey);
  });

  it('persists key so subsequent calls return it', () => {
    const config = getLiveMode();
    const key = config.ingestKey;
    // Read back from persisted file
    const reread = getLiveMode();
    expect(reread.ingestKey).toBe(key);
  });
});
