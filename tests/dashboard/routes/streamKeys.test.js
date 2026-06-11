/**
 * tests/dashboard/routes/streamKeys.test.js
 *
 * Unit tests for dashboard/routes/streamKeys.js — RTMP key management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { mockRes, getRouteHandler, spy, restoreSpies } from '../helpers.js';

const require = createRequire(import.meta.url);

const createStreamKeysRouter = require('../../../dashboard/routes/streamKeys');
const streamKeys = require('../../../dashboard/lib/streamKeys');
const tierLimits = require('../../../dashboard/lib/tierLimits');

beforeEach(() => restoreSpies());
afterEach(() => restoreSpies());

// ─── GET / ────────────────────────────────────────────────────

describe('GET /', () => {
  it('returns platforms and maxPlatforms', () => {
    spy(vi.spyOn(streamKeys, 'getPlatforms').mockReturnValue({ youtube: { enabled: true } }));
    // maxPlatforms now comes from tierLimits (tier-dependent), not a hardcoded constant
    spy(vi.spyOn(tierLimits, 'getTier').mockReturnValue('pro'));
    spy(vi.spyOn(tierLimits, 'getLimits').mockReturnValue({ maxPlatforms: 3 }));

    const router = createStreamKeysRouter();
    const handler = getRouteHandler(router, 'get', '/');
    const res = mockRes();
    handler({}, res);

    expect(res.body.platforms).toEqual({ youtube: { enabled: true } });
    expect(res.body.maxPlatforms).toBe(3);
  });

  it('returns empty platforms when none configured', () => {
    spy(vi.spyOn(streamKeys, 'getPlatforms').mockReturnValue({}));

    const router = createStreamKeysRouter();
    const handler = getRouteHandler(router, 'get', '/');
    const res = mockRes();
    handler({}, res);

    expect(res.body.platforms).toEqual({});
  });
});

// ─── POST /:platform ─────────────────────────────────────────

describe('POST /:platform', () => {
  it('creates a new platform', () => {
    spy(vi.spyOn(streamKeys, 'getPlatforms').mockReturnValue({}));
    spy(vi.spyOn(streamKeys, 'setPlatform').mockImplementation(() => {}));

    const router = createStreamKeysRouter();
    const handler = getRouteHandler(router, 'post', '/:platform');
    const req = {
      params: { platform: 'youtube' },
      body: { enabled: true, streamKey: 'abc', rtmpUrl: 'rtmp://yt' }
    };
    const res = mockRes();
    handler(req, res);

    expect(streamKeys.setPlatform).toHaveBeenCalledWith('youtube', {
      enabled: true, streamKey: 'abc', rtmpUrl: 'rtmp://yt'
    });
    expect(res.body).toEqual({ success: true });
  });

  it('rejects when platform limit reached', () => {
    // Limit enforcement moved into lib/streamKeys.setPlatform (tier-aware);
    // the route translates its { error } result into a 400 response.
    spy(vi.spyOn(streamKeys, 'setPlatform').mockReturnValue({
      error: 'Platform limit reached for your tier', maxPlatforms: 3
    }));

    const router = createStreamKeysRouter();
    const handler = getRouteHandler(router, 'post', '/:platform');
    const req = {
      params: { platform: 'facebook' },
      body: { enabled: true, streamKey: 'key', rtmpUrl: 'rtmp://fb' }
    };
    const res = mockRes();
    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/limit/i);
  });

  it('allows updating existing platform even at limit', () => {
    spy(vi.spyOn(streamKeys, 'getPlatforms').mockReturnValue({
      youtube: {}, kick: {}, twitch: {}
    }));
    spy(vi.spyOn(streamKeys, 'setPlatform').mockImplementation(() => {}));

    const router = createStreamKeysRouter();
    const handler = getRouteHandler(router, 'post', '/:platform');
    const req = {
      params: { platform: 'youtube' },
      body: { enabled: false, streamKey: 'new', rtmpUrl: 'rtmp://yt' }
    };
    const res = mockRes();
    handler(req, res);

    expect(streamKeys.setPlatform).toHaveBeenCalled();
    expect(res.body).toEqual({ success: true });
  });
});

// ─── PATCH /:platform/enabled ─────────────────────────────────

describe('PATCH /:platform/enabled', () => {
  it('toggles platform enabled state', () => {
    spy(vi.spyOn(streamKeys, 'setPlatformEnabled').mockReturnValue({ enabled: false }));

    const router = createStreamKeysRouter();
    const handler = getRouteHandler(router, 'patch', '/:platform/enabled');
    const req = { params: { platform: 'youtube' }, body: { enabled: false } };
    const res = mockRes();
    handler(req, res);

    expect(streamKeys.setPlatformEnabled).toHaveBeenCalledWith('youtube', false);
    expect(res.body.success).toBe(true);
  });

  it('rejects non-boolean enabled value', () => {
    const router = createStreamKeysRouter();
    const handler = getRouteHandler(router, 'patch', '/:platform/enabled');
    const req = { params: { platform: 'youtube' }, body: { enabled: 'yes' } };
    const res = mockRes();
    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 for unknown platform', () => {
    spy(vi.spyOn(streamKeys, 'setPlatformEnabled').mockReturnValue(null));

    const router = createStreamKeysRouter();
    const handler = getRouteHandler(router, 'patch', '/:platform/enabled');
    const req = { params: { platform: 'nonexistent' }, body: { enabled: true } };
    const res = mockRes();
    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// ─── DELETE /:platform ────────────────────────────────────────

describe('DELETE /:platform', () => {
  it('deletes a platform', () => {
    spy(vi.spyOn(streamKeys, 'deletePlatform').mockImplementation(() => {}));

    const router = createStreamKeysRouter();
    const handler = getRouteHandler(router, 'delete', '/:platform');
    const req = { params: { platform: 'kick' } };
    const res = mockRes();
    handler(req, res);

    expect(streamKeys.deletePlatform).toHaveBeenCalledWith('kick');
    expect(res.body).toEqual({ success: true });
  });
});
