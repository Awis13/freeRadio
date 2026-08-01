/**
 * tests/dashboard/wsHubUI.test.js
 *
 * Characterization pins for the WebSocket message hub — handleMessage's
 * remaining cases — plus the mixing-mode pills and the Live Mode bar. Taken
 * while all of it was still in the app.js IIFE and kept green through the
 * extraction into wsHub.js and broadcast.js. AS-IS only; nothing here fixes
 * anything.
 *
 * NOT DUPLICATED HERE. broadcastUI.test.js pins the 'init' frame's broadcast
 * repaint and playerMixerAnalyzerUI.test.js pins the 'audio' frame's track
 * clock. This file pins the OTHER observable writes of those two frames (the
 * output-mode tag, the now-playing title, the stat row) and every remaining
 * message type: video, icecast, ffmpeg, bpm, rtmp-health, voice-status,
 * mixing-config and live-mode.
 *
 * CONSUMER-SHAPED. Every pin drives the real boot socket via ws.onmessage, or a
 * real control click.
 *
 * PROVING A FRAME DID NOT THROW. handleMessage runs inside a try/catch in
 * onmessage, and that catch is PER MESSAGE — a frame that throws does not stop
 * the next one, so "a later frame still repaints" proves nothing. What the catch
 * does do is `log('ws: parse error ' + e)`, and log() appends to #log. So the
 * detector for a case that has no DOM effect is that #log does NOT gain
 * 'ws: parse error' after the frame.
 *
 * TIMERS: the win.setTimeout capture spy (wsReconnectUI.test.js:22-30 recipe) is
 * used where a frame schedules work — the dashboard resolves setTimeout in the
 * jsdom realm, which vi.useFakeTimers() does not intercept.
 *
 * PHASE-1 DEAD SURFACE pinned as such, so the extraction keeps the guards:
 *   - The whole Live Mode bar (#live-mode-bar and every live-* control) sits in
 *     a PHASE 3 HTML comment, so updateLiveModeUI returns at its first line and
 *     the .live-source-pill NodeList is empty. The 'live-mode' frame still
 *     mutates state and repaints the mode cards, which IS pinned.
 *   - pendingModeSwitch is provably never true (its only writer is gated on a
 *     state its callers refuse to run in), so the 'video' frame's whole body is
 *     unreachable. The reachable behaviour — that it does nothing — is pinned.
 */

import { describe, it, expect } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, flush } from './appBoot.js';

/** Boot and rethrow a load error so a boot failure fails loudly. */
function boot() {
  const { win, doc, loadError } = bootWindow();
  if (loadError) throw loadError;
  return {
    win,
    doc,
    send: (msg) => win.__appWs.getWs().onmessage({ data: JSON.stringify(msg) }),
  };
}

function initState(streamMode, broadcast, visualMode, extra) {
  return Object.assign({
    streamControl: { streaming: streamMode !== 'standby', broadcast: broadcast },
    streamMode: { mode: streamMode, standbyVisual: null },
    visualMode: { mode: visualMode || 'visual-radio' },
  }, extra || {});
}

/** Capture-spy over win.setTimeout: records delays, schedules nothing. */
function captureTimers(win) {
  const delays = [];
  win.setTimeout = (fn, ms) => { delays.push(ms); return 1; };
  return delays;
}

/** The Icecast + FFmpeg stat row. */
function statRow(doc) {
  return {
    listeners: doc.getElementById('stat-listeners').textContent,
    audioBitrate: doc.getElementById('stat-audio-br').textContent,
    fps: doc.getElementById('stat-fps').textContent,
    speed: doc.getElementById('stat-speed').textContent,
    videoBitrate: doc.getElementById('stat-video-br').textContent,
    time: doc.getElementById('stat-time').textContent,
  };
}

/** The debug log pane's text — log() appends every line to #log. */
function logText(doc) {
  return doc.getElementById('log').textContent;
}

/**
 * Assert the frame just sent did not throw out of handleMessage. onmessage's
 * catch logs 'ws: parse error', so its absence is the proof.
 */
function expectFrameSurvived(doc) {
  expect(logText(doc)).not.toContain('ws: parse error');
}

/** Which mixing pill carries the active class. */
function activeMixPill(doc) {
  return Array.from(doc.querySelectorAll('.mix-pill'))
    .filter((p) => p.classList.contains('active'))
    .map((p) => p.dataset.mixmode);
}

describe('output mode tag (init frame)', () => {
  it('defaults to HLS when the server sends no output mode', () => {
    const { doc, send } = boot();
    const tag = doc.getElementById('mode-tag');
    // #mode-tag ships 'HLS' in the markup, so drive it away from the default
    // first — otherwise this would pass with updateMode's body deleted.
    send({ type: 'init', data: initState('live', true, null, { outputMode: 'rtmp' }) });
    expect(tag.textContent).toBe('RTMP');

    send({ type: 'init', data: initState('live', true) });

    // `(mode || 'hls').toUpperCase()` puts it back.
    expect(tag.textContent).toBe('HLS');
  });

  it('shows RTMP and adds the rtmp class', () => {
    const { doc, send } = boot();
    send({ type: 'init', data: initState('live', true, null, { outputMode: 'rtmp' }) });
    const tag = doc.getElementById('mode-tag');
    expect(tag.textContent).toBe('RTMP');
    expect(tag.classList.contains('rtmp')).toBe(true);
  });

  it('never removes the rtmp class once added, so the text and styling disagree', () => {
    const { doc, send } = boot();
    send({ type: 'init', data: initState('live', true, null, { outputMode: 'rtmp' }) });
    send({ type: 'init', data: initState('live', true, null, { outputMode: 'hls' }) });

    // updateMode only ever ADDS the class. Pinned AS-IS: the tag reads HLS
    // while still carrying the RTMP styling.
    const tag = doc.getElementById('mode-tag');
    expect(tag.textContent).toBe('HLS');
    expect(tag.classList.contains('rtmp')).toBe(true);
  });
});

describe('icecast and ffmpeg stat frames', () => {
  it('an icecast frame writes the listener count and audio bitrate', () => {
    const { doc, send } = boot();
    send({ type: 'icecast', data: { listeners: 42, bitrate: 128 } });
    expect(statRow(doc).listeners).toBe('42');
    expect(statRow(doc).audioBitrate).toBe('128 kbps');
  });

  it('an icecast frame with zero listeners and no bitrate falls back', () => {
    const { doc, send } = boot();
    send({ type: 'icecast', data: { listeners: 42, bitrate: 128 } });
    send({ type: 'icecast', data: { listeners: 0 } });
    // `data.listeners || '0'` turns a real 0 into the string '0' by the same
    // path a missing field takes, and the bitrate falls back to '--'.
    expect(statRow(doc).listeners).toBe('0');
    expect(statRow(doc).audioBitrate).toBe('--');
  });

  it('an ffmpeg frame writes all four encoder stats', () => {
    const { doc, send } = boot();
    send({ type: 'ffmpeg', data: { fps: '30', speed: '1.0x', bitrate: '2500kbits/s', time: '00:10:00' } });
    expect(statRow(doc)).toEqual({
      // The Icecast half is untouched by an ffmpeg frame, so both keep the
      // placeholders the markup ships with.
      listeners: '--',
      audioBitrate: '--',
      fps: '30',
      speed: '1.0x',
      videoBitrate: '2500kbits/s',
      time: '00:10:00',
    });
  });

  it('an empty ffmpeg object resets all four to the dash placeholder', () => {
    const { doc, send } = boot();
    send({ type: 'ffmpeg', data: { fps: '30', speed: '1.0x', bitrate: '9', time: '1' } });
    send({ type: 'ffmpeg', data: {} });
    // `if (!data) return` lets {} through, so every field takes its || '--'.
    expect(statRow(doc).fps).toBe('--');
    expect(statRow(doc).speed).toBe('--');
    expect(statRow(doc).videoBitrate).toBe('--');
    expect(statRow(doc).time).toBe('--');
  });

  it('a null-bodied frame is ignored rather than clearing the stats', () => {
    const { doc, send } = boot();
    send({ type: 'ffmpeg', data: { fps: '30', speed: '1.0x', bitrate: '9', time: '1' } });
    send({ type: 'icecast', data: { listeners: 7, bitrate: 96 } });

    send({ type: 'ffmpeg', data: null });
    send({ type: 'icecast', data: null });

    expect(statRow(doc)).toEqual({
      listeners: '7', audioBitrate: '96 kbps',
      fps: '30', speed: '1.0x', videoBitrate: '9', time: '1',
    });
  });
});

describe('now-playing writes of the audio frame', () => {
  it('prefers an explicit title over the filename', () => {
    const { doc, send } = boot();
    send({ type: 'init', data: initState('live', true) });
    send({ type: 'audio', data: { title: 'Explicit Title', filename: 'music/x.mp3', duration: 10 } });
    expect(doc.getElementById('studio-audio-track').textContent).toBe('Explicit Title');
  });

  it('cleans the filename when no title is given', () => {
    const { doc, send } = boot();
    send({ type: 'init', data: initState('live', true) });
    send({ type: 'audio', data: { filename: 'music/Some - Track.mp3', duration: 10 } });
    expect(doc.getElementById('studio-audio-track').textContent).toBe('Some - Track');
  });

  it('falls back to a double dash when neither title nor filename is usable', () => {
    const { doc, send } = boot();
    send({ type: 'init', data: initState('live', true) });
    // #studio-audio-track ships '--' in the markup, so put a real name in it
    // first — otherwise this would pass with the fallback deleted.
    send({ type: 'audio', data: { title: 'Something', duration: 10 } });
    expect(doc.getElementById('studio-audio-track').textContent).toBe('Something');

    send({ type: 'audio', data: { duration: 10 } });

    expect(doc.getElementById('studio-audio-track').textContent).toBe('--');
  });

  it('shows the BPM badge from the init frame bpm map, matched on the basename', () => {
    const { doc, send } = boot();
    send({ type: 'init', data: initState('live', true, null, { bpm: { 'Track.mp3': 128.4 } }) });
    send({ type: 'audio', data: { filename: 'music/Track.mp3', duration: 10 } });
    expect(doc.getElementById('studio-bpm').textContent).toBe('128 BPM');
  });

  it('matches a bpm entry whose extension differs from the played file', () => {
    const { doc, send } = boot();
    send({ type: 'init', data: initState('live', true, null, { bpm: { 'Track.wav': 90 } }) });
    send({ type: 'audio', data: { filename: 'music/Track.mp3', duration: 10 } });
    // The extensionless fallback lookup makes a .wav bpm entry answer for a .mp3.
    expect(doc.getElementById('studio-bpm').textContent).toBe('90 BPM');
  });

  it('clears the BPM badge when the track is unknown', () => {
    const { doc, send } = boot();
    send({ type: 'init', data: initState('live', true, null, { bpm: { 'Track.mp3': 128 } }) });
    send({ type: 'audio', data: { filename: 'music/Track.mp3', duration: 10 } });
    send({ type: 'audio', data: { filename: 'music/Other.mp3', duration: 10 } });
    expect(doc.getElementById('studio-bpm').textContent).toBe('');
  });
});

describe('bpm frame', () => {
  it('replaces the bpm map wholesale and refreshes the file list badges', async () => {
    const { win, doc, send } = boot();
    const { fetch } = makeFetchStub([
      routeExact('GET', '/api/music', [{ name: 'Alpha.mp3' }]),
      routeExact('GET', '/api/visuals', []),
    ]);
    win.fetch = fetch;
    send({ type: 'init', data: initState('live', true, null, { bpm: { 'Alpha.mp3': 100 } }) });
    await flush(20);

    send({ type: 'bpm', data: { 'Alpha.mp3': 140 } });

    expect(doc.getElementById('music-list').textContent).toContain('140 BPM');
  });

  it('an empty bpm frame clears every badge', async () => {
    const { win, doc, send } = boot();
    const { fetch } = makeFetchStub([
      routeExact('GET', '/api/music', [{ name: 'Alpha.mp3' }]),
      routeExact('GET', '/api/visuals', []),
    ]);
    win.fetch = fetch;
    send({ type: 'init', data: initState('live', true, null, { bpm: { 'Alpha.mp3': 100 } }) });
    await flush(20);
    expect(doc.getElementById('music-list').textContent).toContain('100 BPM');

    // `bpmMap = msg.data || {}` — a null body resets the whole map.
    send({ type: 'bpm', data: null });

    expect(doc.getElementById('music-list').textContent).not.toContain('BPM');
  });
});

describe('video frame', () => {
  it('does nothing, because pendingModeSwitch can never be true', () => {
    const { win, doc, send } = boot();
    send({ type: 'init', data: initState('live', true) });
    doc.getElementById('studio-player').dispatchEvent(new win.Event('canplay'));
    const delays = captureTimers(win);

    send({ type: 'video', data: { filename: 'clip.mp4' } });

    // The whole case body is behind FRPlayer.getPendingModeSwitch(), whose only
    // writer is gated on a state its callers refuse to run in. No timer is
    // scheduled and the overlay is untouched.
    expect(delays).toEqual([]);
    expect(doc.getElementById('player-overlay').classList.contains('visible')).toBe(false);
    // "Nothing happened" and "the handler threw before doing anything" look
    // identical from the DOM, so the no-throw detector is load-bearing here.
    expectFrameSurvived(doc);
  });
});

describe('frames whose only effect is a log line', () => {
  it('an on-air voice-status frame logs it', () => {
    const { doc, send } = boot();
    send({ type: 'init', data: initState('live', true) });
    expect(logText(doc)).not.toContain('PTT: voice message on air');

    send({ type: 'voice-status', data: { status: 'on-air' } });

    // The case has no DOM effect at all — the log line is its only observable.
    expect(logText(doc)).toContain('PTT: voice message on air');
    expectFrameSurvived(doc);
  });

  it('any other voice-status body logs nothing', () => {
    const { doc, send } = boot();
    send({ type: 'init', data: initState('live', true) });

    send({ type: 'voice-status', data: { status: 'idle' } });
    send({ type: 'voice-status', data: {} });
    send({ type: 'voice-status', data: null });

    expect(logText(doc)).not.toContain('PTT: voice message on air');
    expectFrameSurvived(doc);
  });

  it('an rtmp-health frame is forwarded to the restream module without throwing', () => {
    const { doc, send } = boot();
    send({ type: 'init', data: initState('live', true) });
    send({ type: 'rtmp-health', data: { youtube: { healthy: true } } });
    expectFrameSurvived(doc);
  });

  it('an unknown message type falls through the switch harmlessly', () => {
    const { doc, send } = boot();
    send({ type: 'init', data: initState('live', true) });
    send({ type: 'no-such-type', data: { anything: true } });
    expectFrameSurvived(doc);
  });
});

describe('mixing mode pills', () => {
  it('smart is the active pill in the shipped markup', () => {
    const { doc } = boot();
    expect(Array.from(doc.querySelectorAll('.mix-pill')).map((p) => p.dataset.mixmode))
      .toEqual(['smart', 'cut', 'crossfade']);
    expect(activeMixPill(doc)).toEqual(['smart']);
  });

  it('clicking a pill posts the new mode and moves the highlight on success', async () => {
    const { win, doc } = boot();
    const { fetch, calls } = makeFetchStub([routeExact('POST', '/api/mixing/config', { ok: true })]);
    win.fetch = fetch;

    doc.querySelectorAll('.mix-pill')[1].click();
    await flush(20);

    expect(calls.map((c) => c.method + ' ' + c.url)).toEqual(['POST /api/mixing/config']);
    expect(calls[0].body).toEqual({ mode: 'cut' });
    expect(activeMixPill(doc)).toEqual(['cut']);
  });

  it('accepts a response that echoes the mode instead of an ok flag', async () => {
    const { win, doc } = boot();
    const { fetch } = makeFetchStub([routeExact('POST', '/api/mixing/config', { mode: 'crossfade' })]);
    win.fetch = fetch;

    doc.querySelectorAll('.mix-pill')[2].click();
    await flush(20);

    // The success guard is `data.ok || data.mode`.
    expect(activeMixPill(doc)).toEqual(['crossfade']);
  });

  it('leaves the highlight alone when the server acknowledges neither field', async () => {
    const { win, doc } = boot();
    const { fetch } = makeFetchStub([routeExact('POST', '/api/mixing/config', {})]);
    win.fetch = fetch;

    doc.querySelectorAll('.mix-pill')[1].click();
    await flush(20);

    expect(activeMixPill(doc)).toEqual(['smart']);
  });

  it('clicking the already-active pill sends nothing', async () => {
    const { win, doc } = boot();
    const { fetch, calls } = makeFetchStub([routeExact('POST', '/api/mixing/config', { ok: true })]);
    win.fetch = fetch;

    doc.querySelectorAll('.mix-pill')[0].click();
    await flush(20);

    expect(calls).toEqual([]);
    expect(activeMixPill(doc)).toEqual(['smart']);
  });

  it('a mixing-config frame moves the highlight without any request', async () => {
    const { win, doc, send } = boot();
    const { fetch, calls } = makeFetchStub([]);
    win.fetch = fetch;

    send({ type: 'mixing-config', data: { mode: 'cut' } });

    expect(activeMixPill(doc)).toEqual(['cut']);
    expect(calls).toEqual([]);
    // The pill class moves BEFORE the rest of the case body runs, so without
    // this the pin stays green even when the frame throws half way through.
    expectFrameSurvived(doc);
  });

  it('a mixing-config frame with no mode is ignored', () => {
    const { doc, send } = boot();
    send({ type: 'mixing-config', data: { mode: 'cut' } });
    send({ type: 'mixing-config', data: {} });
    send({ type: 'mixing-config', data: null });
    expect(activeMixPill(doc)).toEqual(['cut']);
    expectFrameSurvived(doc);
  });
});

describe('live-mode frame and the Phase 1 Live Mode bar', () => {
  it('none of the Live Mode bar controls exist in the shipped markup', () => {
    const { doc } = boot();
    for (const id of ['live-mode-bar', 'live-afk-fallback', 'live-status-badge',
      'live-ingest-url', 'live-ingest-key', 'live-copy-url']) {
      expect(doc.getElementById(id), id + ' should be absent in Phase 1').toBe(null);
    }
    expect(doc.querySelectorAll('.live-source-pill')).toHaveLength(0);
  });

  it('logs the OBS status, which is the only effect the frame has in Phase 1', () => {
    const { doc, send } = boot();
    send({ type: 'init', data: initState('live', true, 'live') });
    expect(logText(doc)).not.toContain('live: connected');

    send({ type: 'live-mode', data: { source: 'obs', obsStatus: 'connected', afkFallback: 'visual-radio', ingestKey: '' } });

    // updateLiveModeUI returns at its first line (no #live-afk-fallback) and
    // every liveMode reader inside updateModeUI is behind Phase 2/3 markup, so
    // the DOM is untouched. The log line is the case's only observable effect —
    // asserting the mode-card classes here would pass with the whole case body
    // deleted, since the preceding init frame is what sets them.
    expect(logText(doc)).toContain('live: connected');
    expectFrameSurvived(doc);
    // The classes the init frame set are still there afterwards.
    expect(doc.querySelector('.studio-layout').classList.contains('mode-takeover')).toBe(true);
  });

  it('REPLACES liveMode wholesale, so a partial frame drops the other fields', () => {
    const { win, send } = boot();
    send({ type: 'init', data: initState('live', true) });
    const before = win.__appDrift.getBroadcastState().liveMode;
    expect(before.source).toBe('obs');

    send({ type: 'live-mode', data: { obsStatus: 'disconnected' } });

    // `broadcastState.liveMode = msg.data` — not a merge. source, afkFallback
    // and ingestKey are gone, and the object identity changes. Pinned AS-IS:
    // downstream readers (the mixer's streaming check, the mode-card AFK
    // select) then see undefined.
    const after = win.__appDrift.getBroadcastState().liveMode;
    expect(after).not.toBe(before);
    expect(after).toEqual({ obsStatus: 'disconnected' });
    expect(after.source).toBeUndefined();
    expect(after.afkFallback).toBeUndefined();
  });

  it('a falsy live-mode body leaves the previous liveMode untouched', () => {
    const { win, send } = boot();
    send({ type: 'init', data: initState('live', true) });
    send({ type: 'live-mode', data: { source: 'browser-mic', obsStatus: 'connected' } });
    const kept = win.__appDrift.getBroadcastState().liveMode;

    send({ type: 'live-mode', data: null });

    expect(win.__appDrift.getBroadcastState().liveMode).toBe(kept);
  });

  it('the init frame replaces liveMode the same way', () => {
    const { win, send } = boot();
    send({ type: 'init', data: initState('live', true) });
    send({ type: 'init', data: initState('live', true, null, { liveMode: { obsStatus: 'connected' } }) });
    expect(win.__appDrift.getBroadcastState().liveMode).toEqual({ obsStatus: 'connected' });
  });
});
