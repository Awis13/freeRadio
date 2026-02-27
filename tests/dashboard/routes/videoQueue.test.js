/**
 * tests/dashboard/routes/videoQueue.test.js
 *
 * Unit tests for dashboard/routes/videoQueue.js — video queue management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const createVideoQueueRouter = require('../../../dashboard/routes/videoQueue');
const videoQueue = require('../../../dashboard/lib/videoQueue');

// ─── Helpers ──────────────────────────────────────────────────

let spies = [];

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.json = vi.fn((data) => { res.body = data; return res; });
  res.status = vi.fn((code) => { res.statusCode = code; return res; });
  return res;
}

/**
 * Get the actual route handler (last in stack), skipping middleware like
 * express.text() that are registered inline on the route.
 */
function getRouteHandler(router, method, routePath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath) {
      const matches = layer.route.stack.filter(s => s.method === method);
      if (matches.length) return matches[matches.length - 1].handle;
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
  it('returns the current queue', () => {
    spies.push(vi.spyOn(videoQueue, 'getQueue').mockReturnValue(['video1.mp4', 'video2.mp4']));

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
    spies.push(vi.spyOn(videoQueue, 'push').mockImplementation(() => {}));

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
    spies.push(vi.spyOn(videoQueue, 'skip').mockImplementation(() => {}));

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
    spies.push(vi.spyOn(videoQueue, 'clear').mockImplementation(() => {}));

    const router = createVideoQueueRouter();
    const handler = getRouteHandler(router, 'post', '/clear');
    const res = mockRes();
    handler({}, res);

    expect(videoQueue.clear).toHaveBeenCalled();
    expect(res.body).toEqual({ ok: true });
  });
});
