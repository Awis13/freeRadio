/**
 * tests/dashboard/routes/streamKeys.test.js
 *
 * Unit tests for dashboard/routes/streamKeys.js — RTMP key management.
 *
 * Strategy: use createRequire to access the SAME module instance that the
 * route module uses via CJS require(). Then vi.spyOn patches the actual
 * functions the route handler calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Load modules via CJS require — same cache as the route module
const createStreamKeysRouter = require('../../../dashboard/routes/streamKeys');
const streamKeys = require('../../../dashboard/lib/streamKeys');

// ─── Helpers ──────────────────────────────────────────────────

let spies = [];

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.json = vi.fn((data) => { res.body = data; return res; });
  res.status = vi.fn((code) => { res.statusCode = code; return res; });
  return res;
}

function getRouteHandler(router, method, routePath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath) {
      const match = layer.route.stack.find(s => s.method === method);
      if (match) return match.handle;
    }
  }
  throw new Error(`No handler for ${method.toUpperCase()} ${routePath}`);
}

beforeEach(() => {
  spies.forEach(s => s.mockRestore());
  spies = [];
});

afterEach(() => {
  spies.forEach(s => s.mockRestore());
  spies = [];
});

// ─── GET / ────────────────────────────────────────────────────

describe('GET /', () => {
  it('returns platforms and maxPlatforms', () => {
    spies.push(vi.spyOn(streamKeys, 'getPlatforms').mockReturnValue({ youtube: { enabled: true } }));

    const router = createStreamKeysRouter();
    const handler = getRouteHandler(router, 'get', '/');
    const res = mockRes();
    handler({}, res);

    expect(res.body.platforms).toEqual({ youtube: { enabled: true } });
    expect(res.body.maxPlatforms).toBe(3);
  });

  it('returns empty platforms when none configured', () => {
    spies.push(vi.spyOn(streamKeys, 'getPlatforms').mockReturnValue({}));

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
    spies.push(vi.spyOn(streamKeys, 'getPlatforms').mockReturnValue({}));
    spies.push(vi.spyOn(streamKeys, 'setPlatform').mockImplementation(() => {}));

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
    spies.push(vi.spyOn(streamKeys, 'getPlatforms').mockReturnValue({
      youtube: {}, kick: {}, twitch: {}
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
    spies.push(vi.spyOn(streamKeys, 'getPlatforms').mockReturnValue({
      youtube: {}, kick: {}, twitch: {}
    }));
    spies.push(vi.spyOn(streamKeys, 'setPlatform').mockImplementation(() => {}));

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
    spies.push(vi.spyOn(streamKeys, 'setPlatformEnabled').mockReturnValue({ enabled: false }));

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
    spies.push(vi.spyOn(streamKeys, 'setPlatformEnabled').mockReturnValue(null));

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
    spies.push(vi.spyOn(streamKeys, 'deletePlatform').mockImplementation(() => {}));

    const router = createStreamKeysRouter();
    const handler = getRouteHandler(router, 'delete', '/:platform');
    const req = { params: { platform: 'kick' } };
    const res = mockRes();
    handler(req, res);

    expect(streamKeys.deletePlatform).toHaveBeenCalledWith('kick');
    expect(res.body).toEqual({ success: true });
  });
});
