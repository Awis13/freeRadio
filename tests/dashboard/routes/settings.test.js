/**
 * tests/dashboard/routes/settings.test.js
 *
 * Unit tests for dashboard/routes/settings.js — all settings CRUD.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const createSettingsRouter = require('../../../dashboard/routes/settings');
const quality = require('../../../dashboard/lib/quality');
const audioSettings = require('../../../dashboard/lib/audioSettings');
const videoSettings = require('../../../dashboard/lib/videoSettings');
const channelStrip = require('../../../dashboard/lib/channelStrip');
const streamControl = require('../../../dashboard/lib/streamControl');
const visualMode = require('../../../dashboard/lib/visualMode');
const liveMode = require('../../../dashboard/lib/liveMode');
const restreamSettings = require('../../../dashboard/lib/restreamSettings');

// ─── Helpers ──────────────────────────────────────────────────

let spies = [];

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.json = vi.fn((data) => { res.body = data; return res; });
  res.status = vi.fn((code) => { res.statusCode = code; return res; });
  return res;
}

function getRouteHandler(router, method, routePath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath) {
      const match = layer.route.stack.find(s => s.method === method);
      if (match) return match.handle;
    }
  }
  throw new Error(`No handler for ${method.toUpperCase()} ${routePath}`);
}

beforeEach(() => {
  spies.forEach(s => s.mockRestore());
  spies = [];
});

afterEach(() => {
  spies.forEach(s => s.mockRestore());
  spies = [];
});

// ─── Quality ──────────────────────────────────────────────────

describe('Quality endpoints', () => {
  it('GET /quality returns current quality and presets', () => {
    spies.push(vi.spyOn(quality, 'getQuality').mockReturnValue({ preset: 'high', settings: { name: 'High' } }));
    spies.push(vi.spyOn(quality, 'getPresets').mockReturnValue([{ key: 'high', name: 'High' }]));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/quality');
    const res = mockRes();
    handler({}, res);

    expect(res.body.current).toEqual({ preset: 'high', settings: { name: 'High' } });
    expect(res.body.presets).toEqual([{ key: 'high', name: 'High' }]);
  });

  it('POST /quality sets quality preset', () => {
    spies.push(vi.spyOn(quality, 'setQuality').mockReturnValue({ preset: 'low', settings: { name: 'Low' } }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/quality');
    const res = mockRes();
    handler({ body: { preset: 'low' } }, res);

    expect(quality.setQuality).toHaveBeenCalledWith('low');
  });
});

// ─── Audio ────────────────────────────────────────────────────

describe('Audio endpoints', () => {
  it('GET /audio returns audio settings', () => {
    spies.push(vi.spyOn(audioSettings, 'getAudioSettings').mockReturnValue({ enhanced: false }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/audio');
    const res = mockRes();
    handler({}, res);

    expect(res.body).toEqual({ enhanced: false });
  });

  it('POST /audio updates audio settings', () => {
    spies.push(vi.spyOn(audioSettings, 'setAudioSettings').mockReturnValue({ enhanced: true }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/audio');
    const res = mockRes();
    handler({ body: { enhanced: true } }, res);

    expect(audioSettings.setAudioSettings).toHaveBeenCalledWith({ enhanced: true });
  });
});

// ─── Stream Control ───────────────────────────────────────────

describe('Stream Control endpoints', () => {
  it('GET /stream/control returns control state', () => {
    spies.push(vi.spyOn(streamControl, 'getControlState').mockReturnValue({ streaming: true, broadcast: false }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/stream/control');
    const res = mockRes();
    handler({}, res);

    expect(res.body).toEqual({ streaming: true, broadcast: false });
  });

  it('POST /stream/control sets control state', () => {
    spies.push(vi.spyOn(streamControl, 'setControlState').mockReturnValue({ streaming: true, broadcast: true }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/stream/control');
    const res = mockRes();
    handler({ body: { streaming: true, broadcast: true } }, res);

    expect(streamControl.setControlState).toHaveBeenCalledWith(true, true);
  });

  it('GET /stream/mode returns mode state', () => {
    spies.push(vi.spyOn(streamControl, 'getModeState').mockReturnValue({ mode: 'live' }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/stream/mode');
    const res = mockRes();
    handler({}, res);

    expect(res.body).toEqual({ mode: 'live' });
  });

  it('POST /stream/mode sets mode state', () => {
    spies.push(vi.spyOn(streamControl, 'setModeState').mockReturnValue({ mode: 'standby' }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/stream/mode');
    const res = mockRes();
    handler({ body: { mode: 'standby', standbyVisual: 'bars' } }, res);

    expect(streamControl.setModeState).toHaveBeenCalledWith('standby', 'bars');
  });
});

// ─── Visual Mode ──────────────────────────────────────────────

describe('Visual Mode endpoints', () => {
  it('GET /visual-mode returns current mode', () => {
    spies.push(vi.spyOn(visualMode, 'getVisualMode').mockReturnValue({ mode: 'visual-radio' }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/visual-mode');
    const res = mockRes();
    handler({}, res);

    expect(res.body).toEqual({ mode: 'visual-radio' });
  });

  it('POST /visual-mode sets mode', () => {
    spies.push(vi.spyOn(visualMode, 'setVisualMode').mockReturnValue({ mode: 'lofi' }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/visual-mode');
    const res = mockRes();
    handler({ body: { mode: 'lofi' } }, res);

    expect(visualMode.setVisualMode).toHaveBeenCalledWith('lofi');
  });
});

// ─── Live Mode ────────────────────────────────────────────────

describe('Live Mode endpoints', () => {
  it('GET /live-mode returns current live mode', () => {
    spies.push(vi.spyOn(liveMode, 'getLiveMode').mockReturnValue({ source: 'obs', afkFallback: 'visual-radio' }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/live-mode');
    const res = mockRes();
    handler({}, res);

    expect(res.body.source).toBe('obs');
  });

  it('POST /live-mode sets live mode', () => {
    const result = { source: 'obs', afkFallback: 'lofi' };
    spies.push(vi.spyOn(liveMode, 'setLiveMode').mockReturnValue(result));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/live-mode');
    const res = mockRes();
    handler({ body: { source: 'obs', afkFallback: 'lofi' } }, res);

    expect(liveMode.setLiveMode).toHaveBeenCalledWith({ source: 'obs', afkFallback: 'lofi' });
    expect(res.body).toEqual(expect.objectContaining({ success: true }));
  });

  it('POST /live-mode/generate-key regenerates key', () => {
    const result = { ingestKey: 'new-key-123' };
    spies.push(vi.spyOn(liveMode, 'regenerateIngestKey').mockReturnValue(result));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/live-mode/generate-key');
    const res = mockRes();
    handler({}, res);

    expect(liveMode.regenerateIngestKey).toHaveBeenCalled();
    expect(res.body).toEqual(expect.objectContaining({ success: true }));
  });
});

// ─── Restream ─────────────────────────────────────────────────

describe('Restream endpoints', () => {
  it('GET /restream/settings returns settings', () => {
    spies.push(vi.spyOn(restreamSettings, 'getSettings').mockReturnValue({ autoStart: false }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/restream/settings');
    const res = mockRes();
    handler({}, res);

    expect(res.body).toEqual({ autoStart: false });
  });

  it('POST /restream/settings sets autoStart', () => {
    spies.push(vi.spyOn(restreamSettings, 'setAutoStart').mockReturnValue({ autoStart: true }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/restream/settings');
    const res = mockRes();
    handler({ body: { autoStart: true } }, res);

    expect(restreamSettings.setAutoStart).toHaveBeenCalledWith(true);
  });
});
