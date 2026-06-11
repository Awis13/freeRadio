/**
 * tests/dashboard/routes/live.test.js
 *
 * Unit tests for dashboard/routes/live.js — nginx-rtmp ingest callbacks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { mockRes, getRouteHandler, spy, restoreSpies } from '../helpers.js';

const require = createRequire(import.meta.url);

const createLiveRouter = require('../../../dashboard/routes/live');
const liveMode = require('../../../dashboard/lib/liveMode');

beforeEach(() => restoreSpies());
afterEach(() => restoreSpies());

// ─── POST /on_publish ─────────────────────────────────────────

describe('POST /on_publish', () => {
  it('accepts publish with valid ingest key', () => {
    spy(vi.spyOn(liveMode, 'getLiveMode').mockReturnValue({
      source: 'obs', ingestKey: 'valid-key-123', obsStatus: 'disconnected'
    }));
    spy(vi.spyOn(liveMode, 'setObsStatus').mockReturnValue({
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
    spy(vi.spyOn(liveMode, 'getLiveMode').mockReturnValue({
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
    spy(vi.spyOn(liveMode, 'setObsStatus').mockReturnValue({
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
