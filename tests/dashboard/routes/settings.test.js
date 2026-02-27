/**
 * tests/dashboard/routes/settings.test.js
 *
 * Unit tests for dashboard/routes/settings.js — all settings CRUD.
 * Covers: quality, audio, channel-strip, video, stream control,
 *         visual mode, live mode, restream settings.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { mockRes, getRouteHandler, spy, restoreSpies } from '../helpers.js';

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

beforeEach(() => restoreSpies());
afterEach(() => restoreSpies());

// ─── Quality ──────────────────────────────────────────────────

describe('Quality endpoints', () => {
  it('GET /quality returns current quality and presets', () => {
    spy(vi.spyOn(quality, 'getQuality').mockReturnValue({ preset: 'high', settings: { name: 'High' } }));
    spy(vi.spyOn(quality, 'getPresets').mockReturnValue([{ key: 'high', name: 'High' }]));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/quality');
    const res = mockRes();
    handler({}, res);

    expect(res.body.current).toEqual({ preset: 'high', settings: { name: 'High' } });
    expect(res.body.presets).toEqual([{ key: 'high', name: 'High' }]);
  });

  it('POST /quality sets quality preset', () => {
    spy(vi.spyOn(quality, 'setQuality').mockReturnValue({ preset: 'low', settings: { name: 'Low' } }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/quality');
    const res = mockRes();
    handler({ body: { preset: 'low' } }, res);

    expect(quality.setQuality).toHaveBeenCalledWith('low');
  });

  it('POST /quality returns 400 when setQuality throws', () => {
    spy(vi.spyOn(quality, 'setQuality').mockImplementation(() => { throw new Error('unknown preset'); }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/quality');
    const res = mockRes();
    handler({ body: { preset: 'invalid' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toBe('unknown preset');
  });
});

// ─── Audio ────────────────────────────────────────────────────

describe('Audio endpoints', () => {
  it('GET /audio returns audio settings', () => {
    spy(vi.spyOn(audioSettings, 'getAudioSettings').mockReturnValue({ enhanced: false }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/audio');
    const res = mockRes();
    handler({}, res);

    expect(res.body).toEqual({ enhanced: false });
  });

  it('POST /audio updates audio settings', () => {
    spy(vi.spyOn(audioSettings, 'setAudioSettings').mockReturnValue({ enhanced: true }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/audio');
    const res = mockRes();
    handler({ body: { enhanced: true } }, res);

    expect(audioSettings.setAudioSettings).toHaveBeenCalledWith({ enhanced: true });
  });

  it('POST /audio returns 400 when setAudioSettings throws', () => {
    spy(vi.spyOn(audioSettings, 'setAudioSettings').mockImplementation(() => { throw new Error('invalid param'); }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/audio');
    const res = mockRes();
    handler({ body: { enhanced: 'bad' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toBe('invalid param');
  });
});

// ─── Channel Strip ────────────────────────────────────────────

describe('Channel Strip endpoints', () => {
  it('GET /channel-strip returns config from Liquidsoap', async () => {
    spy(vi.spyOn(channelStrip, 'getConfig').mockResolvedValue({
      bypass: false, comp_threshold: -10, output_gain: 1
    }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/channel-strip');
    const res = mockRes();
    await handler({}, res);

    expect(channelStrip.getConfig).toHaveBeenCalled();
    expect(res.body).toEqual({ bypass: false, comp_threshold: -10, output_gain: 1 });
  });

  it('GET /channel-strip returns 500 on error', async () => {
    spy(vi.spyOn(channelStrip, 'getConfig').mockRejectedValue(new Error('connection refused')));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/channel-strip');
    const res = mockRes();
    await handler({}, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body.error).toBe('connection refused');
  });

  it('POST /channel-strip sets config parameters', async () => {
    spy(vi.spyOn(channelStrip, 'setConfig').mockResolvedValue({ ok: true, bypass: false }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/channel-strip');
    const res = mockRes();
    await handler({ body: { bypass: false, comp_threshold: -15 } }, res);

    expect(channelStrip.setConfig).toHaveBeenCalledWith({ bypass: false, comp_threshold: -15 });
    expect(res.body.ok).toBe(true);
  });

  it('POST /channel-strip returns 500 on error', async () => {
    spy(vi.spyOn(channelStrip, 'setConfig').mockRejectedValue(new Error('liq timeout')));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/channel-strip');
    const res = mockRes();
    await handler({ body: { bypass: true } }, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body.error).toBe('liq timeout');
  });

  it('POST /channel-strip/preset applies a named preset', async () => {
    spy(vi.spyOn(channelStrip, 'setPreset').mockResolvedValue({ ok: true, preset: 'warm_radio', data: {} }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/channel-strip/preset');
    const res = mockRes();
    await handler({ body: { name: 'warm_radio' } }, res);

    expect(channelStrip.setPreset).toHaveBeenCalledWith('warm_radio');
    expect(res.body.ok).toBe(true);
  });

  it('POST /channel-strip/preset returns 400 when name is missing', async () => {
    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/channel-strip/preset');
    const res = mockRes();
    await handler({ body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/missing preset name/);
  });

  it('POST /channel-strip/preset returns 400 for unknown preset', async () => {
    spy(vi.spyOn(channelStrip, 'setPreset').mockResolvedValue({ ok: false, error: 'unknown preset: garbage' }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/channel-strip/preset');
    const res = mockRes();
    await handler({ body: { name: 'garbage' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.ok).toBe(false);
  });

  it('POST /channel-strip/preset returns 500 on Liquidsoap error', async () => {
    spy(vi.spyOn(channelStrip, 'setPreset').mockRejectedValue(new Error('connection lost')));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/channel-strip/preset');
    const res = mockRes();
    await handler({ body: { name: 'warm_radio' } }, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body.error).toBe('connection lost');
  });

  it('GET /channel-strip/metering returns metering data', async () => {
    spy(vi.spyOn(channelStrip, 'getMetering').mockResolvedValue({
      input_peak: -3.2, output_peak: -1.1, gain_reduction: -5.0
    }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/channel-strip/metering');
    const res = mockRes();
    await handler({}, res);

    expect(channelStrip.getMetering).toHaveBeenCalled();
    expect(res.body.input_peak).toBe(-3.2);
  });

  it('GET /channel-strip/metering returns 500 on error', async () => {
    spy(vi.spyOn(channelStrip, 'getMetering').mockRejectedValue(new Error('not available')));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/channel-strip/metering');
    const res = mockRes();
    await handler({}, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body.error).toBe('not available');
  });
});

// ─── Video ────────────────────────────────────────────────────

describe('Video endpoints', () => {
  it('GET /video returns video settings', () => {
    spy(vi.spyOn(videoSettings, 'getVideoSettings').mockReturnValue({ enhanced: false }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/video');
    const res = mockRes();
    handler({}, res);

    expect(res.body).toEqual({ enhanced: false });
  });

  it('POST /video updates video settings', () => {
    spy(vi.spyOn(videoSettings, 'setVideoSettings').mockReturnValue({ enhanced: true, timestamp: 123 }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/video');
    const res = mockRes();
    handler({ body: { enhanced: true } }, res);

    expect(videoSettings.setVideoSettings).toHaveBeenCalledWith({ enhanced: true });
    expect(res.body.success).toBe(true);
  });

  it('POST /video returns 400 when setVideoSettings throws', () => {
    spy(vi.spyOn(videoSettings, 'setVideoSettings').mockImplementation(() => { throw new Error('write failed'); }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/video');
    const res = mockRes();
    handler({ body: { enhanced: true } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toBe('write failed');
  });
});

// ─── Stream Control ───────────────────────────────────────────

describe('Stream Control endpoints', () => {
  it('GET /stream/control returns control state', () => {
    spy(vi.spyOn(streamControl, 'getControlState').mockReturnValue({ streaming: true, broadcast: false }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/stream/control');
    const res = mockRes();
    handler({}, res);

    expect(res.body).toEqual({ streaming: true, broadcast: false });
  });

  it('POST /stream/control sets control state', () => {
    spy(vi.spyOn(streamControl, 'setControlState').mockReturnValue({ streaming: true, broadcast: true }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/stream/control');
    const res = mockRes();
    handler({ body: { streaming: true, broadcast: true } }, res);

    expect(streamControl.setControlState).toHaveBeenCalledWith(true, true);
  });

  it('GET /stream/mode returns mode state', () => {
    spy(vi.spyOn(streamControl, 'getModeState').mockReturnValue({ mode: 'live' }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/stream/mode');
    const res = mockRes();
    handler({}, res);

    expect(res.body).toEqual({ mode: 'live' });
  });

  it('POST /stream/mode sets mode state', () => {
    spy(vi.spyOn(streamControl, 'setModeState').mockReturnValue({ mode: 'standby' }));

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
    spy(vi.spyOn(visualMode, 'getVisualMode').mockReturnValue({ mode: 'visual-radio' }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/visual-mode');
    const res = mockRes();
    handler({}, res);

    expect(res.body).toEqual({ mode: 'visual-radio' });
  });

  it('POST /visual-mode sets mode', () => {
    spy(vi.spyOn(visualMode, 'setVisualMode').mockReturnValue({ mode: 'lofi' }));

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
    spy(vi.spyOn(liveMode, 'getLiveMode').mockReturnValue({ source: 'obs', afkFallback: 'visual-radio' }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/live-mode');
    const res = mockRes();
    handler({}, res);

    expect(res.body.source).toBe('obs');
  });

  it('POST /live-mode sets live mode', () => {
    const result = { source: 'obs', afkFallback: 'lofi' };
    spy(vi.spyOn(liveMode, 'setLiveMode').mockReturnValue(result));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/live-mode');
    const res = mockRes();
    handler({ body: { source: 'obs', afkFallback: 'lofi' } }, res);

    expect(liveMode.setLiveMode).toHaveBeenCalledWith({ source: 'obs', afkFallback: 'lofi' });
    expect(res.body).toEqual(expect.objectContaining({ success: true }));
  });

  it('POST /live-mode/generate-key regenerates key', () => {
    const result = { ingestKey: 'new-key-123' };
    spy(vi.spyOn(liveMode, 'regenerateIngestKey').mockReturnValue(result));

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
    spy(vi.spyOn(restreamSettings, 'getSettings').mockReturnValue({ autoStart: false }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'get', '/restream/settings');
    const res = mockRes();
    handler({}, res);

    expect(res.body).toEqual({ autoStart: false });
  });

  it('POST /restream/settings sets autoStart', () => {
    spy(vi.spyOn(restreamSettings, 'setAutoStart').mockReturnValue({ autoStart: true }));

    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/restream/settings');
    const res = mockRes();
    handler({ body: { autoStart: true } }, res);

    expect(restreamSettings.setAutoStart).toHaveBeenCalledWith(true);
  });

  it('POST /restream/settings returns 400 when autoStart is not boolean', () => {
    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/restream/settings');
    const res = mockRes();
    handler({ body: { autoStart: 'yes' } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/autoStart must be boolean/);
  });

  it('POST /restream/settings returns 400 when autoStart is missing', () => {
    const router = createSettingsRouter();
    const handler = getRouteHandler(router, 'post', '/restream/settings');
    const res = mockRes();
    handler({ body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});
