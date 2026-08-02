/**
 * tests/dashboard/mixing.test.js
 *
 * Characterization of dashboard/lib/mixing.js (P1-6).
 *
 * Strategy: createMixingRouter builds an Express router that delegates to
 * the shared liqClient CJS instance. We require that SAME instance and spy
 * on getMixingConfig/setMixingConfig, then invoke the route handlers
 * directly via getRouteHandler + mockRes (no HTTP).
 *
 * Pinned here (current behavior):
 *   - GET /config success -> json(result.data);
 *   - GET /config FAILURE -> 502 { error: 'DJ unavailable' } (CHANGED IN
 *     T16-C2; it used to answer HTTP 200 with a hard-coded { mode: 'smart' });
 *   - POST /config validation: missing/invalid mode -> 400 with the
 *     VALID_MODES list; valid mode -> setMixingConfig({mode}), broadcast
 *     receives ONLY { mode } (not result.data), responds json(result.data);
 *   - POST /config DJ failure -> 502.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { mockRes, getRouteHandler, spy, restoreSpies } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
const createMixingRouter = nodeRequire('../../dashboard/lib/mixing');
const liqClient = nodeRequire('../../dashboard/lib/liqClient');

let broadcast;
let router;

beforeEach(() => {
  spy(vi.spyOn(console, 'log').mockImplementation(() => {}));
  spy(vi.spyOn(console, 'error').mockImplementation(() => {}));
  broadcast = vi.fn();
  router = createMixingRouter(broadcast);
});

afterEach(() => {
  restoreSpies();
  vi.restoreAllMocks();
});

describe('dashboard/lib/mixing.js GET /config', () => {
  it('success: responds with result.data', async () => {
    spy(vi.spyOn(liqClient, 'getMixingConfig').mockResolvedValue({ status: 200, data: { mode: 'crossfade' } }));
    const handler = getRouteHandler(router, 'get', '/config');
    const res = mockRes();
    await handler({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ mode: 'crossfade' });
  });

  it('FAILURE: reports 502 instead of inventing a reading', async () => {
    // CHANGED IN T16-C2. This used to answer 200 { mode: 'smart' }, which made
    // an unreachable DJ indistinguishable from one actually set to smart: the
    // UI displayed a config it had never received, and a failed write followed
    // by a re-read looked like it had succeeded.
    spy(vi.spyOn(liqClient, 'getMixingConfig').mockRejectedValue(new Error('DJ down')));
    const handler = getRouteHandler(router, 'get', '/config');
    const res = mockRes();
    await handler({}, res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'DJ unavailable' });
  });
});

describe('dashboard/lib/mixing.js POST /config', () => {
  it('missing mode -> 400 with the VALID_MODES list', async () => {
    const handler = getRouteHandler(router, 'post', '/config');
    const res = mockRes();
    await handler({ body: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid mode. Valid: smart, cut, crossfade' });
  });

  it('invalid mode -> 400', async () => {
    const handler = getRouteHandler(router, 'post', '/config');
    const res = mockRes();
    await handler({ body: { mode: 'bogus' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('Invalid mode');
  });

  it.each(['smart', 'cut', 'crossfade'])('valid mode %s: sets config, broadcasts {mode} only, returns result.data', async (mode) => {
    const setSpy = spy(vi.spyOn(liqClient, 'setMixingConfig')
      .mockResolvedValue({ status: 200, data: { mode, applied: true } }));
    const handler = getRouteHandler(router, 'post', '/config');
    const res = mockRes();
    await handler({ body: { mode, extra: 'ignored' } }, res);

    expect(setSpy).toHaveBeenCalledWith({ mode });
    // broadcast gets ONLY { mode }, not result.data.
    expect(broadcast).toHaveBeenCalledWith('mixing-config', { mode });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ mode, applied: true });
  });

  it('DJ failure on set -> 502', async () => {
    spy(vi.spyOn(liqClient, 'setMixingConfig').mockRejectedValue(new Error('boom')));
    const handler = getRouteHandler(router, 'post', '/config');
    const res = mockRes();
    await handler({ body: { mode: 'cut' } }, res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'DJ unavailable' });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
