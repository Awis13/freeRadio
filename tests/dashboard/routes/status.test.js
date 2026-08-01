/**
 * tests/dashboard/routes/status.test.js
 *
 * Unit tests for dashboard/routes/status.js — read-only status endpoints.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { mockRes, getRouteHandler, spy, restoreSpies } from '../helpers.js';

const require = createRequire(import.meta.url);

const createStatusRouter = require('../../../dashboard/routes/status');
const streamControl = require('../../../dashboard/lib/streamControl');
const streamKeys = require('../../../dashboard/lib/streamKeys');
const visualMode = require('../../../dashboard/lib/visualMode');
const liveMode = require('../../../dashboard/lib/liveMode');
const s3 = require('../../../dashboard/lib/s3');
const cacheManager = require('../../../dashboard/lib/cacheManager');
const fs = require('fs');

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

beforeEach(() => restoreSpies());
afterEach(() => restoreSpies());

// ─── POST /auth/verify ────────────────────────────────────────

describe('POST /auth/verify', () => {
  it('DENIES when no DASHBOARD_TOKEN is set and auth was not explicitly disabled', () => {
    // CHANGED IN T11-C2: an unset token used to mean "everyone is welcome".
    // A missing environment variable is not consent, so the surface refuses
    // until the operator picks a posture.
    const orig = process.env.DASHBOARD_TOKEN;
    const origDisabled = process.env.AUTH_DISABLED;
    process.env.DASHBOARD_TOKEN = '';
    delete process.env.AUTH_DISABLED;

    const router = createStatusRouter(baseState);
    const handler = getRouteHandler(router, 'post', '/auth/verify');
    const res = mockRes();
    handler({ body: {} }, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Auth is not configured' });

    process.env.DASHBOARD_TOKEN = orig;
    if (origDisabled === undefined) delete process.env.AUTH_DISABLED;
    else process.env.AUTH_DISABLED = origDisabled;
  });

  it('returns ok with no token when AUTH_DISABLED=true', () => {
    const orig = process.env.DASHBOARD_TOKEN;
    const origDisabled = process.env.AUTH_DISABLED;
    process.env.DASHBOARD_TOKEN = '';
    process.env.AUTH_DISABLED = 'true';

    const router = createStatusRouter(baseState);
    const handler = getRouteHandler(router, 'post', '/auth/verify');
    const res = mockRes();
    handler({ body: {} }, res);

    expect(res.body).toEqual({ ok: true });

    process.env.DASHBOARD_TOKEN = orig;
    if (origDisabled === undefined) delete process.env.AUTH_DISABLED;
    else process.env.AUTH_DISABLED = origDisabled;
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
    spy(vi.spyOn(streamControl, 'getControlState').mockReturnValue({ streaming: true, broadcast: false }));
    spy(vi.spyOn(streamControl, 'getModeState').mockReturnValue({ mode: 'live' }));
    spy(vi.spyOn(visualMode, 'getVisualMode').mockReturnValue({ mode: 'visual-radio' }));
    spy(vi.spyOn(liveMode, 'getLiveMode').mockReturnValue({ source: 'obs' }));

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
    spy(vi.spyOn(streamControl, 'getControlState').mockReturnValue({ streaming: true, broadcast: false }));

    const router = createStatusRouter(baseState);
    const handler = getRouteHandler(router, 'get', '/rtmp-urls');
    const res = mockRes();
    handler({}, res);

    expect(res.body).toEqual([]);
  });

  it('returns RTMP URLs when broadcast is on', () => {
    spy(vi.spyOn(streamControl, 'getControlState').mockReturnValue({ streaming: true, broadcast: true }));
    spy(vi.spyOn(streamKeys, 'getEnabledRtmpUrls').mockReturnValue(['rtmp://yt/live/key1']));

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
    spy(vi.spyOn(fs.promises, 'readdir').mockResolvedValue([
      'visual1.mp4', 'visual2.mov', '_standby_loop.mp4', 'readme.txt'
    ]));
    spy(vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 50000 }));

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
    spy(vi.spyOn(fs.promises, 'readdir').mockRejectedValue(new Error('ENOENT')));

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
    spy(vi.spyOn(cacheManager, 'getCacheSize')
      .mockReturnValueOnce(1024 * 1024 * 500)
      .mockReturnValueOnce(1024 * 1024 * 300));

    const router = createStatusRouter(baseState);
    const handler = getRouteHandler(router, 'get', '/s3/status');
    const res = mockRes();
    handler({}, res);

    expect(res.body.enabled).toBe(true);
    expect(res.body.cache.totalMB).toBe(800);
    s3.S3_ENABLED = orig;
  });
});
