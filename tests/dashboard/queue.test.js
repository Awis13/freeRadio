/**
 * tests/dashboard/queue.test.js
 *
 * Characterization of dashboard/lib/queue.js (P1-6).
 *
 * Strategy: queue.js DESTRUCTURES resolvePlaylist and prefetchTracks at
 * require time, so the bindings are captured then — spying after the fact
 * would not affect the captured references. We therefore spy on the
 * playlist and cacheManager module exports FIRST, then fresh-require queue
 * so it closes over the spies. liqClient and s3 are read as live module
 * objects, so they are spied/flipped on the shared instance at call time.
 * Handlers are invoked directly via getRouteHandler + mockRes.
 *
 * Pinned here (current behavior):
 *   - toProcessedPath: basename + .wav under /music/processed, regardless
 *     of original extension (incl. multi-dot, no-ext, absolute path);
 *   - GET / / POST /skip / POST /clear: success -> json(result.data);
 *     liq failure -> 502 'liquidsoap unavailable';
 *   - POST /push: trims body, empty -> 400; s3 ensureCached when enabled;
 *     pushTrack failure -> 502;
 *   - POST /load-playlist: missing playlistId -> 400; empty playlist ->
 *     404; clear quirk — clears whenever clear !== false (so null / 'false'
 *     / undefined / 0 all still clear; only the boolean false skips);
 *     prefetch only first 5 tracks when S3 enabled; pushes the first-5
 *     batch; loaded = ok count, total = full track count; results array
 *     captures per-track ok/error.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { mockRes, getRouteHandler } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
const QUEUE_SPEC = '../../dashboard/lib/queue';

const liqClient = nodeRequire('../../dashboard/lib/liqClient');
const s3 = nodeRequire('../../dashboard/lib/s3');
const playlist = nodeRequire('../../dashboard/lib/playlist');
const cacheManager = nodeRequire('../../dashboard/lib/cacheManager');

const ORIGINAL_S3_FLAG = s3.S3_ENABLED;

let resolveSpy;
let prefetchSpy;
let createQueueRouter;

/** Install resolvePlaylist/prefetchTracks spies, then fresh-require queue. */
function freshQueue() {
  resolveSpy = vi.spyOn(playlist, 'resolvePlaylist').mockReturnValue([]);
  prefetchSpy = vi.spyOn(cacheManager, 'prefetchTracks').mockResolvedValue(undefined);
  delete nodeRequire.cache[nodeRequire.resolve(QUEUE_SPEC)];
  createQueueRouter = nodeRequire(QUEUE_SPEC);
  return createQueueRouter('/music', () => ({ bpm: 1 }));
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  s3.S3_ENABLED = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  s3.S3_ENABLED = ORIGINAL_S3_FLAG;
  delete nodeRequire.cache[nodeRequire.resolve(QUEUE_SPEC)];
});

describe('dashboard/lib/queue.js toProcessedPath (exercised via /push)', () => {
  beforeEach(() => { freshQueue(); });

  it.each([
    ['song.mp3', '/music/processed/song.wav'],
    ['beat.flac', '/music/processed/beat.wav'],
    ['multi.dot.name.ogg', '/music/processed/multi.dot.name.wav'],
    ['noext', '/music/processed/noext.wav'],
    ['/abs/path/to/track.mp3', '/music/processed/track.wav']
  ])('%s -> %s', async (input, expected) => {
    const router = createQueueRouter('/music', () => ({}));
    const pushSpy = vi.spyOn(liqClient, 'pushTrack').mockResolvedValue({ status: 200, data: { queued: true } });
    const handler = getRouteHandler(router, 'post', '/push');
    const res = mockRes();
    await handler({ body: input }, res);
    expect(pushSpy).toHaveBeenCalledWith(expected);
    expect(res.body).toEqual({ queued: true });
  });
});

describe('dashboard/lib/queue.js GET / and simple commands', () => {
  let router;
  beforeEach(() => { router = freshQueue(); });

  it('GET / success -> json(result.data)', async () => {
    vi.spyOn(liqClient, 'getQueue').mockResolvedValue({ status: 200, data: ['a.wav'] });
    const handler = getRouteHandler(router, 'get', '/');
    const res = mockRes();
    await handler({}, res);
    expect(res.body).toEqual(['a.wav']);
  });

  it('GET / failure -> 502', async () => {
    vi.spyOn(liqClient, 'getQueue').mockRejectedValue(new Error('down'));
    const handler = getRouteHandler(router, 'get', '/');
    const res = mockRes();
    await handler({}, res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'liquidsoap unavailable' });
  });

  it('POST /skip success and 502', async () => {
    const handler = getRouteHandler(router, 'post', '/skip');
    vi.spyOn(liqClient, 'skip').mockResolvedValue({ status: 200, data: { skipped: true } });
    let res = mockRes();
    await handler({}, res);
    expect(res.body).toEqual({ skipped: true });

    vi.spyOn(liqClient, 'skip').mockRejectedValue(new Error('x'));
    res = mockRes();
    await handler({}, res);
    expect(res.statusCode).toBe(502);
  });

  it('POST /clear success and 502', async () => {
    const handler = getRouteHandler(router, 'post', '/clear');
    vi.spyOn(liqClient, 'clearQueue').mockResolvedValue({ status: 200, data: { cleared: true } });
    let res = mockRes();
    await handler({}, res);
    expect(res.body).toEqual({ cleared: true });

    vi.spyOn(liqClient, 'clearQueue').mockRejectedValue(new Error('x'));
    res = mockRes();
    await handler({}, res);
    expect(res.statusCode).toBe(502);
  });
});

describe('dashboard/lib/queue.js POST /push', () => {
  let router;
  beforeEach(() => { router = freshQueue(); });

  it('empty / whitespace body -> 400', async () => {
    const handler = getRouteHandler(router, 'post', '/push');
    const res = mockRes();
    await handler({ body: '   ' }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'no filename' });
  });

  it('non-string body is JSON.stringified before trim', async () => {
    const pushSpy = vi.spyOn(liqClient, 'pushTrack').mockResolvedValue({ status: 200, data: {} });
    const handler = getRouteHandler(router, 'post', '/push');
    // {"x":1} stringifies to a non-empty string with no extension.
    await handler({ body: { x: 1 } }, mockRes());
    expect(pushSpy).toHaveBeenCalledWith('/music/processed/{"x":1}.wav');
  });

  it('S3 enabled: ensureCached called before pushTrack', async () => {
    s3.S3_ENABLED = true;
    const ensureSpy = vi.spyOn(s3, 'ensureCached').mockResolvedValue(undefined);
    vi.spyOn(liqClient, 'pushTrack').mockResolvedValue({ status: 200, data: {} });
    const handler = getRouteHandler(router, 'post', '/push');
    await handler({ body: 'song.mp3' }, mockRes());
    expect(ensureSpy).toHaveBeenCalledWith('music/processed/song.wav', '/music/processed/song.wav');
  });

  it('pushTrack failure -> 502', async () => {
    vi.spyOn(liqClient, 'pushTrack').mockRejectedValue(new Error('down'));
    const handler = getRouteHandler(router, 'post', '/push');
    const res = mockRes();
    await handler({ body: 'song.mp3' }, res);
    expect(res.statusCode).toBe(502);
  });
});

describe('dashboard/lib/queue.js POST /load-playlist', () => {
  let router;
  beforeEach(() => { router = freshQueue(); });

  it('missing playlistId -> 400', async () => {
    const handler = getRouteHandler(router, 'post', '/load-playlist');
    const res = mockRes();
    await handler({ body: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'playlistId required' });
  });

  it('empty / not-found playlist -> 404', async () => {
    resolveSpy.mockReturnValue([]);
    const handler = getRouteHandler(router, 'post', '/load-playlist');
    const res = mockRes();
    await handler({ body: { playlistId: 'p1' } }, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'playlist empty or not found' });
  });

  it('clear quirk: clears for null/"false"/undefined (only boolean false skips)', async () => {
    resolveSpy.mockReturnValue(['t1.mp3']);
    vi.spyOn(liqClient, 'pushTrack').mockResolvedValue({ status: 200, data: {} });
    const handler = getRouteHandler(router, 'post', '/load-playlist');

    for (const clearVal of [null, 'false', undefined, 0]) {
      const clearSpy = vi.spyOn(liqClient, 'clearQueue').mockResolvedValue({ status: 200, data: {} });
      const skipSpy = vi.spyOn(liqClient, 'skip').mockResolvedValue({ status: 200, data: {} });
      await handler({ body: { playlistId: 'p1', clear: clearVal } }, mockRes());
      expect(clearSpy).toHaveBeenCalled();
      expect(skipSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
      skipSpy.mockRestore();
    }
  });

  it('clear === false: queue NOT cleared', async () => {
    resolveSpy.mockReturnValue(['t1.mp3']);
    vi.spyOn(liqClient, 'pushTrack').mockResolvedValue({ status: 200, data: {} });
    const clearSpy = vi.spyOn(liqClient, 'clearQueue').mockResolvedValue({ status: 200, data: {} });
    const skipSpy = vi.spyOn(liqClient, 'skip').mockResolvedValue({ status: 200, data: {} });
    const handler = getRouteHandler(router, 'post', '/load-playlist');
    await handler({ body: { playlistId: 'p1', clear: false } }, mockRes());
    expect(clearSpy).not.toHaveBeenCalled();
    expect(skipSpy).not.toHaveBeenCalled();
  });

  it('pushes only first 5 tracks; prefetch first 5 when S3 enabled; loaded vs total', async () => {
    s3.S3_ENABLED = true;
    const tracks = ['1.mp3', '2.mp3', '3.mp3', '4.mp3', '5.mp3', '6.mp3', '7.mp3'];
    resolveSpy.mockReturnValue(tracks);
    vi.spyOn(liqClient, 'clearQueue').mockResolvedValue({ status: 200, data: {} });
    vi.spyOn(liqClient, 'skip').mockResolvedValue({ status: 200, data: {} });
    const pushSpy = vi.spyOn(liqClient, 'pushTrack').mockResolvedValue({ status: 200, data: {} });

    const handler = getRouteHandler(router, 'post', '/load-playlist');
    const res = mockRes();
    await handler({ body: { playlistId: 'p1' } }, res);

    // Prefetch saw only the first-5 batch.
    expect(prefetchSpy).toHaveBeenCalledWith(['1.mp3', '2.mp3', '3.mp3', '4.mp3', '5.mp3'], '/music');
    // Pushed only first 5, each mapped to processed path.
    expect(pushSpy.mock.calls.map(c => c[0])).toEqual([
      '/music/processed/1.wav', '/music/processed/2.wav', '/music/processed/3.wav',
      '/music/processed/4.wav', '/music/processed/5.wav'
    ]);
    expect(res.body.ok).toBe(true);
    expect(res.body.loaded).toBe(5);
    expect(res.body.total).toBe(7); // full count, not the batch
    expect(res.body.results).toHaveLength(5);
  });

  it('results capture per-track failures; loaded counts only ok', async () => {
    resolveSpy.mockReturnValue(['ok.mp3', 'bad.mp3']);
    vi.spyOn(liqClient, 'clearQueue').mockResolvedValue({ status: 200, data: {} });
    vi.spyOn(liqClient, 'skip').mockResolvedValue({ status: 200, data: {} });
    vi.spyOn(liqClient, 'pushTrack')
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockRejectedValueOnce(new Error('push failed'));

    const handler = getRouteHandler(router, 'post', '/load-playlist');
    const res = mockRes();
    await handler({ body: { playlistId: 'p1' } }, res);

    expect(res.body.loaded).toBe(1);
    expect(res.body.total).toBe(2);
    expect(res.body.results).toEqual([
      { track: 'ok.mp3', ok: true },
      { track: 'bad.mp3', ok: false, error: 'push failed' }
    ]);
  });

  it('S3 disabled: prefetch is not called', async () => {
    s3.S3_ENABLED = false;
    resolveSpy.mockReturnValue(['1.mp3']);
    vi.spyOn(liqClient, 'clearQueue').mockResolvedValue({ status: 200, data: {} });
    vi.spyOn(liqClient, 'skip').mockResolvedValue({ status: 200, data: {} });
    vi.spyOn(liqClient, 'pushTrack').mockResolvedValue({ status: 200, data: {} });
    const handler = getRouteHandler(router, 'post', '/load-playlist');
    await handler({ body: { playlistId: 'p1' } }, mockRes());
    expect(prefetchSpy).not.toHaveBeenCalled();
  });
});
