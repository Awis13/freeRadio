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
import crypto from 'crypto';
import { mockFsMap } from './helpers.js';

// Re-create the module's exact v2 wire format (aes-256-gcm, AAD 'stream-keys',
// sha256(secret) key) so a test can plant a record whose *decrypt succeeds* but
// whose plaintext is arbitrary — used to reach loadKeys()'s JSON.parse catch.
const V2_ALGO = 'aes-256-gcm';
const V2_AAD = Buffer.from('stream-keys', 'utf8');
function makeV2Blob(plaintext, secret) {
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(V2_ALGO, key, iv);
  cipher.setAAD(V2_AAD);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v2', iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}

const KEYS_FILE = '/shared/stream_keys.enc';
const TIER_FILE = '/shared/tier.json';
let files = {};

beforeEach(() => {
  vi.restoreAllMocks();

  // Ensure consistent encryption key
  process.env.STREAM_KEYS_SECRET = 'test-secret-for-vitest';

  // Tier defaults to 'studio' so platform limits don't block tests (3 platforms allowed)
  ({ files } = mockFsMap({ [TIER_FILE]: JSON.stringify({ tier: 'studio' }) }));
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

// ---------------------------------------------------------------------------
// setPlatform — tier platform limit enforcement (real tierLimits, no mocking)
// Tier is controlled via /shared/tier.json in the fs map; tierLimits.getTier()
// re-reads the file on every call, so flipping the map mid-test takes effect.
// ---------------------------------------------------------------------------
describe('setPlatform — tier platform limits', () => {
  it('free tier: first platform is accepted, second is rejected with exact error shape', () => {
    files[TIER_FILE] = JSON.stringify({ tier: 'free' });

    const first = setPlatform('youtube', { enabled: true, streamKey: 'k1', rtmpUrl: 'rtmp://yt.com/live' });
    expect(first).toBeUndefined();
    expect(getPlatformConfig('youtube')).not.toBeNull();

    const second = setPlatform('twitch', { enabled: true, streamKey: 'k2', rtmpUrl: 'rtmp://twitch.tv/app' });
    expect(second).toEqual({ error: 'Platform limit reached for your tier', maxPlatforms: 1 });
    expect(getPlatformConfig('twitch')).toBeNull();
  });

  it('free tier at limit: updating the EXISTING platform bypasses the limit check', () => {
    files[TIER_FILE] = JSON.stringify({ tier: 'free' });
    setPlatform('youtube', { enabled: true, streamKey: 'old-key', rtmpUrl: 'rtmp://yt.com/live' });

    // Same name -> existing-platform path, no limit check, update succeeds
    const result = setPlatform('youtube', { enabled: false, streamKey: 'new-key', rtmpUrl: 'rtmp://yt.com/live2' });
    expect(result).toBeUndefined();

    const config = getPlatformConfig('youtube');
    expect(config.streamKey).toBe('new-key');
    expect(config.enabled).toBe(false);
    expect(config.rtmpUrl).toBe('rtmp://yt.com/live2');
  });

  it('studio tier: three platforms accepted, fourth rejected with maxPlatforms 3', () => {
    files[TIER_FILE] = JSON.stringify({ tier: 'studio' });

    expect(setPlatform('youtube', { enabled: true, streamKey: 'k1', rtmpUrl: 'rtmp://yt.com' })).toBeUndefined();
    expect(setPlatform('twitch', { enabled: true, streamKey: 'k2', rtmpUrl: 'rtmp://twitch.tv' })).toBeUndefined();
    expect(setPlatform('kick', { enabled: true, streamKey: 'k3', rtmpUrl: 'rtmp://kick.live-video.net' })).toBeUndefined();

    const fourth = setPlatform('facebook', { enabled: true, streamKey: 'k4', rtmpUrl: 'rtmp://fb.com' });
    expect(fourth).toEqual({ error: 'Platform limit reached for your tier', maxPlatforms: 3 });
    expect(getPlatformConfig('facebook')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// v1 legacy key file — data-loss chain characterization
//
// A pre-v2 keys file ('iv-less' 3-part format from crypto.createCipher) can no
// longer be decrypted: on Node 22+ crypto.createDecipher does not exist
// (TypeError), on Node 20 it exists (deprecated) but the GCM auth tag check
// fails for data we cannot reproduce without createCipher. Both paths land in
// decrypt()'s catch and return null — version-agnostic outcome: loadKeys()
// silently returns {platforms:{}} and all v1 keys are invisible.
//
// The next WRITE (any setPlatform/deletePlatform) then re-encrypts that empty
// state as v2 and overwrites the v1 file — the original keys are permanently
// destroyed. This is a known data-loss issue; the fix is a separate ticket.
// These tests pin the current behavior, they do not endorse it.
// ---------------------------------------------------------------------------
describe('v1 legacy key file — data-loss chain', () => {
  const V1_CONTENT = 'whatever:authtaghex:cipherhex';

  it('v1 file decrypt fails -> platforms read back as empty (keys invisible)', () => {
    files[KEYS_FILE] = V1_CONTENT;
    expect(getPlatforms()).toEqual({});
    expect(getPlatformConfig('anything')).toBeNull();
    // Read alone does not rewrite the file (decrypt failed before the
    // auto-migration branch in loadKeys, which only runs on successful decrypt)
    expect(files[KEYS_FILE]).toBe(V1_CONTENT);
  });

  it('next write overwrites the v1 file with v2 — original content permanently lost', () => {
    files[KEYS_FILE] = V1_CONTENT;

    setPlatform('youtube', { enabled: true, streamKey: 'new-key', rtmpUrl: 'rtmp://yt.com/live' });

    expect(files[KEYS_FILE]).toMatch(/^v2:/);
    expect(files[KEYS_FILE]).not.toContain(V1_CONTENT);
    // Only the newly written platform survives; whatever the v1 file held is gone
    expect(Object.keys(getPlatforms())).toEqual(['youtube']);
  });

  // Note: crypto.createDecipher was removed in Node 22; dashboard/lib/streamKeys.js
  // decryptLegacy() still calls it, so v1 records are undecryptable there even
  // in principle. On Node 20 (Docker/CI) the function exists but is deprecated.
  // Tracked as a known data-loss issue; the fix is a separate ticket. The chain
  // tests above carry the real pin — both Node paths land in decrypt()'s catch.
});

// ---------------------------------------------------------------------------
// loadKeys — outer catch (decrypt succeeds, JSON.parse fails)
//
// decrypt() can legitimately return a non-null string that is not valid JSON
// (e.g. a v2 record whose plaintext was never JSON, or corruption that still
// authenticates). JSON.parse then throws and is swallowed by loadKeys()'s
// OUTER try/catch — distinct from the `if (!decrypted)` early return, which
// only fires when decrypt() returns null. Pinned as-is: returns {platforms:{}}.
// ---------------------------------------------------------------------------
describe('loadKeys — valid decrypt but non-JSON plaintext', () => {
  it('swallows JSON.parse failure and reads back empty', () => {
    // A genuine v2 record (decrypt succeeds) whose plaintext is not JSON.
    files[KEYS_FILE] = makeV2Blob('this-is-not-json{{{', process.env.STREAM_KEYS_SECRET);

    // loadKeys outer catch -> {platforms:{}}; getPlatforms maps that to {}.
    expect(getPlatforms()).toEqual({});
    expect(getPlatformConfig('anything')).toBeNull();
    expect(getEnabledRtmpUrls()).toEqual([]);

    // Pinned as-is: a pure read does NOT rewrite the file — the throw happens
    // before the auto-migration branch, so the bad v2 blob survives untouched.
    expect(files[KEYS_FILE]).toMatch(/^v2:/);
  });
});

// ---------------------------------------------------------------------------
// getKey — missing STREAM_KEYS_SECRET
//
// getKey() reads process.env lazily on every encrypt/decrypt. With no secret it
// throws, and that throw is NOT caught on the write path: saveKeys -> encrypt ->
// getKey propagates straight out of setPlatform. (loadKeys for a missing file
// never decrypts, so it returns {platforms:{}} first without touching getKey.)
// ---------------------------------------------------------------------------
describe('getKey — STREAM_KEYS_SECRET unset', () => {
  it('setPlatform on the write path propagates the "not set" error', () => {
    delete process.env.STREAM_KEYS_SECRET; // no encryption key available

    // Pinned as-is: the exact refuse-to-start message bubbles up unhandled.
    expect(() =>
      setPlatform('yt', { enabled: true, streamKey: 'k', rtmpUrl: 'rtmp://yt.com' })
    ).toThrow('[streamKeys] STREAM_KEYS_SECRET is not set — refusing to start without encryption key');
  });

  it('a read of an EXISTING file decrypts with the wrong/absent key and degrades to empty', () => {
    // Seed a real v2 record (written under the test secret), then drop the secret.
    files[KEYS_FILE] = makeV2Blob(JSON.stringify({ platforms: { yt: {} } }), process.env.STREAM_KEYS_SECRET);
    delete process.env.STREAM_KEYS_SECRET;

    // decrypt() calls getKey() which throws; that throw is caught INSIDE decrypt()
    // (returns null) -> loadKeys early-returns {platforms:{}}. No exception escapes.
    expect(getPlatforms()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// buildRtmpUrl — uncovered branches (exercised via getEnabledRtmpUrls)
// ---------------------------------------------------------------------------
describe('buildRtmpUrl — key-already-in-path and malformed-URL fallback', () => {
  it('returns the URL unchanged when the stream key is already in the path', () => {
    // pathname.includes(key) short-circuit: URL is normalized by `new URL` and
    // returned as-is, the key is NOT appended a second time.
    setPlatform('yt', {
      enabled: true,
      streamKey: 'mykey',
      rtmpUrl: 'rtmp://srv.com/live/mykey'
    });
    const urls = getEnabledRtmpUrls();
    expect(urls.length).toBe(1);
    // Pinned as-is: new URL() round-trips this to the same string (no trailing
    // mutation, key not duplicated).
    expect(urls[0].url).toBe('rtmp://srv.com/live/mykey');
  });

  it('malformed rtmpUrl (no scheme) falls back to slash-join, no /app forced', () => {
    // `new URL('not a url')` throws -> catch fallback: ensure trailing slash,
    // then append the key. No scheme, no host parsing, no Kick /app handling.
    setPlatform('weird', {
      enabled: true,
      streamKey: 'k1',
      rtmpUrl: 'not a url'
    });
    const urls = getEnabledRtmpUrls();
    expect(urls.length).toBe(1);
    // Pinned as-is: 'not a url' has no trailing '/', so one is added -> 'not a url/' + 'k1'.
    expect(urls[0].url).toBe('not a url/k1');
  });

  it('malformed rtmpUrl that already ends with slash is not double-slashed', () => {
    setPlatform('weird2', {
      enabled: true,
      streamKey: 'k1',
      rtmpUrl: 'justhost/'
    });
    const urls = getEnabledRtmpUrls();
    // Pinned as-is: already ends with '/', so the key is appended directly.
    expect(urls[0].url).toBe('justhost/k1');
  });
});
