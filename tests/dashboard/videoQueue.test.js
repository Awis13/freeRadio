/**
 * tests/dashboard/videoQueue.test.js
 *
 * Unit tests for dashboard/lib/videoQueue.js — video queue file management.
 * Tests: getQueue, push, clear, skip.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

const QUEUE_FILE = '/shared/video_queue.txt';
const SKIP_FILE = '/shared/video_skip';

let files = {};

beforeEach(() => {
  files = {};
  vi.restoreAllMocks();

  vi.spyOn(fs, 'existsSync').mockImplementation(p => p in files);
  vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
    if (p in files) return files[p];
    throw new Error('ENOENT');
  });
  vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
    files[p] = data;
  });
  vi.spyOn(fs, 'appendFileSync').mockImplementation((p, data) => {
    files[p] = (files[p] || '') + data;
  });
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
});

const { getQueue, push, clear, skip } =
  await import('../../dashboard/lib/videoQueue.js');

// ---------------------------------------------------------------------------
// getQueue
// ---------------------------------------------------------------------------
describe('getQueue', () => {
  it('returns empty array when no file exists', () => {
    expect(getQueue()).toEqual([]);
  });

  it('returns empty array for empty file', () => {
    files[QUEUE_FILE] = '';
    expect(getQueue()).toEqual([]);
  });

  it('returns empty array for whitespace-only file', () => {
    files[QUEUE_FILE] = '   \n  \n  ';
    expect(getQueue()).toEqual([]);
  });

  it('returns single entry', () => {
    files[QUEUE_FILE] = 'video1.mp4\n';
    expect(getQueue()).toEqual(['video1.mp4']);
  });

  it('returns multiple entries', () => {
    files[QUEUE_FILE] = 'video1.mp4\nvideo2.mp4\nvideo3.mp4\n';
    expect(getQueue()).toEqual(['video1.mp4', 'video2.mp4', 'video3.mp4']);
  });

  it('filters out blank lines', () => {
    files[QUEUE_FILE] = 'video1.mp4\n\nvideo2.mp4\n\n';
    expect(getQueue()).toEqual(['video1.mp4', 'video2.mp4']);
  });

  it('returns empty array on read error', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('EPERM'); });
    expect(getQueue()).toEqual([]);
  });

  // Quirk: only the whole-content is trim()'d, not each line. Inner whitespace
  // lines survive split('\n') because filter(Boolean) only drops EMPTY strings,
  // and a "   " line is truthy -> it is kept verbatim.
  it('keeps whitespace-only inner lines (only outer content is trimmed)', () => {
    files[QUEUE_FILE] = 'video1.mp4\n   \nvideo2.mp4\n';
    expect(getQueue()).toEqual(['video1.mp4', '   ', 'video2.mp4']);
  });

  // Quirk: entries are NOT individually trimmed; an interior CRLF leaves a
  // trailing \r on that entry. Only the LAST entry loses its \r because the
  // whole-content trim() strips the final '\r\n'.
  it('does not strip interior carriage returns but the outer trim drops the last', () => {
    files[QUEUE_FILE] = 'video1.mp4\r\nvideo2.mp4\r\n';
    expect(getQueue()).toEqual(['video1.mp4\r', 'video2.mp4']);
  });
});

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------
describe('push', () => {
  it('appends filename to queue file', () => {
    push('video1.mp4');
    expect(files[QUEUE_FILE]).toBe('video1.mp4\n');
  });

  it('appends to existing content', () => {
    files[QUEUE_FILE] = 'video1.mp4\n';
    push('video2.mp4');
    expect(files[QUEUE_FILE]).toBe('video1.mp4\nvideo2.mp4\n');
  });

  it('trims whitespace from filename', () => {
    push('  video1.mp4  ');
    expect(files[QUEUE_FILE]).toBe('video1.mp4\n');
  });

  it('creates directory if needed', () => {
    push('video1.mp4');
    expect(fs.mkdirSync).toHaveBeenCalled();
  });

  // Quirk: push() only trims the OUTER whitespace of the filename, then appends
  // exactly one '\n'. Inner whitespace is preserved verbatim.
  it('preserves inner whitespace and appends exactly one newline', () => {
    push('  my video.mp4  ');
    expect(files[QUEUE_FILE]).toBe('my video.mp4\n');
  });

  // Quirk: unlike clear(), push() does NOT swallow errors. A failing mkdirSync
  // propagates to the caller.
  it('propagates mkdirSync errors (no swallow)', () => {
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(() => push('video1.mp4')).toThrow('EACCES');
  });

  // Quirk: a filename that is only whitespace becomes a bare '\n' line after
  // trim(), which getQueue() would then filter out as blank.
  it('writes a bare newline for a whitespace-only filename', () => {
    push('   ');
    expect(files[QUEUE_FILE]).toBe('\n');
  });
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------
describe('clear', () => {
  it('writes empty string to queue file', () => {
    files[QUEUE_FILE] = 'video1.mp4\nvideo2.mp4\n';
    clear();
    expect(files[QUEUE_FILE]).toBe('');
  });

  it('does not throw when file does not exist', () => {
    expect(() => clear()).not.toThrow();
  });

  // Pins line 26: clear() swallows any write error silently (empty catch).
  // The throwing writeFileSync is caught and clear() returns undefined.
  it('swallows write errors silently', () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('EPERM');
    });
    expect(() => clear()).not.toThrow();
    expect(clear()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// skip
// ---------------------------------------------------------------------------
describe('skip', () => {
  it('creates skip file', () => {
    skip();
    expect(files[SKIP_FILE]).toBeDefined();
  });

  it('writes empty content to skip file', () => {
    skip();
    expect(files[SKIP_FILE]).toBe('');
  });

  it('creates directory if needed', () => {
    skip();
    expect(fs.mkdirSync).toHaveBeenCalled();
  });
});
