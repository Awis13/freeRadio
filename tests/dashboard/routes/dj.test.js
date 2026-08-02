/**
 * tests/dashboard/routes/dj.test.js
 *
 * Unit tests for dashboard/routes/dj.js — DJ playback control routes.
 * Tests: POST /start, /resume, /cue, /stop
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { mockRes, getRouteHandler, spy, restoreSpies } from '../helpers.js';

const require = createRequire(import.meta.url);

const createDjRouter = require('../../../dashboard/routes/dj');
const liqClient = require('../../../dashboard/lib/liqClient');
const s3 = require('../../../dashboard/lib/s3');
const boot = require('../../../dashboard/lib/boot');
const fs = require('fs');

beforeEach(() => restoreSpies());
afterEach(() => restoreSpies());

// ─── POST /start ──────────────────────────────────────────────

describe('POST /start', () => {
  it('calls liqClient.startPlayback and returns result', async () => {
    spy(vi.spyOn(liqClient, 'startPlayback').mockResolvedValue({ data: { status: 'playing' } }));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/start');
    const res = mockRes();

    await handler({}, res);

    expect(liqClient.startPlayback).toHaveBeenCalled();
    expect(res.body).toEqual({ ok: true, data: { status: 'playing' } });
  });

  it('reports a DJ failure as 502, without echoing the raw error', async () => {
    // CHANGED IN THE TRACK-CLOSE HOTFIX. This answered 500 with e.message, so a
    // dead DJ produced 'getaddrinfo ENOTFOUND dj' in the response body while
    // queue.js answered 502 'liquidsoap unavailable' for the very same outage.
    spy(vi.spyOn(console, 'error').mockImplementation(() => {}));
    spy(vi.spyOn(liqClient, 'startPlayback').mockRejectedValue(new Error('getaddrinfo ENOTFOUND dj')));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/start');
    const res = mockRes();

    await handler({}, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.body).toEqual({ error: 'DJ unavailable' });
    expect(JSON.stringify(res.body)).not.toContain('ENOTFOUND');
  });
});

// ─── POST /cue ────────────────────────────────────────────────

describe('POST /cue', () => {
  it('reads processed dir, picks a track, cues it', async () => {
    spy(vi.spyOn(fs.promises, 'readdir').mockResolvedValue(['track1.wav', 'track2.mp3', 'cover.jpg']));
    spy(vi.spyOn(liqClient, 'cueTrack').mockResolvedValue({ data: { track: 'test' } }));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/cue');
    const res = mockRes();

    await handler({}, res);

    expect(liqClient.cueTrack).toHaveBeenCalled();
    expect(res.body.ok).toBe(true);
    const cuedPath = liqClient.cueTrack.mock.calls[0][0];
    expect(cuedPath).toMatch(/\.(wav|mp3)$/);
  });

  it('returns 404 when no audio files found', async () => {
    spy(vi.spyOn(fs.promises, 'readdir').mockResolvedValue(['cover.jpg', 'readme.txt']));

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
    spy(vi.spyOn(fs.promises, 'readdir').mockResolvedValue(['track.mp3']));
    spy(vi.spyOn(liqClient, 'cueTrack').mockResolvedValue({ data: {} }));
    spy(vi.spyOn(s3, 'ensureCached').mockResolvedValue());

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
    spy(vi.spyOn(fs.promises, 'readdir').mockResolvedValue([
      'a.flac', 'b.ogg', 'c.aac', 'd.m4a', 'e.txt', 'f.mp4'
    ]));
    spy(vi.spyOn(liqClient, 'cueTrack').mockResolvedValue({ data: {} }));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/cue');
    const res = mockRes();

    await handler({}, res);

    const cuedPath = liqClient.cueTrack.mock.calls[0][0];
    expect(cuedPath).toMatch(/\.(flac|ogg|aac|m4a)$/);
  });

  it('attributes an S3 fetch failure to S3, not to the DJ', async () => {
    // The /cue split exists so each of its three failure sources reports
    // itself. Without a pin here the attribution could be silently wrong — the
    // request would still 502 and still look correct.
    const origEnabled = s3.S3_ENABLED;
    s3.S3_ENABLED = true;
    spy(vi.spyOn(console, 'error').mockImplementation(() => {}));
    spy(vi.spyOn(fs.promises, 'readdir').mockResolvedValue(['track.mp3']));
    spy(vi.spyOn(s3, 'ensureCached').mockRejectedValue(new Error('NoSuchKey')));
    const cueSpy = spy(vi.spyOn(liqClient, 'cueTrack').mockResolvedValue({ data: {} }));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/cue');
    const res = mockRes();

    await handler({}, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.body).toEqual({ error: 's3 unavailable' });
    // and it stops there rather than cueing a track that was never fetched.
    expect(cueSpy).not.toHaveBeenCalled();

    s3.S3_ENABLED = origEnabled;
  });

  it('attributes a cueTrack failure to the DJ', async () => {
    spy(vi.spyOn(console, 'error').mockImplementation(() => {}));
    spy(vi.spyOn(fs.promises, 'readdir').mockResolvedValue(['track.mp3']));
    spy(vi.spyOn(liqClient, 'cueTrack').mockRejectedValue(new Error('getaddrinfo ENOTFOUND dj')));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/cue');
    const res = mockRes();

    await handler({}, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.body).toEqual({ error: 'DJ unavailable' });
    expect(JSON.stringify(res.body)).not.toContain('ENOTFOUND');
  });

  it('returns 500 when readdir of the processed dir fails — a LOCAL fault', async () => {
    // Deliberately still a 500. /cue touches three separate things (the local
    // directory, S3, the DJ) and the hotfix split them so each reports its own
    // fault; reading a local directory failing is not an upstream outage and
    // must not be dressed up as one.
    spy(vi.spyOn(fs.promises, 'readdir').mockRejectedValue(new Error('EACCES')));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/cue');
    const res = mockRes();

    await handler({}, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body.error).toBe('EACCES');
  });
});

// ─── POST /resume ─────────────────────────────────────────────

describe('POST /resume', () => {
  it('calls resumePlayback', async () => {
    spy(vi.spyOn(liqClient, 'resumePlayback').mockResolvedValue({ data: { status: 'playing' } }));
    spy(vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {}));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/resume');
    const res = mockRes();

    await handler({}, res);

    expect(liqClient.resumePlayback).toHaveBeenCalled();
    expect(res.body.ok).toBe(true);
  });
  it('reports a resumePlayback failure as a DJ 502', async () => {
    spy(vi.spyOn(console, 'error').mockImplementation(() => {}));
    spy(vi.spyOn(liqClient, 'resumePlayback').mockRejectedValue(new Error('ECONNREFUSED dj:7000')));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/resume');
    const res = mockRes();

    await handler({}, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.body).toEqual({ error: 'DJ unavailable' });
    expect(JSON.stringify(res.body)).not.toContain('dj:7000');
  });
});

// ─── POST /stop ───────────────────────────────────────────────

describe('POST /stop', () => {
  it('sets bootAborted flag and calls stopPlayback', async () => {
    boot.setBootAborted(false);
    spy(vi.spyOn(liqClient, 'stopPlayback').mockResolvedValue({ data: { status: 'stopped' } }));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/stop');
    const res = mockRes();

    await handler({}, res);

    expect(boot.isBootAborted()).toBe(true);
    expect(liqClient.stopPlayback).toHaveBeenCalled();
    expect(res.body.ok).toBe(true);
  });

  it('reports a stopPlayback failure as a DJ 502', async () => {
    // CHANGED IN THE TRACK-CLOSE HOTFIX, same reason as /start.
    boot.setBootAborted(false);
    spy(vi.spyOn(console, 'error').mockImplementation(() => {}));
    spy(vi.spyOn(liqClient, 'stopPlayback').mockRejectedValue(new Error('timeout')));

    const router = createDjRouter('/music');
    const handler = getRouteHandler(router, 'post', '/stop');
    const res = mockRes();

    await handler({}, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.body).toEqual({ error: 'DJ unavailable' });
  });
});
