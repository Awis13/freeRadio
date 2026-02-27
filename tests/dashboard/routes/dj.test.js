/**
 * tests/dashboard/routes/dj.test.js
 *
 * Unit tests for dashboard/routes/dj.js — DJ playback control routes.
 * Tests: POST /start, /resume, /cue, /stop
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const createDjRouter = require('../../../dashboard/routes/dj');
const liqClient = require('../../../dashboard/lib/liqClient');
const s3 = require('../../../dashboard/lib/s3');
const boot = require('../../../dashboard/lib/boot');
const fs = require('fs');

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

// ─── POST /start ──────────────────────────────────────────────

describe('POST /start', () => {
  it('calls liqClient.startPlayback and returns result', async () => {
    spies.push(vi.spyOn(liqClient, 'startPlayback').mockResolvedValue({ data: { status: 'playing' } }));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/start');
    const res = mockRes();

    await handler({}, res);

    expect(liqClient.startPlayback).toHaveBeenCalled();
    expect(res.body).toEqual({ ok: true, data: { status: 'playing' } });
  });

  it('returns 500 on liqClient error', async () => {
    spies.push(vi.spyOn(liqClient, 'startPlayback').mockRejectedValue(new Error('connection refused')));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/start');
    const res = mockRes();

    await handler({}, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body.error).toBe('connection refused');
  });
});

// ─── POST /cue ────────────────────────────────────────────────

describe('POST /cue', () => {
  it('reads processed dir, picks a track, cues it', async () => {
    spies.push(vi.spyOn(fs.promises, 'readdir').mockResolvedValue(['track1.wav', 'track2.mp3', 'cover.jpg']));
    spies.push(vi.spyOn(liqClient, 'cueTrack').mockResolvedValue({ data: { track: 'test' } }));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/cue');
    const res = mockRes();

    await handler({}, res);

    expect(liqClient.cueTrack).toHaveBeenCalled();
    expect(res.body.ok).toBe(true);
    // Should pick wav or mp3, not jpg
    const cuedPath = liqClient.cueTrack.mock.calls[0][0];
    expect(cuedPath).toMatch(/\.(wav|mp3)$/);
  });

  it('returns 404 when no audio files found', async () => {
    spies.push(vi.spyOn(fs.promises, 'readdir').mockResolvedValue(['cover.jpg', 'readme.txt']));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/cue');
    const res = mockRes();

    await handler({}, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body.error).toMatch(/no tracks/i);
  });

  it('calls s3.ensureCached when S3 is enabled', async () => {
    const origEnabled = s3.S3_ENABLED;
    s3.S3_ENABLED = true;
    spies.push(vi.spyOn(fs.promises, 'readdir').mockResolvedValue(['track.mp3']));
    spies.push(vi.spyOn(liqClient, 'cueTrack').mockResolvedValue({ data: {} }));
    spies.push(vi.spyOn(s3, 'ensureCached').mockResolvedValue());

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/cue');
    const res = mockRes();

    await handler({}, res);

    expect(s3.ensureCached).toHaveBeenCalledWith(
      'music/processed/track.mp3',
      '/music/processed/track.mp3'
    );

    s3.S3_ENABLED = origEnabled;
  });

  it('filters only audio extensions', async () => {
    spies.push(vi.spyOn(fs.promises, 'readdir').mockResolvedValue([
      'a.flac', 'b.ogg', 'c.aac', 'd.m4a', 'e.txt', 'f.mp4'
    ]));
    spies.push(vi.spyOn(liqClient, 'cueTrack').mockResolvedValue({ data: {} }));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/cue');
    const res = mockRes();

    await handler({}, res);

    const cuedPath = liqClient.cueTrack.mock.calls[0][0];
    expect(cuedPath).toMatch(/\.(flac|ogg|aac|m4a)$/);
  });
});

// ─── POST /resume ─────────────────────────────────────────────

describe('POST /resume', () => {
  it('calls resumePlayback', async () => {
    spies.push(vi.spyOn(liqClient, 'resumePlayback').mockResolvedValue({ data: { status: 'playing' } }));
    spies.push(vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {}));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/resume');
    const res = mockRes();

    await handler({}, res);

    expect(liqClient.resumePlayback).toHaveBeenCalled();
    expect(res.body.ok).toBe(true);
  });
});

// ─── POST /stop ───────────────────────────────────────────────

describe('POST /stop', () => {
  it('sets bootAborted flag and calls stopPlayback', async () => {
    // dj.js destructures setBootAborted — can't spy on it.
    // Check the actual side effect via isBootAborted() instead.
    boot.setBootAborted(false);
    spies.push(vi.spyOn(liqClient, 'stopPlayback').mockResolvedValue({ data: { status: 'stopped' } }));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/stop');
    const res = mockRes();

    await handler({}, res);

    expect(boot.isBootAborted()).toBe(true);
    expect(liqClient.stopPlayback).toHaveBeenCalled();
    expect(res.body.ok).toBe(true);
  });

  it('returns 500 on stopPlayback error', async () => {
    boot.setBootAborted(false);
    spies.push(vi.spyOn(liqClient, 'stopPlayback').mockRejectedValue(new Error('timeout')));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/stop');
    const res = mockRes();

    await handler({}, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body.error).toBe('timeout');
  });
});
