/**
 * tests/dashboard/streamKeys.test.js
 *
 * Unit tests for dashboard/lib/streamKeys.js — encrypted RTMP key management.
 * Tests: setPlatform/getPlatformConfig roundtrip, getPlatforms (key masking),
 * setPlatformEnabled, deletePlatform, getEnabledRtmpUrls (URL building).
 *
 * encrypt/decrypt and buildRtmpUrl are internal — tested through public API.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

const KEYS_FILE = '/shared/stream_keys.enc';
let files = {};

beforeEach(() => {
  files = {};
  vi.restoreAllMocks();

  // Ensure consistent encryption key
  process.env.STREAM_KEYS_SECRET = 'test-secret-for-vitest';

  vi.spyOn(fs, 'existsSync').mockImplementation(p => p in files);
  vi.spyOn(fs, 'readFileSync').mockImplementation((p, encoding) => {
    if (p in files) return files[p];
    throw new Error('ENOENT');
  });
  vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
    files[p] = data;
  });
});

const {
  getPlatforms,
  getPlatformConfig,
  setPlatform,
  setPlatformEnabled,
  deletePlatform,
  getEnabledRtmpUrls
} = await import('../../dashboard/lib/streamKeys.js');

// ---------------------------------------------------------------------------
// setPlatform + getPlatformConfig — encrypt/decrypt roundtrip
// ---------------------------------------------------------------------------
describe('setPlatform + getPlatformConfig', () => {
  it('stores and retrieves platform config', () => {
    setPlatform('youtube', {
      enabled: true,
      streamKey: 'abc-123-def',
      rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2'
    });

    const config = getPlatformConfig('youtube');
    expect(config.streamKey).toBe('abc-123-def');
    expect(config.rtmpUrl).toBe('rtmp://a.rtmp.youtube.com/live2');
    expect(config.enabled).toBe(true);
  });

  it('encrypts data in the file', () => {
    setPlatform('test', { enabled: true, streamKey: 'secret', rtmpUrl: 'rtmp://test.com' });
    // File should contain encrypted data, not plaintext
    expect(files[KEYS_FILE]).toBeDefined();
    expect(files[KEYS_FILE]).not.toContain('secret');
    expect(files[KEYS_FILE]).toMatch(/^v2:/); // v2 format
  });

  it('supports multiple platforms', () => {
    setPlatform('youtube', { enabled: true, streamKey: 'yt-key', rtmpUrl: 'rtmp://yt.com' });
    setPlatform('kick', { enabled: true, streamKey: 'kick-key', rtmpUrl: 'rtmp://kick.com' });

    expect(getPlatformConfig('youtube').streamKey).toBe('yt-key');
    expect(getPlatformConfig('kick').streamKey).toBe('kick-key');
  });

  it('returns null for nonexistent platform', () => {
    expect(getPlatformConfig('nonexistent')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getPlatforms — key masking
// ---------------------------------------------------------------------------
describe('getPlatforms', () => {
  it('returns empty when no platforms configured', () => {
    const platforms = getPlatforms();
    expect(Object.keys(platforms).length).toBe(0);
  });

  it('masks stream keys (shows only last 4 chars)', () => {
    setPlatform('youtube', { enabled: true, streamKey: 'abcdefghijk', rtmpUrl: 'rtmp://yt.com' });
    const platforms = getPlatforms();
    expect(platforms.youtube.keyMask).toBe('****hijk');
  });

  it('shows rtmpUrl without masking', () => {
    setPlatform('kick', { enabled: true, streamKey: 'key123', rtmpUrl: 'rtmp://kick.live-video.net' });
    const platforms = getPlatforms();
    expect(platforms.kick.rtmpUrl).toBe('rtmp://kick.live-video.net');
  });

  it('shows enabled status', () => {
    setPlatform('yt', { enabled: false, streamKey: 'key', rtmpUrl: 'rtmp://yt.com' });
    expect(getPlatforms().yt.enabled).toBe(false);
  });

  it('returns null keyMask when no stream key set', () => {
    setPlatform('empty', { enabled: true, streamKey: '', rtmpUrl: 'rtmp://test.com' });
    expect(getPlatforms().empty.keyMask).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setPlatformEnabled
// ---------------------------------------------------------------------------
describe('setPlatformEnabled', () => {
  it('toggles platform enabled state', () => {
    setPlatform('yt', { enabled: true, streamKey: 'key', rtmpUrl: 'rtmp://yt.com' });

    const result = setPlatformEnabled('yt', false);
    expect(result.enabled).toBe(false);

    const config = getPlatformConfig('yt');
    expect(config.enabled).toBe(false);
  });

  it('returns null for nonexistent platform', () => {
    expect(setPlatformEnabled('nonexistent', true)).toBeNull();
  });

  it('preserves stream key when toggling', () => {
    setPlatform('yt', { enabled: true, streamKey: 'my-key', rtmpUrl: 'rtmp://yt.com' });
    setPlatformEnabled('yt', false);
    expect(getPlatformConfig('yt').streamKey).toBe('my-key');
  });
});

// ---------------------------------------------------------------------------
// deletePlatform
// ---------------------------------------------------------------------------
describe('deletePlatform', () => {
  it('removes platform from config', () => {
    setPlatform('yt', { enabled: true, streamKey: 'key', rtmpUrl: 'rtmp://yt.com' });
    setPlatform('kick', { enabled: true, streamKey: 'key2', rtmpUrl: 'rtmp://kick.com' });

    deletePlatform('yt');

    expect(getPlatformConfig('yt')).toBeNull();
    expect(getPlatformConfig('kick')).not.toBeNull();
  });

  it('does not crash when deleting nonexistent platform', () => {
    expect(() => deletePlatform('nonexistent')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getEnabledRtmpUrls — URL building (tests buildRtmpUrl internally)
// ---------------------------------------------------------------------------
describe('getEnabledRtmpUrls', () => {
  it('returns empty when no platforms configured', () => {
    expect(getEnabledRtmpUrls()).toEqual([]);
  });

  it('returns empty when all platforms disabled', () => {
    setPlatform('yt', { enabled: false, streamKey: 'key', rtmpUrl: 'rtmp://yt.com/live' });
    expect(getEnabledRtmpUrls()).toEqual([]);
  });

  it('builds YouTube RTMP URL by appending key to path', () => {
    setPlatform('youtube', {
      enabled: true,
      streamKey: 'abc-123',
      rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2'
    });
    const urls = getEnabledRtmpUrls();
    expect(urls.length).toBe(1);
    expect(urls[0].name).toBe('youtube');
    expect(urls[0].url).toContain('abc-123');
    expect(urls[0].url).toContain('live2');
  });

  it('builds Kick RTMP URL with /app/ path', () => {
    setPlatform('kick', {
      enabled: true,
      streamKey: 'sk_live_123',
      rtmpUrl: 'rtmp://fa723fc1b171.global-contribute.live-video.net'
    });
    const urls = getEnabledRtmpUrls();
    expect(urls.length).toBe(1);
    expect(urls[0].url).toContain('/app/');
    expect(urls[0].url).toContain('sk_live_123');
  });

  it('handles {key} template in URL', () => {
    setPlatform('custom', {
      enabled: true,
      streamKey: 'my-secret-key',
      rtmpUrl: 'rtmp://custom.server.com/live/{key}'
    });
    const urls = getEnabledRtmpUrls();
    expect(urls[0].url).toBe('rtmp://custom.server.com/live/my-secret-key');
  });

  it('handles {streamKey} template in URL', () => {
    setPlatform('custom', {
      enabled: true,
      streamKey: 'sk123',
      rtmpUrl: 'rtmp://server.com/app/{streamKey}'
    });
    const urls = getEnabledRtmpUrls();
    expect(urls[0].url).toBe('rtmp://server.com/app/sk123');
  });

  it('skips platforms without stream key', () => {
    setPlatform('nokey', { enabled: true, streamKey: '', rtmpUrl: 'rtmp://test.com' });
    expect(getEnabledRtmpUrls()).toEqual([]);
  });

  it('skips platforms without RTMP URL', () => {
    setPlatform('nourl', { enabled: true, streamKey: 'key', rtmpUrl: '' });
    expect(getEnabledRtmpUrls()).toEqual([]);
  });

  it('returns multiple URLs for multiple enabled platforms', () => {
    setPlatform('yt', { enabled: true, streamKey: 'k1', rtmpUrl: 'rtmp://yt.com/live' });
    setPlatform('kick', { enabled: true, streamKey: 'k2', rtmpUrl: 'rtmp://kick.live-video.net' });
    setPlatform('twitch', { enabled: false, streamKey: 'k3', rtmpUrl: 'rtmp://twitch.tv' });
    const urls = getEnabledRtmpUrls();
    expect(urls.length).toBe(2);
  });
});
