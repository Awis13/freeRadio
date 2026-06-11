/**
 * tests/dashboard/ffmpeg.test.js
 *
 * Unit tests for dashboard/lib/ffmpeg.js — FFmpeg progress file parsing.
 * Tests parseProgress indirectly through createFfmpegPoller.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';

const PROGRESS_FILE = '/tmp/ffmpeg_progress.txt';
let files = {};

beforeEach(() => {
  files = {};
  vi.useFakeTimers();
  vi.restoreAllMocks();

  vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
    if (p in files) return files[p];
    throw new Error('ENOENT');
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const { createFfmpegPoller } =
  await import('../../dashboard/lib/ffmpeg.js');

// ---------------------------------------------------------------------------
// parseProgress via createFfmpegPoller
// ---------------------------------------------------------------------------
describe('parseProgress via poller', () => {
  it('parses standard FFmpeg progress output', () => {
    files[PROGRESS_FILE] = 'frame=1234\nfps=30.0\nbitrate=8500kbits/s\nout_time=00:05:30.123\nspeed=1.0x\n';
    const onUpdate = vi.fn();
    const poller = createFfmpegPoller(PROGRESS_FILE, onUpdate);
    poller.start();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const data = onUpdate.mock.calls[0][0];
    expect(data.frame).toBe('1234');
    expect(data.fps).toBe('30.0');
    expect(data.bitrate).toBe('8500kbits/s');
    expect(data.time).toBe('00:05:30.123');
    expect(data.speed).toBe('1.0x');

    poller.stop();
  });

  it('returns empty strings for missing fields', () => {
    files[PROGRESS_FILE] = 'frame=100\n';
    const onUpdate = vi.fn();
    const poller = createFfmpegPoller(PROGRESS_FILE, onUpdate);
    poller.start();

    const data = onUpdate.mock.calls[0][0];
    expect(data.frame).toBe('100');
    expect(data.fps).toBe('');
    expect(data.bitrate).toBe('');
    expect(data.time).toBe('');
    expect(data.speed).toBe('');

    poller.stop();
  });

  it('handles empty file', () => {
    files[PROGRESS_FILE] = '';
    const onUpdate = vi.fn();
    const poller = createFfmpegPoller(PROGRESS_FILE, onUpdate);
    poller.start();

    const data = onUpdate.mock.calls[0][0];
    expect(data.frame).toBe('');
    expect(data.fps).toBe('');
    expect(data.bitrate).toBe('');
    expect(data.time).toBe('');
    expect(data.speed).toBe('');

    poller.stop();
  });

  it('handles whitespace around keys and values', () => {
    files[PROGRESS_FILE] = '  frame = 500  \n  fps = 29.97  \n';
    const onUpdate = vi.fn();
    const poller = createFfmpegPoller(PROGRESS_FILE, onUpdate);
    poller.start();

    const data = onUpdate.mock.calls[0][0];
    expect(data.frame).toBe('500');
    expect(data.fps).toBe('29.97');

    poller.stop();
  });

  it('skips lines without equals sign', () => {
    files[PROGRESS_FILE] = 'frame=200\nno_equals_here\nfps=25\n';
    const onUpdate = vi.fn();
    const poller = createFfmpegPoller(PROGRESS_FILE, onUpdate);
    poller.start();

    const data = onUpdate.mock.calls[0][0];
    expect(data.frame).toBe('200');
    expect(data.fps).toBe('25');

    poller.stop();
  });

  it('uses out_time for time field', () => {
    files[PROGRESS_FILE] = 'out_time=01:23:45.678\n';
    const onUpdate = vi.fn();
    const poller = createFfmpegPoller(PROGRESS_FILE, onUpdate);
    poller.start();

    expect(onUpdate.mock.calls[0][0].time).toBe('01:23:45.678');

    poller.stop();
  });

  it('clears bitrate when total_size is present', () => {
    files[PROGRESS_FILE] = 'bitrate=5000kbits/s\ntotal_size=123456\n';
    const onUpdate = vi.fn();
    const poller = createFfmpegPoller(PROGRESS_FILE, onUpdate);
    poller.start();

    expect(onUpdate.mock.calls[0][0].bitrate).toBe('');

    poller.stop();
  });

  it('returns bitrate when total_size is absent', () => {
    files[PROGRESS_FILE] = 'bitrate=5000kbits/s\n';
    const onUpdate = vi.fn();
    const poller = createFfmpegPoller(PROGRESS_FILE, onUpdate);
    poller.start();

    expect(onUpdate.mock.calls[0][0].bitrate).toBe('5000kbits/s');

    poller.stop();
  });

  it('returns consistent object shape with all five fields', () => {
    files[PROGRESS_FILE] = 'frame=1\n';
    const onUpdate = vi.fn();
    const poller = createFfmpegPoller(PROGRESS_FILE, onUpdate);
    poller.start();

    const data = onUpdate.mock.calls[0][0];
    expect(data).toHaveProperty('frame');
    expect(data).toHaveProperty('fps');
    expect(data).toHaveProperty('bitrate');
    expect(data).toHaveProperty('time');
    expect(data).toHaveProperty('speed');

    poller.stop();
  });

  it('handles value containing equals sign', () => {
    files[PROGRESS_FILE] = 'frame=100\nbitrate=N/A\n';
    const onUpdate = vi.fn();
    const poller = createFfmpegPoller(PROGRESS_FILE, onUpdate);
    poller.start();

    expect(onUpdate.mock.calls[0][0].bitrate).toBe('N/A');

    poller.stop();
  });
});

// ---------------------------------------------------------------------------
// createFfmpegPoller behavior
// ---------------------------------------------------------------------------
describe('createFfmpegPoller', () => {
  it('does not call onUpdate when file does not exist', () => {
    const onUpdate = vi.fn();
    const poller = createFfmpegPoller(PROGRESS_FILE, onUpdate);
    poller.start();

    expect(onUpdate).not.toHaveBeenCalled();
    poller.stop();
  });

  it('does not call onUpdate when progressFile is null', () => {
    const onUpdate = vi.fn();
    const poller = createFfmpegPoller(null, onUpdate);
    poller.start();

    expect(onUpdate).not.toHaveBeenCalled();
    poller.stop();
  });

  it('polls at 3-second interval', () => {
    files[PROGRESS_FILE] = 'frame=1\n';
    const onUpdate = vi.fn();
    const poller = createFfmpegPoller(PROGRESS_FILE, onUpdate);
    poller.start();

    expect(onUpdate).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3000);
    expect(onUpdate).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(3000);
    expect(onUpdate).toHaveBeenCalledTimes(3);

    poller.stop();
  });

  it('stop() clears the interval', () => {
    files[PROGRESS_FILE] = 'frame=1\n';
    const onUpdate = vi.fn();
    const poller = createFfmpegPoller(PROGRESS_FILE, onUpdate);
    poller.start();
    poller.stop();

    vi.advanceTimersByTime(30000);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('reflects updated file content on next poll', () => {
    files[PROGRESS_FILE] = 'frame=1\nfps=10\n';
    const onUpdate = vi.fn();
    const poller = createFfmpegPoller(PROGRESS_FILE, onUpdate);
    poller.start();

    expect(onUpdate.mock.calls[0][0].frame).toBe('1');

    files[PROGRESS_FILE] = 'frame=500\nfps=30\n';
    vi.advanceTimersByTime(3000);

    expect(onUpdate.mock.calls[1][0].frame).toBe('500');
    expect(onUpdate.mock.calls[1][0].fps).toBe('30');

    poller.stop();
  });
});
