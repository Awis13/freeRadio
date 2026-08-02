/**
 * tests/dashboard/server.test.js
 *
 * Characterization harness for dashboard/server.js (P1-1).
 * Pins current behavior of the composed app via supertest:
 *   - auth gate (Bearer token, PUBLIC_PATHS exact/prefix semantics)
 *   - empty-token full bypass (pinned as CURRENT behavior, intentional)
 *   - mount order (routes registered before the auth gate)
 *   - /api/health response contract
 *   - getInitState() shape and track/audio aliasing
 *   - security headers (CSP & co.)
 *
 * Mocking strategy: server.js and the dashboard libs are CommonJS and are
 * executed through Node's native require chain, NOT through Vitest's module
 * graph — so vi.mock() factories are silently ignored for requires made
 * INSIDE server.js (verified empirically: a vi.mock'd lib still ran its real
 * code when required by server.js). Instead, this harness pre-seeds
 * require.cache with mock exports before requiring server.js, which reliably
 * intercepts every side-effectful dependency:
 *   - wsServer (creates a real WebSocketServer at setupWs time)
 *   - streamControl / restreamSettings (write/read /shared at import time)
 *   - liveMode / visualMode (state getters pulled into getInitState)
 *   - boot + the six poller factories (created at import time)
 *   - voice / overlay / fileManager / schedule router factories
 *     (mkdir on /shared, /music, /visuals at factory-call time)
 * Everything else (status, settings, live, sso, streamKeys, queue, playlist,
 * tier, mixing, dj, history, ... routers) mounts for real — better pins.
 *
 * server.listen + TLS are skipped via the NODE_ENV !== 'test' guard added
 * in server.js for this harness.
 *
 * Harness fidelity: the root devDependencies pin express/express-rate-limit to
 * the SAME version ranges as dashboard/package.json (the production deps), so
 * these pins run against the express major that actually ships. Keep them in
 * sync when bumping either side.
 *
 * require.cache hygiene: seeded entries are minimal Module stubs (no children/
 * paths/parent fields) — enough for require() resolution but not for anything
 * that walks the module graph. Correctness relies on vitest per-file isolation:
 * no other test file shares this process's require.cache. An afterAll below
 * removes the seeded entries anyway. Caveat: loadServer() re-seeds fresh mock
 * objects each call and server.js (cache-deleted) picks them up, but routers
 * required by the FIRST load stay cached and keep referencing the FIRST seed's
 * mocks — so the `mocks` return value is only authoritative for the first load.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import { serverAgent } from './helpers/serverAgent.js';

const nodeRequire = createRequire(import.meta.url);

// ─── require.cache seeding ──────────────────────────────────────────────────

const seededIds = new Set();

function seed(spec, exportsObj) {
  const id = nodeRequire.resolve(spec);
  nodeRequire.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
  seededIds.add(id);
  return exportsObj;
}

const inertPoller = () => ({ start: vi.fn(), stop: vi.fn() });
const passthroughRouter = () => (req, res, next) => next();

// Captured BEFORE any seeding so every re-seed spreads the REAL module, not a
// previous mock. tierLimits has no import-time side effects (fs only).
const realTierLimits = nodeRequire('../../dashboard/lib/tierLimits');

/** Installs fresh mock exports for every side-effectful dependency. */
function seedMocks() {
  return {
    wsServer: seed('../../dashboard/lib/wsServer', {
      setupWs: vi.fn(() => ({ clients: new Set() })),
      setupTlsWs: vi.fn(),
      broadcast: vi.fn()
    }),
    streamControl: seed('../../dashboard/lib/streamControl', {
      getControlState: vi.fn(() => ({ streaming: true, broadcast: false, timestamp: 0 })),
      setControlState: vi.fn((streaming, broadcast) => ({ streaming, broadcast: !!broadcast })),
      getModeState: vi.fn(() => ({ mode: 'mock-standby' })),
      setModeState: vi.fn()
    }),
    restreamSettings: seed('../../dashboard/lib/restreamSettings', {
      getSettings: vi.fn(() => ({ autoStart: false })),
      setAutoStart: vi.fn()
    }),
    liveMode: seed('../../dashboard/lib/liveMode', {
      getLiveMode: vi.fn(() => ({ mode: 'mock-radio', ingestKey: 'mock-ingest-key' })),
      setLiveMode: vi.fn(),
      setObsStatus: vi.fn(() => ({ mode: 'mock-radio', obsStatus: 'disconnected' })),
      regenerateIngestKey: vi.fn()
    }),
    visualMode: seed('../../dashboard/lib/visualMode', {
      getVisualMode: vi.fn(() => 'mock-visual-mode'),
      setVisualMode: vi.fn()
    }),
    boot: seed('../../dashboard/lib/boot', {
      boot: vi.fn(() => Promise.resolve()),
      setBootAborted: vi.fn(),
      isBootAborted: vi.fn(() => false)
    }),
    icecast: seed('../../dashboard/lib/icecast', { createIcecastPoller: vi.fn(inertPoller) }),
    track: seed('../../dashboard/lib/track', { createTrackPoller: vi.fn(inertPoller) }),
    video: seed('../../dashboard/lib/video', { createVideoPoller: vi.fn(inertPoller) }),
    ffmpeg: seed('../../dashboard/lib/ffmpeg', { createFfmpegPoller: vi.fn(inertPoller) }),
    bpmMap: seed('../../dashboard/lib/bpmMap', { createBpmMapPoller: vi.fn(inertPoller) }),
    rtmpHealth: seed('../../dashboard/lib/rtmpHealth', { createRtmpHealthPoller: vi.fn(inertPoller) }),
    // module.exports of voice/fileManager is the factory function itself
    voice: seed('../../dashboard/lib/voice', vi.fn(passthroughRouter)),
    fileManager: seed('../../dashboard/lib/fileManager', vi.fn(passthroughRouter)),
    overlay: seed('../../dashboard/lib/overlay', {
      createOverlayRouter: vi.fn(passthroughRouter),
      loadOverlays: vi.fn(() => ({ overlays: [] })),
      generateFilterString: vi.fn()
    }),
    schedule: seed('../../dashboard/lib/schedule', {
      createScheduleRouter: vi.fn(passthroughRouter),
      startExecutor: vi.fn(),
      onTrackChange: vi.fn(),
      getCurrentSlot: vi.fn(() => null)
    }),
    // Hermetic tier: /api/tier calls tierLimits.getTier(), which reads the
    // REAL /shared/tier.json — on hosts where that file exists the pin would
    // flip. Stub getTier to a fixed 'free'; getLimits and the rest stay real,
    // so the limits assertion still pins the real monetization matrix.
    tierLimits: seed('../../dashboard/lib/tierLimits', {
      ...realTierLimits,
      getTier: vi.fn(() => 'free')
    })
  };
}

// ─── Server loader ──────────────────────────────────────────────────────────

const TOKEN = 'test-secret-token';

const ORIGINAL_TOKEN = process.env.DASHBOARD_TOKEN;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterAll(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.DASHBOARD_TOKEN;
  else process.env.DASHBOARD_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  // Drop the seeded stubs (and the server itself) from require.cache so
  // nothing in this process can pick up a mock after the suite is done.
  for (const id of seededIds) delete nodeRequire.cache[id];
  seededIds.clear();
  delete nodeRequire.cache[nodeRequire.resolve('../../dashboard/server.js')];
});

/**
 * Loads a fresh copy of server.js with DASHBOARD_TOKEN set to `token`
 * (empty string = auth disabled). Returns { app, server, state, getInitState, mocks }.
 */
function loadServer(token) {
  const mocks = seedMocks();
  process.env.NODE_ENV = 'test';
  process.env.DASHBOARD_TOKEN = token;
  const serverPath = nodeRequire.resolve('../../dashboard/server.js');
  delete nodeRequire.cache[serverPath];
  const mod = nodeRequire(serverPath);
  return { ...mod, mocks };
}

// ─── NODE_ENV guard ─────────────────────────────────────────────────────────

describe('test-mode guard', () => {
  it('vitest runs with NODE_ENV=test and server.js does not listen', () => {
    // vitest sets NODE_ENV=test by default; loadServer also sets it explicitly.
    // Pin both so the listen guard is provably active.
    const { server } = loadServer(TOKEN);
    expect(process.env.NODE_ENV).toBe('test');
    expect(server.listening).toBe(false);
  });
});

// ─── Auth gate with DASHBOARD_TOKEN set ─────────────────────────────────────

describe('auth gate (DASHBOARD_TOKEN set)', () => {
  let app;
  let client;
  let closeServer;

  beforeAll(async () => {
    ({ app } = loadServer(TOKEN));
    ({ client, close: closeServer } = await serverAgent(app));
  });

  afterAll(async () => {
    await closeServer();
  });

  it('rejects a protected /api route without a token: 401 {error:"Unauthorized"}', async () => {
    const res = await client.get('/api/protected-probe');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('rejects a protected /api route with a wrong Bearer token: 401', async () => {
    const res = await client
      .get('/api/protected-probe')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('rejects a malformed Authorization header (token without Bearer prefix): 401', async () => {
    const res = await client
      .get('/api/protected-probe')
      .set('Authorization', TOKEN);
    expect(res.status).toBe(401);
  });

  it('lets a correct Bearer token through the gate (404 from routers, not 401)', async () => {
    const res = await client
      .get('/api/protected-probe')
      .set('Authorization', 'Bearer ' + TOKEN);
    expect(res.status).toBe(404);
  });

  // Every PUBLIC_PATHS entry must pass the gate with no Authorization header.
  // Methods are chosen to avoid side-effectful handlers (e.g. GET /api/audio-stream
  // spawns ffmpeg; POST /api/auth/verify itself returns 401 for a bad body —
  // both would muddy the gate pin). The pin is "gate passes" = anything but 401.
  const publicPathProbes = [
    ['GET', '/api/status', 200],
    ['GET', '/api/health', 200],
    ['POST', '/api/audio-stream', 404],
    ['GET', '/api/rtmp-health', 200],
    ['GET', '/api/live/on_publish', 404],
    ['GET', '/api/live/on_done', 404],
    ['GET', '/api/auth/verify', 404],
    ['GET', '/api/tier', 200]
  ];

  it.each(publicPathProbes)(
    'public path passes the gate without a token: %s %s -> %i',
    async (method, path, expectedStatus) => {
      const res = await client[method.toLowerCase()](path);
      expect(res.status).not.toBe(401);
      expect(res.status).toBe(expectedStatus);
    }
  );

  it('prefix semantics: /api/status/anything is public (startsWith match)', async () => {
    const res = await client.get('/api/status/anything');
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404); // no such route, but gate passed
  });

  it('prefix semantics: /api/statusx is NOT public (no slash boundary match)', async () => {
    const res = await client.get('/api/statusx');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });
});

// ─── Auth bypass with empty DASHBOARD_TOKEN ─────────────────────────────────

describe('auth gate (DASHBOARD_TOKEN empty)', () => {
  it('PUBLIC_PATHS membership is exactly this list', () => {
    // SECURITY-RELEVANT LIST. Everything named here answers WITHOUT a token, in
    // every auth posture including the closed one. Adding an entry is a
    // deliberate decision to expose that surface to anyone who can reach the
    // port — a scope probe added '/api/playlists' and the whole playlist CRUD
    // became public with the suite still fully green. If this assertion fails,
    // the fix is not to update the list here; it is to be sure the addition was
    // meant.
    const { PUBLIC_PATHS } = loadServer('secret');
    expect(PUBLIC_PATHS).toEqual([
      '/api/status',
      '/api/health',
      '/api/audio-stream',
      '/api/rtmp-health',
      '/api/live/on_publish',
      '/api/live/on_done',
      '/api/auth/verify',
      '/api/tier',
    ]);
  });

  it('sensitive routes are NOT reachable without a token', () => {
    // The list above is only meaningful if it is the one the gate consults, and
    // only safe while these stay off it.
    const { PUBLIC_PATHS } = loadServer('secret');
    for (const guarded of ['/api/playlists', '/api/tracks', '/api/queue',
      '/api/stream-keys', '/api/settings', '/api/video-playlists', '/api/overlays']) {
      expect(PUBLIC_PATHS).not.toContain(guarded);
      expect(PUBLIC_PATHS.some(p => guarded === p || guarded.startsWith(p + '/'))).toBe(false);
    }
  });

  it('empty token DENIES protected routes when auth was not explicitly disabled', async () => {
    // CHANGED IN T11-C2. This used to be a full bypass — no token meant the
    // gate returned next() for everything, so a deployment that forgot to set
    // DASHBOARD_TOKEN served its whole API to anyone who could reach it.
    delete process.env.AUTH_DISABLED;
    const { app } = loadServer('');
    const { client, close } = await serverAgent(app);
    try {
      const res = await client.get('/api/protected-probe');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Auth is not configured' });
    } finally {
      await close();
    }
  });

  it('AUTH_DISABLED=true restores the open behaviour, deliberately', async () => {
    process.env.AUTH_DISABLED = 'true';
    try {
      const { app } = loadServer('');
      const { client, close } = await serverAgent(app);
      try {
        const res = await client.get('/api/protected-probe');
        expect(res.status).not.toBe(401);
        expect(res.status).toBe(404); // fell through all routers, gate let it by
      } finally {
        await close();
      }
    } finally {
      delete process.env.AUTH_DISABLED;
    }
  });

  it('public paths stay reachable even when auth is unconfigured', async () => {
    // A closed gate must not make the health probe unreachable — an
    // orchestrator has to be able to see the container is alive.
    delete process.env.AUTH_DISABLED;
    const { app } = loadServer('');
    const { client, close } = await serverAgent(app);
    try {
      expect((await client.get('/api/health')).status).toBe(200);
    } finally {
      await close();
    }
  });
});

// ─── Mount order: routes registered before the auth gate ────────────────────

describe('mount order (token set, no Authorization header)', () => {
  let app;
  let client;
  let closeServer;

  beforeAll(async () => {
    ({ app } = loadServer(TOKEN));
    ({ client, close: closeServer } = await serverAgent(app));
  });

  afterAll(async () => {
    await closeServer();
  });

  it('/auth/sso is mounted before the gate: reachable, responds 400 for missing token param', async () => {
    const res = await client.get('/auth/sso');
    expect(res.status).toBe(400);
    expect(res.text).toContain('Missing token parameter');
  });

  it('/api/health responds 200 without a token', async () => {
    const res = await client.get('/api/health');
    expect(res.status).toBe(200);
  });

  it('/api/tier responds 200 without a token and reports the free tier defaults', async () => {
    // Tier is pinned to 'free' by the seeded tierLimits.getTier stub (hermetic:
    // the real /shared/tier.json on the host cannot influence this); the limits
    // body still comes from the real getLimits matrix.
    const res = await client.get('/api/tier');
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('free');
    expect(res.body.limits).toEqual({
      maxQuality: 'medium', maxPlatforms: 1, watermark: true, dsp: false, customOverlays: false
    });
  });
});

// ─── app-level body parsing and error handling ──────────────────────────────
//
// The routers no longer carry a per-route express.json() (T16-C2 removed 18 of
// them). That is only safe because the app mounts one before every router, so
// these pin the app-level middleware directly: without them the dedup could be
// undone by a single deletion in server.js with nothing going red.

describe('app-level body middleware', () => {
  let app;
  let client;
  let closeServer;

  beforeAll(async () => {
    ({ app } = loadServer(TOKEN));
    ({ client, close: closeServer } = await serverAgent(app));
  });

  afterAll(async () => {
    await closeServer();
  });

  it('parses a JSON body for a router that has no express.json() of its own', async () => {
    // POST /api/mixing/config destructures req.body before it does anything
    // else. Parsed, an empty object reaches the mode check and gets the 400;
    // unparsed, req.body is undefined and the destructure throws a 500. The
    // route is chosen because the validation arm touches neither liquidsoap
    // nor the filesystem.
    const res = await client
      .post('/api/mixing/config')
      .set('Authorization', 'Bearer ' + TOKEN)
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid mode');
  });

  it('mounts the upload error handler LAST, after every router', () => {
    // Position, not just presence: an Express error handler only sees errors
    // thrown by middleware registered BEFORE it, so moving this above the
    // routers makes it silently inert while every test that only checks "a 400
    // comes back for malformed JSON" keeps passing (body parsing sits above the
    // routers too). Arity 4 is how Express itself identifies an error handler.
    const stack = (app._router && app._router.stack) || (app.router && app.router.stack) || [];
    const errorLayers = stack
      .map((layer, index) => ({ index, arity: layer.handle.length }))
      .filter((entry) => entry.arity === 4);

    expect(errorLayers).toHaveLength(1);
    expect(errorLayers[0].index).toBe(stack.length - 1);
  });

  it('answers malformed JSON with a 400, not Express default 500', async () => {
    const res = await client
      .post('/api/mixing/config')
      .set('Authorization', 'Bearer ' + TOKEN)
      .set('Content-Type', 'application/json')
      .send('{"mode": ');

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});

// ─── /api/health contract ───────────────────────────────────────────────────

describe('/api/health contract', () => {
  let app;
  let state;
  let client;
  let closeServer;

  beforeAll(async () => {
    ({ app, state } = loadServer(TOKEN));
    ({ client, close: closeServer } = await serverAgent(app));
  });

  afterAll(async () => {
    await closeServer();
  });

  it('returns the exact shape {status, listeners, uptime, stream_active}', async () => {
    const res = await client.get('/api/health');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['listeners', 'status', 'stream_active', 'uptime']);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.listeners).toBe('number');
    expect(Number.isInteger(res.body.uptime)).toBe(true);
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    expect(typeof res.body.stream_active).toBe('boolean');
  });

  it('stream_active is false when ffmpeg speed is "0x"', async () => {
    state.ffmpeg = { speed: '0x' };
    const res = await client.get('/api/health');
    expect(res.body.stream_active).toBe(false);
  });

  it('stream_active is false when ffmpeg state is an empty object', async () => {
    state.ffmpeg = {};
    const res = await client.get('/api/health');
    expect(res.body.stream_active).toBe(false);
  });

  it('stream_active is true when ffmpeg speed is "1.01x"', async () => {
    state.ffmpeg = { speed: '1.01x' };
    const res = await client.get('/api/health');
    expect(res.body.stream_active).toBe(true);
  });

  it('listeners falls back to 0 when icecast state is missing', async () => {
    state.icecast = null;
    const res = await client.get('/api/health');
    expect(res.body.listeners).toBe(0);
  });

  it('listeners reflects icecast state when present', async () => {
    state.icecast = { listeners: 42, bitrate: 128, serverStart: '' };
    const res = await client.get('/api/health');
    expect(res.body.listeners).toBe(42);
  });
});

// ─── getInitState() shape ───────────────────────────────────────────────────

describe('getInitState()', () => {
  let state;
  let getInitState;

  beforeAll(() => {
    ({ state, getInitState } = loadServer(TOKEN));
  });

  it('returns the pinned key set', () => {
    expect(Object.keys(getInitState()).sort()).toEqual([
      'audio', 'bpm', 'ffmpeg', 'icecast', 'liveMode', 'outputMode',
      'rtmpHealth', 'streamControl', 'streamMode', 'track', 'video', 'visualMode'
    ]);
  });

  it('aliases track to the audio state (same object reference)', () => {
    state.audio = { title: 'Some Track', filename: 'some_track.mp3' };
    const init = getInitState();
    expect(init.track).toBe(state.audio);
    expect(init.track).toEqual({ title: 'Some Track', filename: 'some_track.mp3' });
  });

  it('pulls liveMode/streamControl/streamMode/visualMode from the lib getters', () => {
    const init = getInitState();
    expect(init.liveMode).toEqual({ mode: 'mock-radio', ingestKey: 'mock-ingest-key' });
    expect(init.streamControl).toEqual({ streaming: true, broadcast: false, timestamp: 0 });
    expect(init.streamMode).toEqual({ mode: 'mock-standby' });
    expect(init.visualMode).toBe('mock-visual-mode');
  });

  it('reflects live state mutations (spread happens per call, not cached)', () => {
    state.rtmpHealth = { youtube: 'ok' };
    expect(getInitState().rtmpHealth).toEqual({ youtube: 'ok' });
  });
});

// ─── Security headers ───────────────────────────────────────────────────────

describe('security headers', () => {
  let app;
  let client;
  let closeServer;

  beforeAll(async () => {
    ({ app } = loadServer(TOKEN));
    ({ client, close: closeServer } = await serverAgent(app));
  });

  afterAll(async () => {
    await closeServer();
  });

  it('sets the exact CSP and hardening headers on a plain GET', async () => {
    const res = await client.get('/');
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; " +
      "worker-src 'self' blob:; font-src 'self'"
    );
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('sets the same headers on API responses (middleware runs before routers)', async () => {
    const res = await client.get('/api/health');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});
