/**
 * tests/dashboard/routes/live.test.js
 *
 * Unit tests for dashboard/routes/live.js — nginx-rtmp ingest callbacks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const createLiveRouter = require('../../../dashboard/routes/live');
const liveMode = require('../../../dashboard/lib/liveMode');

// ─── Helpers ──────────────────────────────────────────────────

let spies = [];

function mockRes() {
  const res = { statusCode: 200, body: null, ended: false };
  res.json = vi.fn((data) => { res.body = data; return res; });
  res.status = vi.fn((code) => { res.statusCode = code; return res; });
  res.end = vi.fn(() => { res.ended = true; });
  res.send = vi.fn((data) => { res.body = data; return res; });
  return res;
}

/**
 * Get the actual route handler (last in stack), skipping middleware like
 * express.urlencoded() that are registered inline on the route.
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

// ─── POST /on_publish ─────────────────────────────────────────

describe('POST /on_publish', () => {
  it('accepts publish with valid ingest key', () => {
    spies.push(vi.spyOn(liveMode, 'getLiveMode').mockReturnValue({
      source: 'obs', ingestKey: 'valid-key-123', obsStatus: 'disconnected'
    }));
    spies.push(vi.spyOn(liveMode, 'setObsStatus').mockReturnValue({
      source: 'obs', ingestKey: 'valid-key-123', obsStatus: 'connected'
    }));

    const router = createLiveRouter();
    const handler = getRouteHandler(router, 'post', '/on_publish');
    const req = { body: { name: 'valid-key-123' } };
    const res = mockRes();
    handler(req, res);

    expect(liveMode.setObsStatus).toHaveBeenCalledWith('connected');
    expect(res.send).toHaveBeenCalledWith('OK');
  });

  it('rejects publish with invalid key', () => {
    spies.push(vi.spyOn(liveMode, 'getLiveMode').mockReturnValue({
      source: 'obs', ingestKey: 'valid-key-123', obsStatus: 'disconnected'
    }));

    const router = createLiveRouter();
    const handler = getRouteHandler(router, 'post', '/on_publish');
    const req = { body: { name: 'wrong-key' } };
    const res = mockRes();
    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ─── POST /on_done ────────────────────────────────────────────

describe('POST /on_done', () => {
  it('sets OBS status to disconnected', () => {
    spies.push(vi.spyOn(liveMode, 'setObsStatus').mockReturnValue({
      source: 'obs', ingestKey: 'key', obsStatus: 'disconnected'
    }));

    const router = createLiveRouter();
    const handler = getRouteHandler(router, 'post', '/on_done');
    const res = mockRes();
    handler({ body: {} }, res);

    expect(liveMode.setObsStatus).toHaveBeenCalledWith('disconnected');
    expect(res.send).toHaveBeenCalledWith('OK');
  });
});
