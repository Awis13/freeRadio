/**
 * tests/dashboard/bpmMap.test.js
 *
 * Unit tests for dashboard/lib/bpmMap.js — BPM map polling.
 * Tests parseBpmMap indirectly through createBpmMapPoller.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';

const BPM_MAP_PATH = '/music/.bpm_map';
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

const { createBpmMapPoller } =
  await import('../../dashboard/lib/bpmMap.js');

// ---------------------------------------------------------------------------
// parseBpmMap via createBpmMapPoller
// ---------------------------------------------------------------------------
describe('createBpmMapPoller', () => {
  it('calls onUpdate with parsed BPM map on start()', () => {
    files[BPM_MAP_PATH] = '/music/track_a.mp3|142.5\n/music/track_b.mp3|138.0\n';
    const onUpdate = vi.fn();
    const poller = createBpmMapPoller(BPM_MAP_PATH, onUpdate);
    poller.start();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const map = onUpdate.mock.calls[0][0];
    expect(map['track_a.mp3']).toBe(142.5);
    expect(map['track_b.mp3']).toBe(138.0);

    poller.stop();
  });

  it('extracts just filename from full path', () => {
    files[BPM_MAP_PATH] = '/music/processed/deep_track.flac|155.3\n';
    const onUpdate = vi.fn();
    const poller = createBpmMapPoller(BPM_MAP_PATH, onUpdate);
    poller.start();

    const map = onUpdate.mock.calls[0][0];
    expect(map['deep_track.flac']).toBe(155.3);
    expect(map['/music/processed/deep_track.flac']).toBeUndefined();

    poller.stop();
  });

  it('skips blank lines', () => {
    files[BPM_MAP_PATH] = '/music/a.mp3|140\n\n\n/music/b.mp3|150\n';
    const onUpdate = vi.fn();
    const poller = createBpmMapPoller(BPM_MAP_PATH, onUpdate);
    poller.start();

    const map = onUpdate.mock.calls[0][0];
    expect(Object.keys(map).length).toBe(2);

    poller.stop();
  });

  it('skips lines without pipe separator', () => {
    files[BPM_MAP_PATH] = '/music/a.mp3|140\nno_pipe_here\n/music/b.mp3|150\n';
    const onUpdate = vi.fn();
    const poller = createBpmMapPoller(BPM_MAP_PATH, onUpdate);
    poller.start();

    const map = onUpdate.mock.calls[0][0];
    expect(Object.keys(map).length).toBe(2);

    poller.stop();
  });

  it('skips entries with non-numeric BPM', () => {
    files[BPM_MAP_PATH] = '/music/a.mp3|140\n/music/b.mp3|not_a_number\n';
    const onUpdate = vi.fn();
    const poller = createBpmMapPoller(BPM_MAP_PATH, onUpdate);
    poller.start();

    const map = onUpdate.mock.calls[0][0];
    expect(Object.keys(map).length).toBe(1);
    expect(map['a.mp3']).toBe(140);

    poller.stop();
  });

  it('handles empty file', () => {
    files[BPM_MAP_PATH] = '';
    const onUpdate = vi.fn();
    const poller = createBpmMapPoller(BPM_MAP_PATH, onUpdate);
    poller.start();

    const map = onUpdate.mock.calls[0][0];
    expect(Object.keys(map).length).toBe(0);

    poller.stop();
  });

  it('does not crash when file does not exist', () => {
    const onUpdate = vi.fn();
    const poller = createBpmMapPoller(BPM_MAP_PATH, onUpdate);
    poller.start();

    // onUpdate should not be called when file doesn't exist
    expect(onUpdate).not.toHaveBeenCalled();

    poller.stop();
  });

  it('polls at interval', () => {
    files[BPM_MAP_PATH] = '/music/a.mp3|140\n';
    const onUpdate = vi.fn();
    const poller = createBpmMapPoller(BPM_MAP_PATH, onUpdate);
    poller.start();

    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Advance 20 seconds (poll interval)
    vi.advanceTimersByTime(20000);
    expect(onUpdate).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(20000);
    expect(onUpdate).toHaveBeenCalledTimes(3);

    poller.stop();
  });

  it('stop() clears the interval', () => {
    files[BPM_MAP_PATH] = '/music/a.mp3|140\n';
    const onUpdate = vi.fn();
    const poller = createBpmMapPoller(BPM_MAP_PATH, onUpdate);
    poller.start();
    poller.stop();

    vi.advanceTimersByTime(60000);
    // Should only have been called once (the initial poll)
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});
