/**
 * tests/dashboard/fileManager.test.js
 *
 * Characterization of dashboard/lib/fileManager.js (P1-6).
 *
 * Strategy: fileManager uses the shared s3 and transcoderClient CJS
 * instances; both S3_ENABLED and transcoder.ENABLED are writable primitive
 * exports, so tests flip them and spy on the seams (s3.upload/remove/
 * download, transcoder.submit/getJob) on the shared objects at call time.
 * Route handlers are the LAST layer on each route (multer is middleware),
 * so they are invoked directly via getRouteHandler with a hand-built
 * req.files. The fs surface is spied per test. pollAndDownload is driven
 * under fake timers — setInterval(3000) with NO immediate first tick.
 *
 * Pinned here (current behavior):
 *   - GET /: lists files (skips dotfiles), maps name/size/modified, sorted
 *     by name; readdir error -> 500;
 *   - POST /: no files -> 400; visuals + transcoder.ENABLED -> submit each,
 *     transcode results array, pollAndDownload kicked off; music / fallback
 *     -> S3 upload per file when enabled; S3 disabled -> { uploaded } only
 *     (no s3 key);
 *   - DELETE /:name traversal guard rejects '/', '\\', leading '.'; the
 *     empty-string '' PASSES the guard (quirk) and resolves to the dir;
 *     missing -> 404; success -> unlink + S3 remove + cascade processed;
 *   - deleteProcessed: music vs visuals path resolution, local-unlink
 *     failure continues (not pushed, S3 skipped), S3 failure still pushes
 *     the file to deleted;
 *   - pollAndDownload: setInterval(3000), no first immediate tick; done ->
 *     download + clear; error -> clear; null job -> clear; timeout after
 *     120 attempts -> clear.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { mockRes, getRouteHandler, spy, restoreSpies } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
const FM_SPEC = '../../dashboard/lib/fileManager';
const fileManager = nodeRequire(FM_SPEC);
const s3 = nodeRequire('../../dashboard/lib/s3');
const transcoder = nodeRequire('../../dashboard/lib/transcoderClient');

const ORIGINAL_S3 = s3.S3_ENABLED;
const ORIGINAL_TR = transcoder.ENABLED;

beforeEach(() => {
  spy(vi.spyOn(console, 'log').mockImplementation(() => {}));
  spy(vi.spyOn(console, 'error').mockImplementation(() => {}));
  // multer is created at factory time; stub mkdirSync so construction is safe.
  spy(vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {}));
  s3.S3_ENABLED = false;
  transcoder.ENABLED = false;
});

afterEach(() => {
  restoreSpies();
  vi.restoreAllMocks();
  vi.useRealTimers();
  s3.S3_ENABLED = ORIGINAL_S3;
  transcoder.ENABLED = ORIGINAL_TR;
});

describe('dashboard/lib/fileManager.js GET /', () => {
  it('lists non-dot files with name/size/modified, sorted by name', async () => {
    spy(vi.spyOn(fs, 'readdirSync').mockReturnValue([
      { name: 'b.mp3', isFile: () => true },
      { name: 'a.mp3', isFile: () => true },
      { name: '.hidden', isFile: () => true },
      { name: 'sub', isFile: () => false }
    ]));
    spy(vi.spyOn(fs, 'statSync').mockImplementation((p) => ({
      size: p.endsWith('a.mp3') ? 10 : 20,
      mtimeMs: 999
    })));
    const router = fileManager('/music');
    const handler = getRouteHandler(router, 'get', '/');
    const res = mockRes();
    await handler({}, res);
    expect(res.body).toEqual([
      { name: 'a.mp3', size: 10, modified: 999 },
      { name: 'b.mp3', size: 20, modified: 999 }
    ]);
  });

  it('readdir error -> 500', async () => {
    spy(vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('boom'); }));
    const router = fileManager('/music');
    const handler = getRouteHandler(router, 'get', '/');
    const res = mockRes();
    await handler({}, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'boom' });
  });
});

describe('dashboard/lib/fileManager.js POST /', () => {
  it('no files -> 400', async () => {
    const router = fileManager('/music');
    const handler = getRouteHandler(router, 'post', '/');
    const res = mockRes();
    await handler({ files: [] }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'No files uploaded' });
  });

  it('visuals + transcoder enabled: submits each and returns transcode results', async () => {
    transcoder.ENABLED = true;
    vi.useFakeTimers(); // pollAndDownload arms a setInterval we never advance
    const submitSpy = spy(vi.spyOn(transcoder, 'submit').mockResolvedValue({ job_id: 'J1', status: 'queued' }));
    spy(vi.spyOn(transcoder, 'getJob').mockResolvedValue(null));
    const router = fileManager('/visuals/incoming');
    const handler = getRouteHandler(router, 'post', '/');
    const res = mockRes();
    await handler({ files: [{ filename: 'clip.mp4', size: 5, path: '/visuals/incoming/clip.mp4' }] }, res);

    expect(submitSpy).toHaveBeenCalledWith('/visuals/incoming/clip.mp4');
    expect(res.body).toEqual({
      uploaded: [{ name: 'clip.mp4', size: 5 }],
      transcode: [{ name: 'clip.mp4', job_id: 'J1', status: 'queued' }]
    });
  });

  it('visuals + transcoder enabled: submit failure captured as error entry', async () => {
    transcoder.ENABLED = true;
    spy(vi.spyOn(transcoder, 'submit').mockRejectedValue(new Error('transcoder down')));
    const router = fileManager('/visuals/incoming');
    const handler = getRouteHandler(router, 'post', '/');
    const res = mockRes();
    await handler({ files: [{ filename: 'clip.mp4', size: 5, path: '/p' }] }, res);
    expect(res.body.transcode).toEqual([{ name: 'clip.mp4', error: 'transcoder down' }]);
  });

  it('music + S3 enabled: uploads each file under music/raw/', async () => {
    s3.S3_ENABLED = true;
    const upSpy = spy(vi.spyOn(s3, 'upload').mockResolvedValue(undefined));
    const router = fileManager('/music');
    const handler = getRouteHandler(router, 'post', '/');
    const res = mockRes();
    await handler({ files: [{ filename: 'a.mp3', size: 3, path: '/music/a.mp3' }] }, res);
    expect(upSpy).toHaveBeenCalledWith('/music/a.mp3', 'music/raw/a.mp3');
    expect(res.body).toEqual({ uploaded: [{ name: 'a.mp3', size: 3 }], s3: [{ name: 'a.mp3', s3: true }] });
  });

  it('music + S3 upload failure: s3 entry marks failure', async () => {
    s3.S3_ENABLED = true;
    spy(vi.spyOn(s3, 'upload').mockRejectedValue(new Error('s3 boom')));
    const router = fileManager('/music');
    const handler = getRouteHandler(router, 'post', '/');
    const res = mockRes();
    await handler({ files: [{ filename: 'a.mp3', size: 3, path: '/music/a.mp3' }] }, res);
    expect(res.body.s3).toEqual([{ name: 'a.mp3', s3: false, error: 's3 boom' }]);
  });

  it('S3 disabled: response has no s3 key', async () => {
    s3.S3_ENABLED = false;
    const router = fileManager('/music');
    const handler = getRouteHandler(router, 'post', '/');
    const res = mockRes();
    await handler({ files: [{ filename: 'a.mp3', size: 3, path: '/music/a.mp3' }] }, res);
    expect(res.body).toEqual({ uploaded: [{ name: 'a.mp3', size: 3 }] });
    expect('s3' in res.body).toBe(false);
  });
});

describe('dashboard/lib/fileManager.js DELETE /:name', () => {
  it.each(['../etc/passwd', 'a/b', 'a\\b', '.hidden'])('traversal guard rejects %s -> 400', async (name) => {
    const router = fileManager('/music');
    const handler = getRouteHandler(router, 'delete', '/:name');
    const res = mockRes();
    await handler({ params: { name } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid filename' });
  });

  it("QUIRK: empty-string name '' PASSES the guard and resolves to the dir", async () => {
    // '' has no '/'/'\\' and does not startWith('.'), so the guard passes;
    // path.join(dir,'') === dir, existsSync(dir) true -> unlink(dir) attempted.
    spy(vi.spyOn(fs, 'existsSync').mockReturnValue(true));
    const unlinkSpy = spy(vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {}));
    spy(vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }));
    const router = fileManager('/music');
    const handler = getRouteHandler(router, 'delete', '/:name');
    const res = mockRes();
    await handler({ params: { name: '' } }, res);
    // The guard did NOT 400 it — it proceeded to unlink the dir path.
    expect(res.statusCode).not.toBe(400);
    expect(unlinkSpy).toHaveBeenCalledWith('/music');
    expect(res.body.deleted).toBe('');
  });

  it('missing file -> 404', async () => {
    spy(vi.spyOn(fs, 'existsSync').mockReturnValue(false));
    const router = fileManager('/music');
    const handler = getRouteHandler(router, 'delete', '/:name');
    const res = mockRes();
    await handler({ params: { name: 'gone.mp3' } }, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'File not found' });
  });

  it('success with S3 + cascade processed delete', async () => {
    s3.S3_ENABLED = true;
    spy(vi.spyOn(fs, 'existsSync').mockReturnValue(true));
    spy(vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {}));
    // processed dir lists one matching base.
    spy(vi.spyOn(fs, 'readdirSync').mockReturnValue(['song.wav', 'other.wav']));
    const removeSpy = spy(vi.spyOn(s3, 'remove').mockResolvedValue(undefined));
    const router = fileManager('/music');
    const handler = getRouteHandler(router, 'delete', '/:name');
    const res = mockRes();
    await handler({ params: { name: 'song.mp3' } }, res);

    expect(res.body.deleted).toBe('song.mp3');
    expect(res.body.s3).toBe(true);
    expect(res.body.processedDeleted).toEqual(['song.wav']);
    // S3 removed both the raw and the processed key.
    expect(removeSpy).toHaveBeenCalledWith('music/raw/song.mp3');
    expect(removeSpy).toHaveBeenCalledWith('music/processed/song.wav');
  });
});

describe('dashboard/lib/fileManager.js DELETE -> deleteProcessed paths', () => {
  it('visuals path resolves under <root>/.processed and visuals/processed/ prefix', async () => {
    s3.S3_ENABLED = true;
    spy(vi.spyOn(fs, 'existsSync').mockReturnValue(true));
    spy(vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {}));
    const readdirSpy = spy(vi.spyOn(fs, 'readdirSync').mockReturnValue(['clip.mp4']));
    const removeSpy = spy(vi.spyOn(s3, 'remove').mockResolvedValue(undefined));
    const router = fileManager('/visuals/incoming');
    const handler = getRouteHandler(router, 'delete', '/:name');
    const res = mockRes();
    await handler({ params: { name: 'clip.mov' } }, res);

    // processed dir = /visuals/.processed (incoming stripped).
    expect(readdirSpy).toHaveBeenCalledWith('/visuals/.processed');
    expect(removeSpy).toHaveBeenCalledWith('visuals/processed/clip.mp4');
    expect(res.body.processedDeleted).toEqual(['clip.mp4']);
  });

  it('local unlink failure on a processed file: skipped, not pushed, S3 not called for it', async () => {
    s3.S3_ENABLED = true;
    let call = 0;
    spy(vi.spyOn(fs, 'existsSync').mockReturnValue(true));
    // First unlink (the raw file) ok; second (processed) throws.
    spy(vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      call++;
      if (call >= 2) throw new Error('EPERM');
    }));
    spy(vi.spyOn(fs, 'readdirSync').mockReturnValue(['song.wav']));
    const removeSpy = spy(vi.spyOn(s3, 'remove').mockResolvedValue(undefined));
    const router = fileManager('/music');
    const handler = getRouteHandler(router, 'delete', '/:name');
    const res = mockRes();
    await handler({ params: { name: 'song.mp3' } }, res);

    // processed file not pushed (local unlink failed before push).
    expect(res.body.processedDeleted).toBeUndefined();
    // S3 remove was called for the raw key only, never the processed one.
    expect(removeSpy).toHaveBeenCalledWith('music/raw/song.mp3');
    expect(removeSpy).not.toHaveBeenCalledWith('music/processed/song.wav');
  });

  it('S3 cascade failure still pushes the processed file to deleted', async () => {
    s3.S3_ENABLED = true;
    spy(vi.spyOn(fs, 'existsSync').mockReturnValue(true));
    spy(vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {}));
    spy(vi.spyOn(fs, 'readdirSync').mockReturnValue(['song.wav']));
    // raw remove ok, processed remove rejects.
    spy(vi.spyOn(s3, 'remove').mockImplementation(async (key) => {
      if (key === 'music/processed/song.wav') throw new Error('s3 down');
    }));
    const router = fileManager('/music');
    const handler = getRouteHandler(router, 'delete', '/:name');
    const res = mockRes();
    await handler({ params: { name: 'song.mp3' } }, res);
    // Local unlink succeeded, so the file is still recorded as deleted.
    expect(res.body.processedDeleted).toEqual(['song.wav']);
  });
});

describe('dashboard/lib/fileManager.js pollAndDownload (via visuals POST)', () => {
  /** Kick off one transcode submit so pollAndDownload arms its interval. */
  async function arm({ getJob }) {
    transcoder.ENABLED = true;
    spy(vi.spyOn(transcoder, 'submit').mockResolvedValue({ job_id: 'J1', status: 'queued' }));
    spy(vi.spyOn(transcoder, 'getJob').mockImplementation(getJob));
    const router = fileManager('/visuals/incoming');
    const handler = getRouteHandler(router, 'post', '/');
    await handler({ files: [{ filename: 'clip.mov', size: 5, path: '/p' }] }, mockRes());
  }

  it('no immediate first tick: getJob not called until 3000ms elapses', async () => {
    vi.useFakeTimers();
    const getJob = vi.fn().mockResolvedValue({ status: 'processing' });
    await arm({ getJob });
    expect(getJob).not.toHaveBeenCalled(); // submit path does not poll synchronously
    await vi.advanceTimersByTimeAsync(2999);
    expect(getJob).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(getJob).toHaveBeenCalledTimes(1);
    // Still processing -> interval keeps running.
    expect(vi.getTimerCount()).toBe(1);
  });

  it('done: downloads result, creates dir, clears interval', async () => {
    vi.useFakeTimers();
    spy(vi.spyOn(fs, 'existsSync').mockReturnValue(false));
    const mkdir = fs.mkdirSync; // already spied in beforeEach
    const downloadSpy = spy(vi.spyOn(s3, 'download').mockResolvedValue(undefined));
    const getJob = vi.fn().mockResolvedValue({ status: 'done' });
    await arm({ getJob });
    await vi.advanceTimersByTimeAsync(3000);

    expect(downloadSpy).toHaveBeenCalledWith(
      'visuals/processed/clip.mp4',
      path.join('/visuals/.processed', 'clip.mp4')
    );
    expect(mkdir).toHaveBeenCalledWith('/visuals/.processed', { recursive: true });
    expect(vi.getTimerCount()).toBe(0); // cleared after done
  });

  it('error status: clears interval, no download', async () => {
    vi.useFakeTimers();
    const downloadSpy = spy(vi.spyOn(s3, 'download').mockResolvedValue(undefined));
    const getJob = vi.fn().mockResolvedValue({ status: 'error', error: 'ffmpeg' });
    await arm({ getJob });
    await vi.advanceTimersByTimeAsync(3000);
    expect(downloadSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('null job: clears interval immediately', async () => {
    vi.useFakeTimers();
    const getJob = vi.fn().mockResolvedValue(null);
    await arm({ getJob });
    await vi.advanceTimersByTimeAsync(3000);
    expect(getJob).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('getJob throws: keeps polling until 120 attempts, then clears (timeout)', async () => {
    vi.useFakeTimers();
    const getJob = vi.fn().mockRejectedValue(new Error('net'));
    await arm({ getJob });
    // 119 ticks: still polling.
    await vi.advanceTimersByTimeAsync(3000 * 119);
    expect(getJob).toHaveBeenCalledTimes(119);
    expect(vi.getTimerCount()).toBe(1);
    // 120th tick: maxAttempts reached -> cleared.
    await vi.advanceTimersByTimeAsync(3000);
    expect(getJob).toHaveBeenCalledTimes(120);
    expect(vi.getTimerCount()).toBe(0);
  });
});
