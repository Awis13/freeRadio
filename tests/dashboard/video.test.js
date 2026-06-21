/**
 * tests/dashboard/video.test.js
 *
 * Characterization of dashboard/lib/video.js (P1-6).
 *
 * Strategy: video.js reads /shared/current_video.txt synchronously via fs.
 * We drive it with the in-memory mockFsMap helper and SYNCHRONOUS fake
 * timers (poll() is synchronous, so vi.advanceTimersByTime is enough).
 *
 * Pinned here (current behavior):
 *   - poll() is a no-op when the file is absent;
 *   - dedup: onUpdate fires only when the trimmed filename CHANGES; an
 *     unchanged value, empty, or whitespace-only content yields no call;
 *   - title = basename with the final extension stripped; filename =
 *     trimmed raw content; lastVideo updates after each emit;
 *   - start(): immediate poll() then setInterval(2000); stop() clears.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { mockFsMap } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
const { createVideoPoller } = nodeRequire('../../dashboard/lib/video');

const VIDEO_FILE = '/shared/current_video.txt';

let poller;
let fsMap;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers();
});

afterEach(() => {
  if (poller) poller.stop();
  poller = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('dashboard/lib/video.js', () => {
  it('absent file: no onUpdate', () => {
    fsMap = mockFsMap({});
    const onUpdate = vi.fn();
    poller = createVideoPoller(onUpdate);
    poller.start();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('start() polls immediately then setInterval(2000); stop() clears', () => {
    fsMap = mockFsMap({ [VIDEO_FILE]: 'clip.mp4' });
    const onUpdate = vi.fn();
    poller = createVideoPoller(onUpdate);

    poller.start();
    // First emit on the immediate poll.
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Unchanged across ticks -> dedup keeps it at 1.
    vi.advanceTimersByTime(6000);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    poller.stop();
    fsMap.files[VIDEO_FILE] = 'other.mp4';
    vi.advanceTimersByTime(10000);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('title strips the final extension; filename is the trimmed raw content', () => {
    fsMap = mockFsMap({ [VIDEO_FILE]: '  cool clip.final.mp4  \n' });
    const onUpdate = vi.fn();
    poller = createVideoPoller(onUpdate);
    poller.start();
    expect(onUpdate).toHaveBeenCalledWith({
      title: 'cool clip.final',
      filename: 'cool clip.final.mp4'
    });
  });

  it('basename is taken from a path-like value', () => {
    fsMap = mockFsMap({ [VIDEO_FILE]: 'sub/dir/movie.webm' });
    const onUpdate = vi.fn();
    poller = createVideoPoller(onUpdate);
    poller.start();
    expect(onUpdate).toHaveBeenCalledWith({ title: 'movie', filename: 'sub/dir/movie.webm' });
  });

  it('dedup: a changed value emits once, then stays quiet until it changes again', () => {
    fsMap = mockFsMap({ [VIDEO_FILE]: 'a.mp4' });
    const onUpdate = vi.fn();
    poller = createVideoPoller(onUpdate);
    poller.start();
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Same content (with surrounding whitespace) -> still deduped.
    fsMap.files[VIDEO_FILE] = '  a.mp4 ';
    vi.advanceTimersByTime(2000);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    fsMap.files[VIDEO_FILE] = 'b.mp4';
    vi.advanceTimersByTime(2000);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenLastCalledWith({ title: 'b', filename: 'b.mp4' });
  });

  it('empty / whitespace-only content: no onUpdate', () => {
    fsMap = mockFsMap({ [VIDEO_FILE]: '   \n\t ' });
    const onUpdate = vi.fn();
    poller = createVideoPoller(onUpdate);
    poller.start();
    expect(onUpdate).not.toHaveBeenCalled();

    fsMap.files[VIDEO_FILE] = '';
    vi.advanceTimersByTime(2000);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
