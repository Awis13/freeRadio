/**
 * tests/dashboard/routes/status.test.js
 *
 * Unit tests for dashboard/routes/status.js — read-only status endpoints.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const createStatusRouter = require('../../../dashboard/routes/status');
const streamControl = require('../../../dashboard/lib/streamControl');
const streamKeys = require('../../../dashboard/lib/streamKeys');
const visualMode = require('../../../dashboard/lib/visualMode');
const liveMode = require('../../../dashboard/lib/liveMode');
const s3 = require('../../../dashboard/lib/s3');
const cacheManager = require('../../../dashboard/lib/cacheManager');
const fs = require('fs');

// ─── Helpers ──────────────────────────────────────────────────

let spies = [];

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.json = vi.fn((data) => { res.body = data; return res; });
  res.status = vi.fn((code) => { res.statusCode = code; return res; });
  res.set = vi.fn();
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

const baseState = {
  outputMode: 'hls',
  audio: { title: 'Test Track', filename: 'test.mp3' },
  video: { title: 'visual_1', filename: 'visual_1.mp4' },
  track: { title: 'Test', filename: '' },
  icecast: { listeners: 5, bitrate: 320 },
  ffmpeg: { fps: '30', speed: '1x' },
  bpm: {},
  rtmpHealth: { youtube: { ok: true } }
};

beforeEach(() => {
  spies.forEach(s => s.mockRestore());
  spies = [];
});

afterEach(() => {
  spies.forEach(s => s.mockRestore());
  spies = [];
});

// ─── POST /auth/verify ────────────────────────────────────────

describe('POST /auth/verify', () => {
  it('returns ok when no DASHBOARD_TOKEN set', () => {
    const orig = process.env.DASHBOARD_TOKEN;
    process.env.DASHBOARD_TOKEN = '';

    const router = createStatusRouter(baseState);
    const handler = getRouteHandler(router, 'post', '/auth/verify');
    const res = mockRes();
    handler({ body: {} }, res);

    expect(res.body).toEqual({ ok: true });
    process.env.DASHBOARD_TOKEN = orig;
  });

  it('returns ok for correct token', () => {
    const orig = process.env.DASHBOARD_TOKEN;
    process.env.DASHBOARD_TOKEN = 'secret123';

    const router = createStatusRouter(baseState);
    const handler = getRouteHandler(router, 'post', '/auth/verify');
    const res = mockRes();
    handler({ body: { token: 'secret123' } }, res);

    expect(res.body).toEqual({ ok: true });
    process.env.DASHBOARD_TOKEN = orig;
  });

  it('returns 401 for wrong token', () => {
    const orig = process.env.DASHBOARD_TOKEN;
    process.env.DASHBOARD_TOKEN = 'secret123';

    const router = createStatusRouter(baseState);
    const handler = getRouteHandler(router, 'post', '/auth/verify');
    const res = mockRes();
    handler({ body: { token: 'wrong' } }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    process.env.DASHBOARD_TOKEN = orig;
  });
});

// ─── GET /status ──────────────────────────────────────────────

describe('GET /status', () => {
  it('returns merged state with stream control, visual, and live mode', () => {
    spies.push(vi.spyOn(streamControl, 'getControlState').mockReturnValue({ streaming: true, broadcast: false }));
    spies.push(vi.spyOn(streamControl, 'getModeState').mockReturnValue({ mode: 'live' }));
    spies.push(vi.spyOn(visualMode, 'getVisualMode').mockReturnValue({ mode: 'visual-radio' }));
    spies.push(vi.spyOn(liveMode, 'getLiveMode').mockReturnValue({ source: 'obs' }));

    const router = createStatusRouter(baseState);
    const handler = getRouteHandler(router, 'get', '/status');
    const res = mockRes();
    handler({}, res);

    expect(res.body.outputMode).toBe('hls');
    expect(res.body.audio.title).toBe('Test Track');
    expect(res.body.streamControl).toEqual({ streaming: true, broadcast: false });
    expect(res.body.streamMode).toEqual({ mode: 'live' });
    expect(res.body.visualMode).toEqual({ mode: 'visual-radio' });
    expect(res.body.liveMode).toEqual({ source: 'obs' });
  });
});

// ─── GET /rtmp-urls ───────────────────────────────────────────

describe('GET /rtmp-urls', () => {
  it('returns empty array when broadcast is off', () => {
    spies.push(vi.spyOn(streamControl, 'getControlState').mockReturnValue({ streaming: true, broadcast: false }));

    const router = createStatusRouter(baseState);
    const handler = getRouteHandler(router, 'get', '/rtmp-urls');
    const res = mockRes();
    handler({}, res);

    expect(res.body).toEqual([]);
  });

  it('returns RTMP URLs when broadcast is on', () => {
    spies.push(vi.spyOn(streamControl, 'getControlState').mockReturnValue({ streaming: true, broadcast: true }));
    spies.push(vi.spyOn(streamKeys, 'getEnabledRtmpUrls').mockReturnValue(['rtmp://yt/live/key1']));

    const router = createStatusRouter(baseState);
    const handler = getRouteHandler(router, 'get', '/rtmp-urls');
    const res = mockRes();
    handler({}, res);

    expect(res.body).toEqual(['rtmp://yt/live/key1']);
  });
});

// ─── GET /rtmp-health ─────────────────────────────────────────

describe('GET /rtmp-health', () => {
  it('returns rtmpHealth from state', () => {
    const router = createStatusRouter(baseState);
    const handler = getRouteHandler(router, 'get', '/rtmp-health');
    const res = mockRes();
    handler({}, res);

    expect(res.body).toEqual({ youtube: { ok: true } });
  });
});

// ─── GET /visuals-processed ───────────────────────────────────

describe('GET /visuals-processed', () => {
  it('returns list of processed visuals with sizes', async () => {
    spies.push(vi.spyOn(fs.promises, 'readdir').mockResolvedValue([
      'visual1.mp4', 'visual2.mov', '_standby_loop.mp4', 'readme.txt'
    ]));
    spies.push(vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 50000 }));

    const router = createStatusRouter(baseState);
    const handler = getRouteHandler(router, 'get', '/visuals-processed');
    const res = mockRes();
    await handler({}, res);

    expect(res.body).toEqual([
      { name: 'visual1.mp4', size: 50000 },
      { name: 'visual2.mov', size: 50000 }
    ]);
  });

  it('returns empty array when directory does not exist', async () => {
    spies.push(vi.spyOn(fs.promises, 'readdir').mockRejectedValue(new Error('ENOENT')));

    const router = createStatusRouter(baseState);
    const handler = getRouteHandler(router, 'get', '/visuals-processed');
    const res = mockRes();
    await handler({}, res);

    expect(res.body).toEqual([]);
  });
});

// ─── GET /s3/status ───────────────────────────────────────────

describe('GET /s3/status', () => {
  it('returns disabled when S3 is off', () => {
    const orig = s3.S3_ENABLED;
    s3.S3_ENABLED = false;

    const router = createStatusRouter(baseState);
    const handler = getRouteHandler(router, 'get', '/s3/status');
    const res = mockRes();
    handler({}, res);

    expect(res.body).toEqual({ enabled: false });
    s3.S3_ENABLED = orig;
  });

  it('returns cache stats when S3 is enabled', () => {
    const orig = s3.S3_ENABLED;
    s3.S3_ENABLED = true;
    spies.push(vi.spyOn(cacheManager, 'getCacheSize')
      .mockReturnValueOnce(1024 * 1024 * 500)   // music: 500MB
      .mockReturnValueOnce(1024 * 1024 * 300));  // visuals: 300MB

    const router = createStatusRouter(baseState);
    const handler = getRouteHandler(router, 'get', '/s3/status');
    const res = mockRes();
    handler({}, res);

    expect(res.body.enabled).toBe(true);
    expect(res.body.cache.totalMB).toBe(800);
    s3.S3_ENABLED = orig;
  });
});
