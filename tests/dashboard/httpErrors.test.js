/**
 * tests/dashboard/httpErrors.test.js
 *
 * Unit tests for dashboard/lib/httpErrors.js — the two shared error responses.
 *
 * uploadErrorHandler is exercised directly rather than through a mounted app:
 * what matters is the classification (which errors become 400s and which are
 * handed on untouched), and calling it with an explicit `next` spy is the only
 * way to observe the pass-through arm at all. The mounted-app path is covered
 * where it actually runs, in overlay.test.js's non-image upload.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import { mockRes } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
const { upstreamError, uploadErrorHandler } = nodeRequire('../../dashboard/lib/httpErrors');
const multer = nodeRequire('multer');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('upstreamError', () => {
  it('answers 502 naming the upstream the caller passed', () => {
    const res = mockRes();
    upstreamError(res, new Error('ECONNREFUSED'), 'liquidsoap');

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'liquidsoap unavailable' });
  });

  it('logs the real cause, which the hand-written catches used to drop', () => {
    upstreamError(mockRes(), new Error('ECONNREFUSED'), 'DJ');

    expect(console.error).toHaveBeenCalledWith('[DJ] request failed: ECONNREFUSED');
  });

  it('survives a thrown non-Error without masking the 502', () => {
    const res = mockRes();
    upstreamError(res, 'just a string', 's3');

    expect(res.statusCode).toBe(502);
    expect(console.error).toHaveBeenCalledWith('[s3] request failed: just a string');
  });
});

describe('uploadErrorHandler', () => {
  it('turns a multer rejection into a 400 carrying its message', () => {
    const res = mockRes();
    const next = vi.fn();
    // What a file over `limits.fileSize` produces.
    uploadErrorHandler(new multer.MulterError('LIMIT_FILE_SIZE', 'file'), {}, res, next);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('File too large');
    expect(next).not.toHaveBeenCalled();
  });

  it('honours a status the error already carries', () => {
    // Both overlay's fileFilter rejection and body-parser's malformed-JSON
    // error arrive this way.
    const res = mockRes();
    const err = Object.assign(new Error('Only image files allowed'), { status: 400 });
    uploadErrorHandler(err, {}, res, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Only image files allowed' });
  });

  it('reads statusCode as well as status', () => {
    const res = mockRes();
    uploadErrorHandler(Object.assign(new Error('nope'), { statusCode: 413 }), {}, res, vi.fn());

    expect(res.statusCode).toBe(413);
  });

  it('passes a genuine bug through instead of laundering it into a 400', () => {
    // The whole point of classifying rather than blanket-400ing: an untagged
    // Error is a crash, and it has to stay a 500.
    const res = mockRes();
    const next = vi.fn();
    const bug = new TypeError('x is not a function');
    uploadErrorHandler(bug, {}, res, next);

    expect(next).toHaveBeenCalledWith(bug);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('passes through once the response is already on the wire', () => {
    const res = mockRes();
    res.headersSent = true;
    const next = vi.fn();
    const err = Object.assign(new Error('too late'), { status: 400 });
    uploadErrorHandler(err, {}, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.json).not.toHaveBeenCalled();
  });

  it('is inert when Express calls it with no error', () => {
    const next = vi.fn();
    uploadErrorHandler(null, {}, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
  });
});
