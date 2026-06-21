/**
 * tests/dashboard/icecast.test.js
 *
 * Characterization of dashboard/lib/icecast.js (P1-6).
 *
 * Strategy: icecast.js bakes ICECAST_URL into a module-level const and
 * talks to it via http.get from the shared node `http` module. vi.mock()
 * is inert for CJS-internal requires here, so we require the SAME `http`
 * instance via createRequire and spy on http.get directly (boot.test.js
 * technique). The poller is async, so ticks are drained with
 * vi.advanceTimersByTimeAsync.
 *
 * Pinned here (current behavior):
 *   - poll() parses icestats.source as ARRAY (src[0] only) or OBJECT
 *     (used directly); undefined/empty-array source -> NO onUpdate;
 *   - payload field fallbacks (bitrate: audio_bitrate || bitrate || 0,
 *     title: title || server_name || '', etc.);
 *   - all errors (network, non-JSON, parse) are swallowed -> no onUpdate;
 *   - start(): immediate poll() then setInterval(5000); stop():
 *     clearInterval (no further ticks).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const http = nodeRequire('http');
const { createIcecastPoller } = nodeRequire('../../dashboard/lib/icecast');

/**
 * Spy http.get to deliver a JSON body (or an error). Mirrors the shape
 * icecast.js consumes: get(url, opts, cb) returning a req with .on('error').
 */
function mockHttp(spec = {}) {
  return vi.spyOn(http, 'get').mockImplementation((url, opts, cb) => makeReq(spec, cb));
}

/**
 * Synthesize the http.get request/response. IO is delivered via Promise
 * microtasks (NOT the faked clock), so a single await
 * vi.advanceTimersByTimeAsync(0) after a poll drains it deterministically.
 */
function makeReq({ json, body, error }, cb) {
  const errHandlers = [];
  const req = {
    on: vi.fn((event, handler) => {
      if (event === 'error') errHandlers.push(handler);
      return req;
    })
  };
  if (error) {
    Promise.resolve().then(() => errHandlers.forEach((h) => h(error)));
    return req;
  }
  const payload = body !== undefined ? body : JSON.stringify(json);
  const handlers = {};
  const res = { on: vi.fn((event, handler) => { handlers[event] = handler; return res; }) };
  Promise.resolve().then(() => {
    cb(res);
    if (handlers.data) handlers.data(payload);
    if (handlers.end) handlers.end();
  });
  return req;
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

describe('dashboard/lib/icecast.js', () => {
  it('start() polls immediately then on a 5000ms interval; stop() clears it', async () => {
    mockHttp({ json: { icestats: { source: { listeners: 1 } } } });
    const onUpdate = vi.fn();
    poller = createIcecastPoller(onUpdate);

    poller.start();
    await vi.advanceTimersByTimeAsync(0); // drain the immediate poll
    expect(onUpdate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(onUpdate).toHaveBeenCalledTimes(2);

    poller.stop();
    await vi.advanceTimersByTimeAsync(20000);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('array source: uses only src[0]', async () => {
    mockHttp({
      json: {
        icestats: {
          server_start: 'start-ts',
          source: [
            { listeners: 7, audio_bitrate: 128, title: 'first', genre: 'rock', server_name: 'S1' },
            { listeners: 99, title: 'second' }
          ]
        }
      }
    });
    const onUpdate = vi.fn();
    poller = createIcecastPoller(onUpdate);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(onUpdate).toHaveBeenCalledWith({
      listeners: 7,
      bitrate: 128,
      serverStart: 'start-ts',
      title: 'first',
      genre: 'rock',
      server_name: 'S1'
    });
  });

  it('object source: used directly with field fallbacks', async () => {
    // No audio_bitrate -> falls back to bitrate; no title -> server_name.
    mockHttp({
      json: { icestats: { source: { bitrate: 64, server_name: 'MountA' } } }
    });
    const onUpdate = vi.fn();
    poller = createIcecastPoller(onUpdate);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(onUpdate).toHaveBeenCalledWith({
      listeners: 0,
      bitrate: 64,
      serverStart: '',
      title: 'MountA',
      genre: '',
      server_name: 'MountA'
    });
  });

  it('all-zero/empty fallbacks when fields absent', async () => {
    mockHttp({ json: { icestats: { source: {} } } });
    const onUpdate = vi.fn();
    poller = createIcecastPoller(onUpdate);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(onUpdate).toHaveBeenCalledWith({
      listeners: 0,
      bitrate: 0,
      serverStart: '',
      title: '',
      genre: '',
      server_name: ''
    });
  });

  it('undefined source -> no onUpdate', async () => {
    mockHttp({ json: { icestats: {} } });
    const onUpdate = vi.fn();
    poller = createIcecastPoller(onUpdate);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('empty-array source -> no onUpdate (src[0] is undefined)', async () => {
    mockHttp({ json: { icestats: { source: [] } } });
    const onUpdate = vi.fn();
    poller = createIcecastPoller(onUpdate);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('network error is swallowed -> no onUpdate, no throw', async () => {
    mockHttp({ error: new Error('ECONNREFUSED') });
    const onUpdate = vi.fn();
    poller = createIcecastPoller(onUpdate);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('non-JSON body is swallowed -> no onUpdate', async () => {
    mockHttp({ body: 'not json at all' });
    const onUpdate = vi.fn();
    poller = createIcecastPoller(onUpdate);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
