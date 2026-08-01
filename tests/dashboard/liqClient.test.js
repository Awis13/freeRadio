/**
 * tests/dashboard/liqClient.test.js
 *
 * Wire-level characterization of dashboard/lib/liqClient.js (P1-2).
 *
 * Strategy: liqClient is CJS and talks plain http to the Liquidsoap DJ
 * sidecar (host/port baked into module-level consts at require time).
 * vi.mock() is inert for requires made inside CJS modules in this repo
 * (see tests/dashboard/server.test.js), so instead we:
 *   1. start a REAL loopback http server on 127.0.0.1:0 that records
 *      method/url/headers/raw body and answers via a per-test responder;
 *   2. set DJ_HOST/DJ_PORT env BEFORE a fresh require of liqClient
 *      (cache-deleted), so the baked consts point at the recorder.
 *
 * Pinned here (current behavior, callers depend on it):
 *   - exact method + path + raw wire body for all 17 wrappers
 *     (filePath strings sent raw, config objects JSON.stringified,
 *     '' bodies for the no-payload POST group);
 *   - Content-Length: explicit Buffer.byteLength(body) when body is
 *     truthy; for the ''-body POSTs the explicit header is SKIPPED
 *     (empty string is falsy) and Node itself emits content-length: 0;
 *     GETs carry none. No Content-Type is EVER set — the DJ side
 *     parses raw bodies regardless.
 *   - request() core: JSON response -> parsed object; non-JSON ->
 *     raw string fallback; NON-2XX RESOLVES with { status, data }
 *     (never rejects — callers read .data unguarded, so turning this
 *     into a reject would be a breaking change);
 *   - network error (connection refused) -> rejects;
 *   - request timeout (DJ_TIMEOUT_MS, default 5000) -> req.destroy() +
 *     reject(new Error('timeout')). Pinned with a 150ms override against a
 *     never-responding server, plus a server-side observation that the
 *     client socket really closes (destroy(), not a dangling connection).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import http from 'node:http';

const nodeRequire = createRequire(import.meta.url);
const LIQ_SPEC = '../../dashboard/lib/liqClient';

// Env snapshot taken before any test mutates it; restored verbatim in afterAll.
const ORIGINAL_ENV = {
  DJ_HOST: process.env.DJ_HOST,
  DJ_PORT: process.env.DJ_PORT,
  DJ_TIMEOUT_MS: process.env.DJ_TIMEOUT_MS
};

function restoreOriginalEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Fresh require of liqClient with DJ_HOST/DJ_PORT/DJ_TIMEOUT_MS baked from env. */
function freshLiq(host, port, timeoutMs) {
  process.env.DJ_HOST = host;
  process.env.DJ_PORT = String(port);
  if (timeoutMs === undefined) delete process.env.DJ_TIMEOUT_MS;
  else process.env.DJ_TIMEOUT_MS = String(timeoutMs);
  const id = nodeRequire.resolve(LIQ_SPEC);
  delete nodeRequire.cache[id];
  // liqClient reads DJ_HOST/DJ_PORT through paths.js, which bakes env at require
  // time, so it has to be re-required as well for the values set above to land.
  delete nodeRequire.cache[nodeRequire.resolve('../../dashboard/lib/paths')];
  return nodeRequire(id);
}

let server;        // recorder server (default target of `liq`)
let liq;           // liqClient instance pointed at the recorder
let lastReq;       // { method, url, headers, body } of the last request seen
let responder;     // (req, res) => void, programmable per test

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastReq = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      };
      responder(req, res);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  liq = freshLiq('127.0.0.1', server.address().port);
});

afterAll(async () => {
  // Keep-alive sockets (Node 22 default agent) would otherwise hang vitest.
  http.globalAgent.destroy();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  restoreOriginalEnv();
});

beforeEach(() => {
  lastReq = undefined;
  responder = (req, res) => {
    res.statusCode = 200;
    res.end('{"ok":true}');
  };
});

afterEach(() => {
  // Some tests freshLiq() against throwaway servers; re-point the env at the
  // recorder (and drop any timeout override) so any later fresh require keeps
  // working — replaces per-test copy-paste restores.
  process.env.DJ_HOST = '127.0.0.1';
  process.env.DJ_PORT = String(server.address().port);
  delete process.env.DJ_TIMEOUT_MS;
});

// ─── exports surface ─────────────────────────────────────────────────────────

describe('exports', () => {
  it('exposes request plus exactly the 17 wrappers', () => {
    expect(Object.keys(liq).sort()).toEqual([
      'clearQueue', 'cueTrack', 'getMixingConfig', 'getQueue',
      'getQueueLength', 'getStripConfig', 'getStripMetering',
      'getVoiceConfig', 'pushTrack', 'pushVoice', 'request',
      'resumePlayback', 'setMixingConfig', 'setStripConfig',
      'setVoiceConfig', 'skip', 'startPlayback', 'stopPlayback'
    ]);
  });
});

// ─── 17-wrapper wire mapping ─────────────────────────────────────────────────

// Multi-byte path: pins Content-Length = Buffer.byteLength, not string length.
const UTF8_PATH = '/music/café-déjà.mp3'; // 20 chars, 23 bytes
const CONFIG = { enabled: true, gainDb: -3.5, name: 'voice "duck"' };

// [name, args, method, path, bodyKind, expectedBody]
// bodyKind: 'none' (GET) | 'empty' ('') | 'raw' (filePath) | 'json'
const WRAPPERS = [
  ['getQueue',        [],          'GET',  '/queue',           'none',  null],
  ['pushTrack',       [UTF8_PATH], 'POST', '/queue/push',      'raw',   UTF8_PATH],
  ['skip',            [],          'POST', '/skip',            'empty', ''],
  ['clearQueue',      [],          'POST', '/queue/clear',     'empty', ''],
  ['getQueueLength',  [],          'GET',  '/queue/length',    'none',  null],
  ['pushVoice',       [UTF8_PATH], 'POST', '/voice/push',      'raw',   UTF8_PATH],
  ['getVoiceConfig',  [],          'GET',  '/voice/config',    'none',  null],
  ['setVoiceConfig',  [CONFIG],    'POST', '/voice/config',    'json',  JSON.stringify(CONFIG)],
  ['getMixingConfig', [],          'GET',  '/mixing/config',   'none',  null],
  ['setMixingConfig', [CONFIG],    'POST', '/mixing/config',   'json',  JSON.stringify(CONFIG)],
  ['startPlayback',   [],          'POST', '/playback/start',  'empty', ''],
  ['stopPlayback',    [],          'POST', '/playback/stop',   'empty', ''],
  ['resumePlayback',  [],          'POST', '/playback/resume', 'empty', ''],
  ['cueTrack',        [UTF8_PATH], 'POST', '/playback/cue',    'raw',   UTF8_PATH],
  ['getStripConfig',  [],          'GET',  '/strip/config',    'none',  null],
  ['setStripConfig',  [CONFIG],    'POST', '/strip/config',    'json',  JSON.stringify(CONFIG)],
  ['getStripMetering',[],          'GET',  '/strip/metering',  'none',  null]
];

describe('wrapper -> wire mapping (all 17)', () => {
  it.each(WRAPPERS)('%s sends %s %s', async (name, args, method, path, bodyKind, expectedBody) => {
    const result = await liq[name](...args);

    expect(lastReq.method).toBe(method);
    expect(lastReq.url).toBe(path);
    expect(result).toEqual({ status: 200, data: { ok: true } });

    // No Content-Type, ever — pinned current behavior.
    expect(lastReq.headers['content-type']).toBeUndefined();

    if (bodyKind === 'none') {
      // GET: no body written, no Content-Length on the wire.
      expect(lastReq.body).toBe('');
      expect(lastReq.headers['content-length']).toBeUndefined();
    } else if (bodyKind === 'empty') {
      // '' is falsy: explicit header skipped, req.write skipped;
      // Node itself emits content-length: 0 on end().
      expect(lastReq.body).toBe('');
      expect(lastReq.headers['content-length']).toBe('0');
    } else {
      // raw filePath / JSON.stringify(config), written verbatim.
      expect(lastReq.body).toBe(expectedBody);
      expect(lastReq.headers['content-length'])
        .toBe(String(Buffer.byteLength(expectedBody)));
    }
  });

  it('pins byte-length vs char-length for multi-byte bodies', async () => {
    await liq.pushTrack(UTF8_PATH);
    expect(UTF8_PATH.length).toBe(20);
    expect(lastReq.headers['content-length']).toBe('23');
  });
});

// ─── request() core semantics ────────────────────────────────────────────────

describe('request() core', () => {
  it('parses a JSON response body into an object', async () => {
    responder = (req, res) => { res.statusCode = 200; res.end('{"queue":["a.mp3"],"n":1}'); };
    await expect(liq.request('GET', '/queue'))
      .resolves.toEqual({ status: 200, data: { queue: ['a.mp3'], n: 1 } });
  });

  it('falls back to the raw string when the body is not JSON', async () => {
    responder = (req, res) => { res.statusCode = 200; res.end('OK not json'); };
    await expect(liq.request('GET', '/queue'))
      .resolves.toEqual({ status: 200, data: 'OK not json' });
  });

  it('RESOLVES on non-2xx — status in result, never a rejection (caller contract)', async () => {
    // Characterization: callers read .data unguarded and branch on .status
    // themselves; a 500 from the DJ resolves like any other response.
    responder = (req, res) => { res.statusCode = 500; res.end('liquidsoap exploded'); };
    await expect(liq.request('POST', '/skip', ''))
      .resolves.toEqual({ status: 500, data: 'liquidsoap exploded' });
  });

  it('resolves an empty 204-style body as the raw empty string', async () => {
    // JSON.parse('') throws -> raw-string fallback.
    responder = (req, res) => { res.statusCode = 204; res.end(); };
    await expect(liq.request('GET', '/queue'))
      .resolves.toEqual({ status: 204, data: '' });
  });

  it('rejects on network error (connection refused)', async () => {
    // Grab a port that is guaranteed free, then close it.
    const probe = http.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const deadPort = probe.address().port;
    await new Promise((r) => probe.close(r));

    const deadLiq = freshLiq('127.0.0.1', deadPort);
    await expect(deadLiq.getQueue()).rejects.toThrow(/ECONNREFUSED/);
  });

  it('rejects with Error("timeout") after DJ_TIMEOUT_MS when the DJ never responds', async () => {
    // The production default stays 5000 (DJ_TIMEOUT_MS unset anywhere); the
    // override keeps the suite fast while pinning the same timeout machinery.
    const TIMEOUT_MS = 150;
    const blackHole = http.createServer(() => { /* never respond */ });
    await new Promise((r) => blackHole.listen(0, '127.0.0.1', r));

    // The timeout handler calls req.destroy(); pin that the socket really
    // closes by watching the server side of the connection.
    const socketClosed = new Promise((resolve) => {
      blackHole.once('connection', (sock) => sock.once('close', resolve));
    });

    const slowLiq = freshLiq('127.0.0.1', blackHole.address().port, TIMEOUT_MS);
    const started = Date.now();
    try {
      await expect(slowLiq.getQueue()).rejects.toThrow('timeout');
      expect(Date.now() - started).toBeGreaterThanOrEqual(TIMEOUT_MS - 10);
      await socketClosed; // hangs (and trips the test timeout) if destroy() regresses
    } finally {
      blackHole.closeAllConnections();
      await new Promise((r) => blackHole.close(r));
    }
  }, 3000);
});
