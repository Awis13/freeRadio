/**
 * tests/dashboard/rtmpHealth.test.js
 *
 * Characterization of dashboard/lib/rtmpHealth.js (P1-6).
 *
 * Strategy: rtmpHealth reads /shared/rtmp_status.json synchronously and
 * JSON.parses it. mockFsMap drives the read; SYNCHRONOUS fake timers drive
 * the poll loop.
 *
 * CORRECTION TO AUDIT: the catch block is EMPTY. On a file-absent OR
 * invalid-JSON (torn write) read, onUpdate is NOT called — silent no-op,
 * last good state is preserved by the consumer. We pin THIS real behavior:
 *   - valid JSON -> onUpdate(parsedData);
 *   - missing file OR parse failure -> NO onUpdate (no onUpdate({}) call);
 *   - start(): immediate poll + setInterval(2000); stop() clears.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { mockFsMap } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
const { createRtmpHealthPoller } = nodeRequire('../../dashboard/lib/rtmpHealth');

const STATUS_FILE = '/shared/rtmp_status.json';

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

describe('dashboard/lib/rtmpHealth.js', () => {
  it('valid JSON -> onUpdate(parsedData) on the immediate poll', () => {
    fsMap = mockFsMap({ [STATUS_FILE]: JSON.stringify({ alive: true, bitrate: 4500 }) });
    const onUpdate = vi.fn();
    poller = createRtmpHealthPoller(onUpdate);
    poller.start();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ alive: true, bitrate: 4500 });
  });

  it('missing file -> NO onUpdate (empty catch, not onUpdate({}))', () => {
    fsMap = mockFsMap({});
    const onUpdate = vi.fn();
    poller = createRtmpHealthPoller(onUpdate);
    poller.start();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('invalid JSON (torn read) -> NO onUpdate, last good state preserved', () => {
    fsMap = mockFsMap({ [STATUS_FILE]: JSON.stringify({ alive: true }) });
    const onUpdate = vi.fn();
    poller = createRtmpHealthPoller(onUpdate);
    poller.start();
    expect(onUpdate).toHaveBeenCalledTimes(1); // good read

    // Next tick the file is mid-write (truncated JSON).
    fsMap.files[STATUS_FILE] = '{"alive": tr';
    vi.advanceTimersByTime(2000);
    // Parse fails -> empty catch -> NO further call, value held at 1.
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Recovery: valid JSON again -> onUpdate fires with the new data.
    fsMap.files[STATUS_FILE] = JSON.stringify({ alive: false });
    vi.advanceTimersByTime(2000);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenLastCalledWith({ alive: false });
  });

  it('start() polls immediately then setInterval(2000); stop() clears', () => {
    fsMap = mockFsMap({ [STATUS_FILE]: JSON.stringify({ n: 1 }) });
    const onUpdate = vi.fn();
    poller = createRtmpHealthPoller(onUpdate);
    poller.start();
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Each tick re-reads and re-emits (no dedup in this poller).
    vi.advanceTimersByTime(2000);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2000);
    expect(onUpdate).toHaveBeenCalledTimes(3);

    poller.stop();
    vi.advanceTimersByTime(10000);
    expect(onUpdate).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
