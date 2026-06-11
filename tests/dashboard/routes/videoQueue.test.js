/**
 * tests/dashboard/routes/videoQueue.test.js
 *
 * Unit tests for dashboard/routes/videoQueue.js — video queue management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { mockRes, getRouteHandler, spy, restoreSpies } from '../helpers.js';

const require = createRequire(import.meta.url);

const createVideoQueueRouter = require('../../../dashboard/routes/videoQueue');
const videoQueue = require('../../../dashboard/lib/videoQueue');

beforeEach(() => restoreSpies());
afterEach(() => restoreSpies());

// ─── GET / ────────────────────────────────────────────────────

describe('GET /', () => {
  it('returns the current queue', () => {
    spy(vi.spyOn(videoQueue, 'getQueue').mockReturnValue(['video1.mp4', 'video2.mp4']));

    const router = createVideoQueueRouter();
    const handler = getRouteHandler(router, 'get', '/');
    const res = mockRes();
    handler({}, res);

    expect(res.body).toEqual(['video1.mp4', 'video2.mp4']);
  });
});

// ─── POST /push ───────────────────────────────────────────────

describe('POST /push', () => {
  it('pushes a filename to the queue', () => {
    spy(vi.spyOn(videoQueue, 'push').mockImplementation(() => {}));

    const router = createVideoQueueRouter();
    const handler = getRouteHandler(router, 'post', '/push');
    const res = mockRes();
    handler({ body: 'my_video.mp4' }, res);

    expect(videoQueue.push).toHaveBeenCalledWith('my_video.mp4');
    expect(res.body).toEqual({ ok: true });
  });
});

// ─── POST /skip ───────────────────────────────────────────────

describe('POST /skip', () => {
  it('skips current video', () => {
    spy(vi.spyOn(videoQueue, 'skip').mockImplementation(() => {}));

    const router = createVideoQueueRouter();
    const handler = getRouteHandler(router, 'post', '/skip');
    const res = mockRes();
    handler({}, res);

    expect(videoQueue.skip).toHaveBeenCalled();
    expect(res.body).toEqual({ ok: true });
  });
});

// ─── POST /clear ──────────────────────────────────────────────

describe('POST /clear', () => {
  it('clears the queue', () => {
    spy(vi.spyOn(videoQueue, 'clear').mockImplementation(() => {}));

    const router = createVideoQueueRouter();
    const handler = getRouteHandler(router, 'post', '/clear');
    const res = mockRes();
    handler({}, res);

    expect(videoQueue.clear).toHaveBeenCalled();
    expect(res.body).toEqual({ ok: true });
  });
});
