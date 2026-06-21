/**
 * tests/dashboard/liquidsoap.test.js
 *
 * Characterization of dashboard/lib/liquidsoap.js (P1-6).
 *
 * Note: the exported factory is createLiquidoapPoller — the source has a
 * typo (missing 's' in "Liquidsoap"). Pinned as-is.
 *
 * Strategy: same http.get spy on the shared `http` instance as icecast;
 * the poller distinguishes LS (http://dj:7000/metadata) from the icecast
 * fallback by URL, so the spy branches on the requested URL.
 *
 * STICKY LATCH pinned here (current behavior):
 *   - while useFallback is false, a successful LS fetch calls onUpdate with
 *     {title, filename} and RETURNS early (fallback never runs);
 *   - the FIRST LS failure flips useFallback=true inside the catch AND
 *     falls through to the icecast fallback on the SAME tick;
 *   - once latched, the `if (!useFallback)` guard means LS is NEVER
 *     retried — every later tick goes straight to icecast (one-way latch);
 *   - fallback parses array/object source, title-only payload, errors
 *     swallowed; start(): immediate poll + setInterval(2000); stop() clears.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const http = nodeRequire('http');
const { createLiquidoapPoller } = nodeRequire('../../dashboard/lib/liquidsoap');

const LS_URL = 'http://dj:7000/metadata';

/**
 * Spy http.get with a per-URL responder. responder(url) returns one of:
 *   { json } | { body } | { error } to control each fetch.
 */
function mockHttpByUrl(responder) {
  return vi.spyOn(http, 'get').mockImplementation((url, opts, cb) => {
    // IO is delivered via Promise microtasks (NOT the faked clock), so an
    // await vi.advanceTimersByTimeAsync(...) after a poll drains it.
    const out = responder(url) || {};
    const errHandlers = [];
    const req = {
      on: vi.fn((event, handler) => {
        if (event === 'error') errHandlers.push(handler);
        return req;
      })
    };
    if (out.error) {
      Promise.resolve().then(() => errHandlers.forEach((h) => h(out.error)));
      return req;
    }
    const payload = out.body !== undefined ? out.body : JSON.stringify(out.json);
    const handlers = {};
    const res = { on: vi.fn((event, handler) => { handlers[event] = handler; return res; }) };
    Promise.resolve().then(() => {
      cb(res);
      if (handlers.data) handlers.data(payload);
      if (handlers.end) handlers.end();
    });
    return req;
  });
}

let poller;

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

describe('dashboard/lib/liquidsoap.js', () => {
  it('export name is createLiquidoapPoller (source typo), a factory', () => {
    expect(typeof createLiquidoapPoller).toBe('function');
  });

  it('LS success: onUpdate with {title, filename}, fallback never runs', async () => {
    const calls = [];
    mockHttpByUrl((url) => {
      calls.push(url);
      if (url === LS_URL) return { json: { title: 'Song A', filename: 'a.wav' } };
      return { json: { icestats: { source: { title: 'ICE' } } } };
    });
    const onUpdate = vi.fn();
    poller = createLiquidoapPoller(onUpdate);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ title: 'Song A', filename: 'a.wav' });
    // Only LS was queried — fallback URL never hit.
    expect(calls).toEqual([LS_URL]);
  });

  it('LS success field fallbacks: missing title/filename -> empty strings', async () => {
    mockHttpByUrl(() => ({ json: {} }));
    const onUpdate = vi.fn();
    poller = createLiquidoapPoller(onUpdate);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).toHaveBeenCalledWith({ title: '', filename: '' });
  });

  it('start() polls immediately then setInterval(2000); stop() clears', async () => {
    mockHttpByUrl(() => ({ json: { title: 't', filename: 'f' } }));
    const onUpdate = vi.fn();
    poller = createLiquidoapPoller(onUpdate);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(onUpdate).toHaveBeenCalledTimes(2);

    poller.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('STICKY LATCH: first LS failure latches fallback AND fires icecast on the same tick', async () => {
    const calls = [];
    mockHttpByUrl((url) => {
      calls.push(url);
      if (url === LS_URL) return { error: new Error('ECONNREFUSED') };
      return { json: { icestats: { source: { title: 'ICE-TITLE' } } } };
    });
    const onUpdate = vi.fn();
    poller = createLiquidoapPoller(onUpdate);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    // Same tick: LS tried (failed) then icecast fallback delivered.
    expect(calls).toEqual([LS_URL, 'http://icecast:8000/status-json.xsl']);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ title: 'ICE-TITLE', filename: '' });
  });

  it('after latch, LS is NEVER retried — every tick goes straight to icecast', async () => {
    const calls = [];
    mockHttpByUrl((url) => {
      calls.push(url);
      if (url === LS_URL) return { error: new Error('down') };
      return { json: { icestats: { source: [{ title: 'ARR-ICE' }] } } };
    });
    const onUpdate = vi.fn();
    poller = createLiquidoapPoller(onUpdate);
    poller.start();
    await vi.advanceTimersByTimeAsync(0); // latch on tick 1
    calls.length = 0;

    await vi.advanceTimersByTimeAsync(2000); // tick 2
    await vi.advanceTimersByTimeAsync(2000); // tick 3
    // Neither later tick touched LS — icecast only.
    expect(calls.every((u) => u !== LS_URL)).toBe(true);
    expect(calls).toEqual([
      'http://icecast:8000/status-json.xsl',
      'http://icecast:8000/status-json.xsl'
    ]);
    // Array source uses src[0].
    expect(onUpdate).toHaveBeenLastCalledWith({ title: 'ARR-ICE', filename: '' });
  });

  it('fallback icecast error after latch is swallowed -> no onUpdate that tick', async () => {
    mockHttpByUrl((url) => {
      if (url === LS_URL) return { error: new Error('down') };
      return { error: new Error('icecast down too') };
    });
    const onUpdate = vi.fn();
    poller = createLiquidoapPoller(onUpdate);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
