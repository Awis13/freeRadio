/**
 * tests/dashboard/boot.test.js
 *
 * Unit tests for dashboard/lib/boot.js — boot sequence.
 * Tests: abort flag, S3 sync, Liquidsoap probe, fallback cue.
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

beforeEach(() => {
  spies.forEach(s => s.mockRestore());
  spies = [];
  boot.setBootAborted(false);
});

afterEach(() => {
  spies.forEach(s => s.mockRestore());
  spies = [];
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
    mockProbeResponse({ playing: true });
    spies.push(vi.spyOn(streamControl, 'getModeState').mockReturnValue({ mode: 'standby', standbyVisual: null }));
    spies.push(vi.spyOn(streamControl, 'setModeState').mockImplementation(() => {}));
    spies.push(vi.spyOn(liqClient, 'stopPlayback').mockResolvedValue());

    await boot.boot({ musicDir: '/music', visualsDir: '/visuals' });

    expect(streamControl.getModeState).toHaveBeenCalled();
    expect(liqClient.stopPlayback).toHaveBeenCalled();
    expect(streamControl.setModeState).not.toHaveBeenCalled();
    s3.S3_ENABLED = origEnabled;
  });
});

// ─── boot() aborted ──────────────────────────────────────────

describe('boot() — aborted', () => {
  it('stops early when bootAborted is set during probe loop', async () => {
    const origEnabled = s3.S3_ENABLED;
    s3.S3_ENABLED = false;
    mockProbeError(new Error('connection refused'));
    spies.push(vi.spyOn(streamControl, 'getModeState').mockReturnValue({ mode: 'standby', standbyVisual: null }));
    spies.push(vi.spyOn(streamControl, 'setModeState').mockImplementation(() => {}));

    // Set abort flag after the 1s initial delay, during the probe retry sleep
    setTimeout(() => boot.setBootAborted(true), 1500);

    await boot.boot({ musicDir: '/music', visualsDir: '/visuals' });

    expect(streamControl.setModeState).not.toHaveBeenCalled();
    s3.S3_ENABLED = origEnabled;
  }, 15000);
});

// ─── boot() with S3 ──────────────────────────────────────────

describe('boot() — S3 sync', () => {
  it('runs S3 sync when enabled', async () => {
    const origEnabled = s3.S3_ENABLED;
    s3.S3_ENABLED = true;
    mockProbeResponse({ playing: true });
    spies.push(vi.spyOn(s3, 'syncDir').mockResolvedValue());
    spies.push(vi.spyOn(s3, 'ensureCached').mockResolvedValue());
    spies.push(vi.spyOn(streamControl, 'getModeState').mockReturnValue({ mode: 'standby', standbyVisual: null }));
    spies.push(vi.spyOn(streamControl, 'setModeState').mockImplementation(() => {}));
    spies.push(vi.spyOn(liqClient, 'stopPlayback').mockResolvedValue());

    await boot.boot({ musicDir: '/music', visualsDir: '/visuals' });

    expect(s3.syncDir).toHaveBeenCalledWith('music/processed/', '/music/processed');
    s3.S3_ENABLED = origEnabled;
  });

  it('continues boot when S3 sync fails', async () => {
    const origEnabled = s3.S3_ENABLED;
    s3.S3_ENABLED = true;
    mockProbeResponse({ playing: true });
    spies.push(vi.spyOn(s3, 'syncDir').mockRejectedValue(new Error('S3 down')));
    spies.push(vi.spyOn(s3, 'ensureCached').mockRejectedValue(new Error('S3 down')));
    spies.push(vi.spyOn(streamControl, 'getModeState').mockReturnValue({ mode: 'standby', standbyVisual: null }));
    spies.push(vi.spyOn(streamControl, 'setModeState').mockImplementation(() => {}));
    spies.push(vi.spyOn(liqClient, 'stopPlayback').mockResolvedValue());

    await boot.boot({ musicDir: '/music', visualsDir: '/visuals' });

    expect(liqClient.stopPlayback).toHaveBeenCalled();
    expect(streamControl.setModeState).not.toHaveBeenCalled();
    s3.S3_ENABLED = origEnabled;
  });
});
