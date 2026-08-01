/**
 * tests/dashboard/wsServer.test.js
 *
 * Characterization of dashboard/lib/wsServer.js (P1-5).
 *
 * Strategy: wsServer is CJS and bakes DASHBOARD_TOKEN into a module-level
 * const at require time (NOT at connection time). vi.mock() is inert for
 * requires made inside CJS modules in this repo (see server.test.js), so we
 * use the liqClient.test.js technique: set env BEFORE a fresh require
 * (cache-deleted), then run a REAL loopback http server + real ws clients
 * from the same `ws` package the lib uses.
 *
 * Pinned here (current behavior, dashboard frontend depends on it):
 *   - no-token mode: client is auto-authenticated and receives
 *     {type:'init', data:getInitState()} immediately on connect;
 *   - token mode auth state machine, exact close-code contract:
 *       correct first {type:'auth'} -> init + 5s timer cleared (no later close)
 *       wrong token              -> close(4401, 'Invalid token')
 *       non-auth first message   -> close(4401, 'Not authenticated')
 *       silence for 5s           -> close(4401, 'Auth timeout')
 *   - SECURITY FILTER: broadcast() skips clients that are connected but not
 *     yet authenticated — a pre-auth socket must never see state updates;
 *   - broadcast wire shape is exactly JSON.stringify({type, data});
 *   - broadcast skips sockets with readyState !== 1 without crashing;
 *   - setupTlsWs patches the shared broadcast fn to fan out to BOTH servers.
 *
 * Fake timers decision: the 5s auth timeout is a plain global setTimeout
 * called at connection time, so vi.useFakeTimers({toFake:['setTimeout',
 * 'clearTimeout']}) controls it while real socket IO keeps flowing
 * (verified empirically — no real-wait fallback needed). Message/close
 * waits in fake-timer tests are pure event-listener promises, never
 * vi.waitFor (which would auto-advance the fake clock and could fire the
 * auth timer prematurely).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import http from 'node:http';

const nodeRequire = createRequire(import.meta.url);
const WS_SPEC = '../../dashboard/lib/wsServer';

// Same ws package instance the lib uses (root devDependency).
const { WebSocket } = nodeRequire('ws');

const ORIGINAL_TOKEN = process.env.DASHBOARD_TOKEN;

const ORIGINAL_AUTH_DISABLED = process.env.AUTH_DISABLED;

/**
 * Fresh require of wsServer.js with the given token baked in.
 *
 * `authDisabled` is explicit on purpose: an unset DASHBOARD_TOKEN no longer
 * means "let everyone in", so a test that wants an open socket has to say so,
 * exactly as an operator would.
 */
function freshWsServer(token, { authDisabled = false } = {}) {
  if (token === undefined) delete process.env.DASHBOARD_TOKEN;
  else process.env.DASHBOARD_TOKEN = token;
  if (authDisabled) process.env.AUTH_DISABLED = 'true';
  else delete process.env.AUTH_DISABLED;
  delete nodeRequire.cache[nodeRequire.resolve(WS_SPEC)];
  return nodeRequire(WS_SPEC);
}

let harnesses = [];

/** Start a loopback http server with setupWs attached. */
async function startHarness(token, initState = { hello: 'init' }, opts = {}) {
  const wsMod = freshWsServer(token, opts);
  const server = http.createServer();
  const getInitState = vi.fn(() => initState);
  const wss = wsMod.setupWs(server, null, getInitState);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const h = {
    wsMod, server, wss, getInitState,
    port: server.address().port,
    clients: [],
    extraServers: []
  };
  harnesses.push(h);
  return h;
}

/** Attach a second server via setupTlsWs (plain http works — it only needs a server). */
async function attachSecondServer(h) {
  const server = http.createServer();
  const wssTls = h.wsMod.setupTlsWs(server, null, h.getInitState, h.wss);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  h.extraServers.push({ server, wssTls });
  return { port: server.address().port, wssTls };
}

/** Connect a real ws client; collects parsed messages and raw frames. */
function connect(h, port = h.port) {
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  const raw = [];
  const closeInfo = { settled: false };
  const closed = new Promise((res) => {
    client.on('close', (code, reason) => {
      closeInfo.settled = true;
      res({ code, reason: reason.toString() });
    });
  });
  client.on('message', (d) => {
    raw.push(d.toString());
    messages.push(JSON.parse(d.toString()));
  });
  const opened = new Promise((res, rej) => {
    client.once('open', res);
    client.once('error', rej);
  });
  h.clients.push(client);
  return { client, messages, raw, opened, closed, closeInfo };
}

/**
 * Event-driven wait for the Nth message (0-based). Safe under fake timers
 * and immune to messages that already arrived before this call (the
 * no-token init lands in the same IO batch as 'open').
 */
function messageAt(c, index) {
  return new Promise((res) => {
    if (c.messages.length > index) return res(c.messages[index]);
    const check = () => {
      if (c.messages.length > index) {
        c.client.off('message', check);
        res(c.messages[index]);
      }
    };
    c.client.on('message', check);
  });
}

/** Give real IO a chance to flush without touching (possibly fake) setTimeout. */
async function flushIo(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

/** Real-clock delay for "nothing should arrive" windows (real-timer tests only). */
function realDelay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

afterEach(async () => {
  vi.useRealTimers();
  for (const h of harnesses) {
    for (const c of h.clients) c.terminate();
    await new Promise((r) => h.wss.close(r));
    await new Promise((r) => h.server.close(r));
    for (const e of h.extraServers) {
      await new Promise((r) => e.wssTls.close(r));
      await new Promise((r) => e.server.close(r));
    }
  }
  harnesses = [];
  if (ORIGINAL_TOKEN === undefined) delete process.env.DASHBOARD_TOKEN;
  else process.env.DASHBOARD_TOKEN = ORIGINAL_TOKEN;
  delete nodeRequire.cache[nodeRequire.resolve(WS_SPEC)];
});

// ---------------------------------------------------------------------------
// No-token mode
// ---------------------------------------------------------------------------
describe('setupWs with auth explicitly disabled (AUTH_DISABLED=true)', () => {
  it('auto-authenticates and sends init with the getInitState payload', async () => {
    const h = await startHarness(undefined, { track: 'song.mp3', volume: 0.8 }, { authDisabled: true });
    const c = connect(h);
    await c.opened;
    const init = await messageAt(c, 0);
    expect(init).toEqual({ type: 'init', data: { track: 'song.mp3', volume: 0.8 } });
    expect(h.getInitState).toHaveBeenCalledTimes(1);
  });

  it('broadcast reaches a connected client as exact {type, data} JSON', async () => {
    const h = await startHarness(undefined, { hello: 'init' }, { authDisabled: true });
    const c = connect(h);
    await c.opened;
    await messageAt(c, 0); // init
    const msgPromise = messageAt(c, 1);
    h.wsMod.broadcast('status', { playing: true, n: 1 });
    expect(await msgPromise).toEqual({ type: 'status', data: { playing: true, n: 1 } });
    // Exact wire shape pin.
    expect(c.raw[1]).toBe(JSON.stringify({ type: 'status', data: { playing: true, n: 1 } }));
  });

  it('broadcast skips sockets with readyState !== 1 without crashing', async () => {
    const h = await startHarness(undefined, { hello: 'init' }, { authDisabled: true });
    const a = connect(h);
    await a.opened;
    await messageAt(a, 0);
    const b = connect(h);
    await b.opened;
    await messageAt(b, 0);

    // Server-side close() puts the first socket into CLOSING synchronously
    // while it is still in wss.clients.
    const serverSocks = [...h.wss.clients];
    expect(serverSocks).toHaveLength(2);
    serverSocks[0].close();
    expect(serverSocks[0].readyState).not.toBe(1);

    expect(() => h.wsMod.broadcast('tick', { n: 2 })).not.toThrow();
    const msg = await messageAt(b, 1);
    expect(msg).toEqual({ type: 'tick', data: { n: 2 } });
    // First client got only its init, never the broadcast.
    await a.closed;
    expect(a.messages).toEqual([{ type: 'init', data: { hello: 'init' } }]);
  });
});

// ---------------------------------------------------------------------------
// Token mode — auth state machine
// ---------------------------------------------------------------------------
describe('setupWs with auth unconfigured (no token, no opt-out)', () => {
  it('closes the socket instead of handing out the state feed', async () => {
    // CHANGED IN T11-C2: an unset DASHBOARD_TOKEN used to auto-authenticate
    // every socket, so a deployment that forgot its token broadcast its live
    // state to anyone who connected.
    const h = await startHarness(undefined);
    const ws = connect(h);

    const { code, reason } = await ws.closed;
    expect(code).toBe(4401);
    expect(reason).toContain('Auth is not configured');
  });
});

describe('setupWs with DASHBOARD_TOKEN', () => {
  it('does not send init before auth; correct token gets init', async () => {
    const h = await startHarness('s3cret', { mode: 'radio' });
    const c = connect(h);
    await c.opened;
    await flushIo();
    expect(c.messages).toEqual([]); // nothing pushed pre-auth
    expect(h.getInitState).not.toHaveBeenCalled();

    const initPromise = messageAt(c, 0);
    c.client.send(JSON.stringify({ type: 'auth', token: 's3cret' }));
    expect(await initPromise).toEqual({ type: 'init', data: { mode: 'radio' } });
  });

  it('correct auth clears the 5s timer — no close after the timeout window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = await startHarness('s3cret');
    const c = connect(h);
    await c.opened;
    const initPromise = messageAt(c, 0);
    c.client.send(JSON.stringify({ type: 'auth', token: 's3cret' }));
    await initPromise;

    vi.advanceTimersByTime(6000);
    await flushIo();
    expect(c.closeInfo.settled).toBe(false);
    expect(c.client.readyState).toBe(WebSocket.OPEN);
  });

  it('wrong token -> close 4401 "Invalid token"', async () => {
    const h = await startHarness('s3cret');
    const c = connect(h);
    await c.opened;
    c.client.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
    expect(await c.closed).toEqual({ code: 4401, reason: 'Invalid token' });
    expect(c.messages).toEqual([]); // no init leaked
  });

  it('non-auth first message -> close 4401 "Not authenticated"', async () => {
    const h = await startHarness('s3cret');
    const c = connect(h);
    await c.opened;
    c.client.send(JSON.stringify({ type: 'status' }));
    expect(await c.closed).toEqual({ code: 4401, reason: 'Not authenticated' });
  });

  it('no message for 5s -> close 4401 "Auth timeout" (fake timers)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = await startHarness('s3cret');
    const c = connect(h);
    await c.opened;

    // Just before the deadline nothing happens.
    vi.advanceTimersByTime(4999);
    await flushIo();
    expect(c.closeInfo.settled).toBe(false);

    vi.advanceTimersByTime(1);
    expect(await c.closed).toEqual({ code: 4401, reason: 'Auth timeout' });
  });

  it('SECURITY: pre-auth client receives no broadcasts, post-auth does', async () => {
    const h = await startHarness('s3cret');
    const preAuth = connect(h);
    await preAuth.opened; // connected, never authenticates

    const authed = connect(h);
    await authed.opened;
    const initPromise = messageAt(authed, 0);
    authed.client.send(JSON.stringify({ type: 'auth', token: 's3cret' }));
    await initPromise;

    const msgPromise = messageAt(authed, 1);
    h.wsMod.broadcast('nowPlaying', { title: 'secret state' });
    expect(await msgPromise).toEqual({ type: 'nowPlaying', data: { title: 'secret state' } });

    await realDelay(50); // generous window for any (incorrect) delivery
    expect(preAuth.messages).toEqual([]);
    expect(preAuth.closeInfo.settled).toBe(false); // still connected, just filtered
  });
});

// ---------------------------------------------------------------------------
// setupTlsWs — dual-server broadcast patch
// ---------------------------------------------------------------------------
describe('setupTlsWs', () => {
  it('patches broadcast to fan out to clients of BOTH servers', async () => {
    const h = await startHarness(undefined, { hello: 'init' }, { authDisabled: true });
    const second = await attachSecondServer(h);

    const a = connect(h); // primary server
    await a.opened;
    await messageAt(a, 0); // init
    const b = connect(h, second.port); // second server
    await b.opened;
    await messageAt(b, 0); // init (setupTlsWs auto-auths without token too)

    const pa = messageAt(a, 1);
    const pb = messageAt(b, 1);
    h.wsMod.broadcast('tick', { n: 3 });
    expect(await pa).toEqual({ type: 'tick', data: { n: 3 } });
    expect(await pb).toEqual({ type: 'tick', data: { n: 3 } });
  });

  it('second-server clients go through the same auth state machine', async () => {
    const h = await startHarness('s3cret');
    const second = await attachSecondServer(h);

    const bad = connect(h, second.port);
    await bad.opened;
    bad.client.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
    expect(await bad.closed).toEqual({ code: 4401, reason: 'Invalid token' });

    const intruder = connect(h, second.port);
    await intruder.opened;
    intruder.client.send(JSON.stringify({ type: 'status' }));
    expect(await intruder.closed).toEqual({ code: 4401, reason: 'Not authenticated' });

    const good = connect(h, second.port);
    await good.opened;
    const initPromise = messageAt(good, 0);
    good.client.send(JSON.stringify({ type: 'auth', token: 's3cret' }));
    await initPromise;

    // Patched broadcast still delivers to the authed second-server client.
    const tick = messageAt(good, 1);
    h.wsMod.broadcast('tick', { n: 4 });
    expect(await tick).toEqual({ type: 'tick', data: { n: 4 } });
  });
});
