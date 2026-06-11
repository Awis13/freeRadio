/**
 * tests/dashboard/streamControl.test.js
 *
 * Unit tests for dashboard/lib/streamControl.js — stream state management.
 * Tests: getControlState, setControlState, getModeState, setModeState.
 * normalizeBool is tested indirectly via public API.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

const CONTROL_FILE = '/shared/stream_control.json';
const MODE_FILE = '/shared/stream_mode.json';

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
  vi.spyOn(fs, 'renameSync').mockImplementation((src, dst) => {
    files[dst] = files[src];
    delete files[src];
  });
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
});

const { getControlState, setControlState, getModeState, setModeState } =
  await import('../../dashboard/lib/streamControl.js');

// ---------------------------------------------------------------------------
// getControlState
// ---------------------------------------------------------------------------
describe('getControlState', () => {
  it('returns {streaming:false, broadcast:false} when no file exists', () => {
    const state = getControlState();
    expect(state.streaming).toBe(false);
    expect(state.broadcast).toBe(false);
  });

  it('writes default state file when none exists', () => {
    getControlState();
    expect(files[CONTROL_FILE]).toBeDefined();
    const written = JSON.parse(files[CONTROL_FILE]);
    expect(written.streaming).toBe(false);
    expect(written.broadcast).toBe(false);
  });

  it('reads existing file with streaming=true', () => {
    files[CONTROL_FILE] = JSON.stringify({ streaming: true, broadcast: false, timestamp: 1000 });
    const state = getControlState();
    expect(state.streaming).toBe(true);
    expect(state.broadcast).toBe(false);
  });

  it('reads existing file with broadcast=true', () => {
    files[CONTROL_FILE] = JSON.stringify({ streaming: true, broadcast: true, timestamp: 1000 });
    const state = getControlState();
    expect(state.broadcast).toBe(true);
  });

  it('handles string "true" for streaming', () => {
    files[CONTROL_FILE] = JSON.stringify({ streaming: 'true', broadcast: false });
    const state = getControlState();
    expect(state.streaming).toBe(true);
  });

  it('handles string "false" for streaming', () => {
    files[CONTROL_FILE] = JSON.stringify({ streaming: 'false', broadcast: false });
    const state = getControlState();
    expect(state.streaming).toBe(false);
  });

  it('handles numeric 1 for streaming', () => {
    files[CONTROL_FILE] = JSON.stringify({ streaming: 1, broadcast: false });
    expect(getControlState().streaming).toBe(true);
  });

  it('handles numeric 0 for streaming', () => {
    files[CONTROL_FILE] = JSON.stringify({ streaming: 0, broadcast: false });
    expect(getControlState().streaming).toBe(false);
  });

  it('falls back to default on corrupt JSON', () => {
    files[CONTROL_FILE] = 'not json{{{';
    const state = getControlState();
    expect(state.streaming).toBe(false);
    expect(state.broadcast).toBe(false);
  });

  it('falls back to default when streaming value is unrecognized', () => {
    files[CONTROL_FILE] = JSON.stringify({ streaming: 'maybe', broadcast: false });
    const state = getControlState();
    expect(state.streaming).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// setControlState
// ---------------------------------------------------------------------------
describe('setControlState', () => {
  it('writes new state to file', () => {
    setControlState(true, true);
    const written = JSON.parse(files[CONTROL_FILE]);
    expect(written.streaming).toBe(true);
    expect(written.broadcast).toBe(true);
  });

  it('skips write when values unchanged', () => {
    files[CONTROL_FILE] = JSON.stringify({ streaming: true, broadcast: false, timestamp: 1000 });
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    setControlState(true, false);
    // writeFileSync should NOT be called for the control file itself
    // (it may be called during getControlState fallback, but not for the update)
    const controlWrites = writeSpy.mock.calls.filter(c => String(c[0]).includes('stream_control'));
    expect(controlWrites.length).toBe(0);
  });

  it('writes when streaming changes from false to true', () => {
    files[CONTROL_FILE] = JSON.stringify({ streaming: false, broadcast: false, timestamp: 1000 });
    const result = setControlState(true);
    expect(result.streaming).toBe(true);
  });

  it('preserves broadcast when not specified', () => {
    files[CONTROL_FILE] = JSON.stringify({ streaming: false, broadcast: true, timestamp: 1000 });
    const result = setControlState(true);
    expect(result.broadcast).toBe(true);
  });

  it('uses atomic write via rename', () => {
    setControlState(true, false);
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it('handles string "true" as streaming value', () => {
    const result = setControlState('true', false);
    expect(result.streaming).toBe(true);
  });

  it('returns current state when streaming is null-like', () => {
    files[CONTROL_FILE] = JSON.stringify({ streaming: true, broadcast: false, timestamp: 1000 });
    const result = setControlState(undefined);
    expect(result.streaming).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getModeState
// ---------------------------------------------------------------------------
describe('getModeState', () => {
  it('returns standby when no file exists', () => {
    const state = getModeState();
    expect(state.mode).toBe('standby');
    expect(state.standbyVisual).toBeNull();
  });

  it('reads live mode from file', () => {
    files[MODE_FILE] = JSON.stringify({ mode: 'live', standbyVisual: null });
    expect(getModeState().mode).toBe('live');
  });

  it('reads armed mode from file', () => {
    files[MODE_FILE] = JSON.stringify({ mode: 'armed', standbyVisual: 'test.mp4' });
    const state = getModeState();
    expect(state.mode).toBe('armed');
    expect(state.standbyVisual).toBe('test.mp4');
  });

  it('normalizes unknown mode to standby', () => {
    files[MODE_FILE] = JSON.stringify({ mode: 'garbage', standbyVisual: null });
    expect(getModeState().mode).toBe('standby');
  });

  it('handles corrupt JSON gracefully', () => {
    files[MODE_FILE] = '{broken';
    expect(getModeState().mode).toBe('standby');
  });

  it('returns standbyVisual=null when field missing', () => {
    files[MODE_FILE] = JSON.stringify({ mode: 'standby' });
    expect(getModeState().standbyVisual).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setModeState
// ---------------------------------------------------------------------------
describe('setModeState', () => {
  it('writes live mode to file', () => {
    const result = setModeState('live');
    expect(result.mode).toBe('live');
    expect(files[MODE_FILE]).toBeDefined();
  });

  it('uses atomic write via rename', () => {
    setModeState('live');
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it('preserves existing standbyVisual when not specified', () => {
    files[MODE_FILE] = JSON.stringify({ mode: 'standby', standbyVisual: 'bg.mp4' });
    const result = setModeState('armed');
    expect(result.standbyVisual).toBe('bg.mp4');
  });

  it('updates standbyVisual when specified', () => {
    files[MODE_FILE] = JSON.stringify({ mode: 'standby', standbyVisual: 'old.mp4' });
    const result = setModeState('standby', 'new.mp4');
    expect(result.standbyVisual).toBe('new.mp4');
  });

  it('sets standbyVisual to null when explicitly passed', () => {
    files[MODE_FILE] = JSON.stringify({ mode: 'standby', standbyVisual: 'bg.mp4' });
    const result = setModeState('standby', null);
    expect(result.standbyVisual).toBeNull();
  });

  it('preserves existing mode when not specified', () => {
    files[MODE_FILE] = JSON.stringify({ mode: 'live', standbyVisual: null });
    const result = setModeState(undefined, 'bg.mp4');
    expect(result.mode).toBe('live');
  });

  it('includes timestamp in written data', () => {
    setModeState('standby');
    const written = JSON.parse(files[MODE_FILE]);
    expect(written.timestamp).toBeDefined();
    expect(typeof written.timestamp).toBe('number');
  });
});
