/**
 * tests/dashboard/voice.test.js
 *
 * Characterization of dashboard/lib/voice.js (P1-6).
 *
 * Strategy: createVoiceRouter calls fs.mkdirSync at factory init and uses
 * the shared liqClient CJS instance. We spy on the fs surface it touches
 * (mkdirSync/readdirSync/statSync/unlinkSync) and on liqClient, then call
 * the route handlers directly (multer middleware is bypassed — req.file is
 * supplied by the test, as the handler is the LAST layer on the route).
 *
 * Pinned here (current behavior):
 *   - factory init calls fs.mkdirSync(VOICE_DIR, { recursive: true });
 *   - POST /send: no req.file -> 400; success -> pushVoice(path), then
 *     broadcast('voice-status', {status:'on-air', filename}), then
 *     json({ok:true, filename}); pushVoice failure -> 502 with the message
 *     embedded; cleanup() runs AFTER the response either way;
 *   - cleanup(): deletes files whose mtime is older than 1h, leaves fresh
 *     ones, and swallows all errors silently;
 *   - POST /config: parseFloat applied only to provided duck/gain (absent
 *     fields omitted from the config object); success -> broadcast +
 *     json(result.data); DJ failure -> 502.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import { mockRes, getRouteHandler, spy, restoreSpies } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
const createVoiceRouter = nodeRequire('../../dashboard/lib/voice');
const liqClient = nodeRequire('../../dashboard/lib/liqClient');

const VOICE_DIR = '/shared/voice';
const HOUR_MS = 60 * 60 * 1000;

let broadcast;
let mkdirSpy;

beforeEach(() => {
  spy(vi.spyOn(console, 'log').mockImplementation(() => {}));
  spy(vi.spyOn(console, 'error').mockImplementation(() => {}));
  mkdirSpy = spy(vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {}));
  broadcast = vi.fn();
});

afterEach(() => {
  restoreSpies();
  vi.restoreAllMocks();
});

describe('dashboard/lib/voice.js factory init', () => {
  it('ensures the voice dir exists via mkdirSync at construction', () => {
    createVoiceRouter(broadcast);
    expect(mkdirSpy).toHaveBeenCalledWith(VOICE_DIR, { recursive: true });
  });
});

describe('dashboard/lib/voice.js POST /send', () => {
  it('no file -> 400', async () => {
    const router = createVoiceRouter(broadcast);
    const handler = getRouteHandler(router, 'post', '/send');
    const res = mockRes();
    await handler({}, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'No audio file' });
  });

  it('success: pushVoice -> broadcast voice-status -> json; cleanup runs after', async () => {
    const pushSpy = spy(vi.spyOn(liqClient, 'pushVoice').mockResolvedValue({ status: 200, data: {} }));
    // cleanup() reads the dir: keep it empty so no statSync surprises.
    spy(vi.spyOn(fs, 'readdirSync').mockReturnValue([]));
    const router = createVoiceRouter(broadcast);
    const handler = getRouteHandler(router, 'post', '/send');
    const res = mockRes();
    const req = { file: { path: '/shared/voice/ptt_1.webm', filename: 'ptt_1.webm', size: 1234 } };
    await handler(req, res);

    expect(pushSpy).toHaveBeenCalledWith('/shared/voice/ptt_1.webm');
    expect(broadcast).toHaveBeenCalledWith('voice-status', { status: 'on-air', filename: 'ptt_1.webm' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, filename: 'ptt_1.webm' });
  });

  it('pushVoice failure -> 502 with the error message embedded', async () => {
    spy(vi.spyOn(liqClient, 'pushVoice').mockRejectedValue(new Error('harbor closed')));
    spy(vi.spyOn(fs, 'readdirSync').mockReturnValue([]));
    const router = createVoiceRouter(broadcast);
    const handler = getRouteHandler(router, 'post', '/send');
    const res = mockRes();
    await handler({ file: { path: '/p', filename: 'f.webm', size: 1 } }, res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'Failed to push to DJ: harbor closed' });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('cleanup() deletes only files older than 1h and swallows errors', async () => {
    const now = Date.now();
    spy(vi.spyOn(liqClient, 'pushVoice').mockResolvedValue({ status: 200, data: {} }));
    spy(vi.spyOn(fs, 'readdirSync').mockReturnValue(['old.webm', 'fresh.webm']));
    spy(vi.spyOn(fs, 'statSync').mockImplementation((p) => ({
      mtimeMs: p.endsWith('old.webm') ? now - HOUR_MS - 1000 : now
    })));
    const unlinkSpy = spy(vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {}));

    const router = createVoiceRouter(broadcast);
    const handler = getRouteHandler(router, 'post', '/send');
    await handler({ file: { path: '/p', filename: 'f.webm', size: 1 } }, mockRes());

    expect(unlinkSpy).toHaveBeenCalledTimes(1);
    expect(unlinkSpy).toHaveBeenCalledWith('/shared/voice/old.webm');
  });

  it('cleanup() error (readdir throws) is swallowed: send still responds', async () => {
    spy(vi.spyOn(liqClient, 'pushVoice').mockResolvedValue({ status: 200, data: {} }));
    spy(vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('ENOENT'); }));
    const router = createVoiceRouter(broadcast);
    const handler = getRouteHandler(router, 'post', '/send');
    const res = mockRes();
    await handler({ file: { path: '/p', filename: 'f.webm', size: 1 } }, res);
    expect(res.body).toEqual({ ok: true, filename: 'f.webm' });
  });
});

describe('dashboard/lib/voice.js POST /config', () => {
  it('parseFloat applied only to provided fields; absent fields omitted', async () => {
    const setSpy = spy(vi.spyOn(liqClient, 'setVoiceConfig').mockResolvedValue({ status: 200, data: { ok: 1 } }));
    const router = createVoiceRouter(broadcast);
    const handler = getRouteHandler(router, 'post', '/config');
    const res = mockRes();
    await handler({ body: { duck: '0.3' } }, res); // gain omitted

    expect(setSpy).toHaveBeenCalledWith({ duck: 0.3 });
    expect(broadcast).toHaveBeenCalledWith('voice-config', { ok: 1 });
    expect(res.body).toEqual({ ok: 1 });
  });

  it('both duck and gain provided are parseFloat-ed', async () => {
    const setSpy = spy(vi.spyOn(liqClient, 'setVoiceConfig').mockResolvedValue({ status: 200, data: {} }));
    const router = createVoiceRouter(broadcast);
    const handler = getRouteHandler(router, 'post', '/config');
    await handler({ body: { duck: '-6', gain: '2.5' } }, mockRes());
    expect(setSpy).toHaveBeenCalledWith({ duck: -6, gain: 2.5 });
  });

  it('empty body -> empty config object sent', async () => {
    const setSpy = spy(vi.spyOn(liqClient, 'setVoiceConfig').mockResolvedValue({ status: 200, data: {} }));
    const router = createVoiceRouter(broadcast);
    const handler = getRouteHandler(router, 'post', '/config');
    await handler({ body: {} }, mockRes());
    expect(setSpy).toHaveBeenCalledWith({});
  });

  it('DJ failure -> 502', async () => {
    spy(vi.spyOn(liqClient, 'setVoiceConfig').mockRejectedValue(new Error('down')));
    const router = createVoiceRouter(broadcast);
    const handler = getRouteHandler(router, 'post', '/config');
    const res = mockRes();
    await handler({ body: { duck: '0.5' } }, res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'DJ unavailable' });
  });
});
