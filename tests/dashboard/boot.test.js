/**
 * tests/dashboard/boot.test.js
 *
 * Unit tests for dashboard/lib/boot.js — boot sequence.
 * Tests: abort flag, S3 sync, Liquidsoap probe, fallback cue.
 *
 * FAKE CLOCK. boot() sleeps 1000ms before its first Liquidsoap probe and
 * RETRY_INTERVAL (2000ms) between failed attempts (boot.js:70-88). Waiting those
 * out for real cost this file ~7s of the suite, so it runs on vi.useFakeTimers()
 * and steps the clock explicitly instead — the delays below mirror the ones
 * boot.js schedules, so the same retry/abort paths run, just without the wall
 * clock. These are plain node timers (boot.js runs server-side, not in a jsdom
 * realm), so no capture-spy is needed to reach them.
 *
 * Advancement must be the ASYNC variant: boot() awaits a promise around each
 * timer, so the microtask queue has to drain between steps or the next timer is
 * never even scheduled. The probe stubs below answer on their own 0ms/1ms
 * timers, which is why each probe needs a step of its own.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const boot = require('../../dashboard/lib/boot');
const liqClient = require('../../dashboard/lib/liqClient');
const s3 = require('../../dashboard/lib/s3');
const streamControl = require('../../dashboard/lib/streamControl');
const fs = require('fs');
const http = require('http');

// ─── Helpers ──────────────────────────────────────────────────

let spies = [];

function mockProbeResponse(data) {
  const spy = vi.spyOn(http, 'get').mockImplementation((opts, callback) => {
    const req = {
      on: vi.fn().mockReturnThis(),
      destroy: vi.fn()
    };
    if (callback) {
      const res = {
        on: vi.fn((event, handler) => {
          if (event === 'data') setTimeout(() => handler(JSON.stringify(data)), 0);
          if (event === 'end') setTimeout(() => handler(), 1);
          return res;
        })
      };
      setTimeout(() => callback(res), 0);
    }
    return req;
  });
  spies.push(spy);
  return spy;
}

function mockProbeError(err) {
  const spy = vi.spyOn(http, 'get').mockImplementation((opts, callback) => {
    const req = {
      on: vi.fn((event, handler) => {
        if (event === 'error') setTimeout(() => handler(err), 0);
        return req;
      }),
      destroy: vi.fn()
    };
    return req;
  });
  spies.push(spy);
  return spy;
}

/**
 * Drive boot() to completion on the fake clock.
 *
 * `steps` are the delays boot() itself schedules, advanced in order and each
 * awaited so the promises it chains around those timers settle before the next
 * step — that is what makes the retry/abort sequencing real rather than a
 * single jump to the end.
 *
 * Each step must also reach PAST the delay it drives: a timer created AT the
 * boundary of an advance window is not run by that same call, and the probe
 * stubs queue their 0ms/1ms response exactly there (measured: after a bare
 * 1000ms step the stub's response timer is still pending). Hence the few extra
 * milliseconds on the step that follows a probe.
 *
 * Draining with runAllTimersAsync() is NOT an option: the S3 path starts the
 * real syncWatcher, whose polls reschedule themselves every 30s/60s forever
 * (syncWatcher.js:301-317), so running all timers never terminates.
 */
async function runBoot(steps) {
  const booting = boot.boot({ musicDir: '/music', visualsDir: '/visuals' });
  for (const ms of steps) {
    await vi.advanceTimersByTimeAsync(ms);
  }
  return booting;
}

beforeEach(() => {
  vi.useFakeTimers();
  spies.forEach(s => s.mockRestore());
  spies = [];
  boot.setBootAborted(false);
});

afterEach(() => {
  spies.forEach(s => s.mockRestore());
  spies = [];
  // Never leave a fake clock installed for the next file in this worker.
  vi.useRealTimers();
});

// ─── setBootAborted / isBootAborted ───────────────────────────

describe('boot abort flag', () => {
  it('defaults to false after reset', () => {
    boot.setBootAborted(false);
    expect(boot.isBootAborted()).toBe(false);
  });

  it('can be set to true', () => {
    boot.setBootAborted(true);
    expect(boot.isBootAborted()).toBe(true);
  });

  it('can be toggled', () => {
    boot.setBootAborted(true);
    expect(boot.isBootAborted()).toBe(true);
    boot.setBootAborted(false);
    expect(boot.isBootAborted()).toBe(false);
  });
});

// ─── boot() with Liquidsoap already playing ───────────────────

describe('boot() — Liquidsoap already playing', () => {
  it('reads saved mode and stops playback without changing state', async () => {
    const origEnabled = s3.S3_ENABLED;
    s3.S3_ENABLED = false;
    try {
      mockProbeResponse({ playing: true });
      spies.push(vi.spyOn(streamControl, 'getModeState').mockReturnValue({ mode: 'standby', standbyVisual: null }));
      spies.push(vi.spyOn(streamControl, 'setModeState').mockImplementation(() => {}));
      spies.push(vi.spyOn(liqClient, 'stopPlayback').mockResolvedValue());

      // 1000ms pre-probe sleep, then the probe stub's data/end timers.
      await runBoot([1000, 5]);

      expect(streamControl.getModeState).toHaveBeenCalled();
      expect(liqClient.stopPlayback).toHaveBeenCalled();
      expect(streamControl.setModeState).not.toHaveBeenCalled();
    } finally {
      s3.S3_ENABLED = origEnabled;
    }
  });
});

// ─── boot() — saved mode live ────────────────────────────────

describe('boot() — saved mode live', () => {
  it('stops playback and does not change mode state when saved mode is live', async () => {
    const origEnabled = s3.S3_ENABLED;
    s3.S3_ENABLED = false;
    try {
      mockProbeResponse({ playing: true });
      spies.push(vi.spyOn(streamControl, 'getModeState').mockReturnValue({ mode: 'live', standbyVisual: null }));
      spies.push(vi.spyOn(streamControl, 'setModeState').mockImplementation(() => {}));
      spies.push(vi.spyOn(liqClient, 'stopPlayback').mockResolvedValue());

      // 1000ms pre-probe sleep, then the probe stub's data/end timers.
      await runBoot([1000, 5]);

      expect(streamControl.getModeState).toHaveBeenCalled();
      expect(liqClient.stopPlayback).toHaveBeenCalled();
      expect(streamControl.setModeState).not.toHaveBeenCalled();
    } finally {
      s3.S3_ENABLED = origEnabled;
    }
  });
});

// ─── boot() aborted ──────────────────────────────────────────

describe('boot() — aborted', () => {
  it('stops early when bootAborted is set during probe loop', async () => {
    const origEnabled = s3.S3_ENABLED;
    s3.S3_ENABLED = false;
    try {
      mockProbeError(new Error('connection refused'));
      spies.push(vi.spyOn(streamControl, 'getModeState').mockReturnValue({ mode: 'standby', standbyVisual: null }));
      spies.push(vi.spyOn(liqClient, 'stopPlayback').mockResolvedValue());

      // Set abort flag after the 1s initial delay, during the probe retry sleep
      setTimeout(() => boot.setBootAborted(true), 1500);

      // 1000ms pre-probe sleep -> attempt 1 fails -> 2000ms RETRY_INTERVAL. The
      // abort lands at 1500ms, mid-sleep, so attempt 2 returns at 3000ms without
      // ever reaching stopPlayback.
      await runBoot([1000, 500, 1600]);

      expect(liqClient.stopPlayback).not.toHaveBeenCalled();
    } finally {
      s3.S3_ENABLED = origEnabled;
    }
  });
});

// ─── boot() with S3 ──────────────────────────────────────────

describe('boot() — S3 sync', () => {
  it('runs S3 sync when enabled', async () => {
    const origEnabled = s3.S3_ENABLED;
    s3.S3_ENABLED = true;
    try {
      mockProbeResponse({ playing: true });
      spies.push(vi.spyOn(s3, 'syncDir').mockResolvedValue());
      spies.push(vi.spyOn(s3, 'ensureCached').mockResolvedValue());
      spies.push(vi.spyOn(streamControl, 'getModeState').mockReturnValue({ mode: 'standby', standbyVisual: null }));
      spies.push(vi.spyOn(liqClient, 'stopPlayback').mockResolvedValue());

      // The S3 hop resolves on microtasks, so the timed steps are unchanged:
      // 1000ms pre-probe sleep, then the probe stub's data/end timers.
      await runBoot([1000, 5]);

      expect(s3.syncDir).toHaveBeenCalledWith('music/processed/', '/music/processed');
    } finally {
      s3.S3_ENABLED = origEnabled;
    }
  });

  it('continues boot when S3 sync fails', async () => {
    const origEnabled = s3.S3_ENABLED;
    s3.S3_ENABLED = true;
    try {
      mockProbeResponse({ playing: true });
      spies.push(vi.spyOn(s3, 'syncDir').mockRejectedValue(new Error('S3 down')));
      spies.push(vi.spyOn(s3, 'ensureCached').mockRejectedValue(new Error('S3 down')));
      spies.push(vi.spyOn(streamControl, 'getModeState').mockReturnValue({ mode: 'standby', standbyVisual: null }));
      spies.push(vi.spyOn(streamControl, 'setModeState').mockImplementation(() => {}));
      spies.push(vi.spyOn(liqClient, 'stopPlayback').mockResolvedValue());

      // Same steps as the success path: the rejected sync is caught and boot
      // continues into the probe loop on the very same schedule.
      await runBoot([1000, 5]);

      expect(liqClient.stopPlayback).toHaveBeenCalled();
      expect(streamControl.setModeState).not.toHaveBeenCalled();
    } finally {
      s3.S3_ENABLED = origEnabled;
    }
  });
});
