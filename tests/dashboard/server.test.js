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
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const nodeRequire = createRequire(import.meta.url);

// ─── require.cache seeding ──────────────────────────────────────────────────

function seed(spec, exportsObj) {
  const id = nodeRequire.resolve(spec);
  nodeRequire.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
  return exportsObj;
}

const inertPoller = () => ({ start: vi.fn(), stop: vi.fn() });
const passthroughRouter = () => (req, res, next) => next();

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

  beforeAll(() => {
    ({ app } = loadServer(TOKEN));
  });

  it('rejects a protected /api route without a token: 401 {error:"Unauthorized"}', async () => {
    const res = await request(app).get('/api/protected-probe');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('rejects a protected /api route with a wrong Bearer token: 401', async () => {
    const res = await request(app)
      .get('/api/protected-probe')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('rejects a malformed Authorization header (token without Bearer prefix): 401', async () => {
    const res = await request(app)
      .get('/api/protected-probe')
      .set('Authorization', TOKEN);
    expect(res.status).toBe(401);
  });

  it('lets a correct Bearer token through the gate (404 from routers, not 401)', async () => {
    const res = await request(app)
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
      const res = await request(app)[method.toLowerCase()](path);
      expect(res.status).not.toBe(401);
      expect(res.status).toBe(expectedStatus);
    }
  );

  it('prefix semantics: /api/status/anything is public (startsWith match)', async () => {
    const res = await request(app).get('/api/status/anything');
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404); // no such route, but gate passed
  });

  it('prefix semantics: /api/statusx is NOT public (no slash boundary match)', async () => {
    const res = await request(app).get('/api/statusx');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });
});

// ─── Auth bypass with empty DASHBOARD_TOKEN ─────────────────────────────────

describe('auth gate (DASHBOARD_TOKEN empty)', () => {
  it('CHARACTERIZATION: empty token disables auth entirely — protected routes pass without a token', async () => {
    // This pins the current, intentional behavior: when DASHBOARD_TOKEN is not
    // configured the gate is a full bypass (`if (!DASHBOARD_TOKEN) return next()`).
    const { app } = loadServer('');
    const res = await request(app).get('/api/protected-probe');
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404); // fell through all routers, gate never fired
  });
});

// ─── Mount order: routes registered before the auth gate ────────────────────

describe('mount order (token set, no Authorization header)', () => {
  let app;

  beforeAll(() => {
    ({ app } = loadServer(TOKEN));
  });

  it('/auth/sso is mounted before the gate: reachable, responds 400 for missing token param', async () => {
    const res = await request(app).get('/auth/sso');
    expect(res.status).toBe(400);
    expect(res.text).toContain('Missing token parameter');
  });

  it('/api/health responds 200 without a token', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('/api/tier responds 200 without a token and reports the free tier defaults', async () => {
    const res = await request(app).get('/api/tier');
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('free');
    expect(res.body.limits).toEqual({
      maxQuality: 'medium', maxPlatforms: 1, watermark: true, dsp: false, customOverlays: false
    });
  });
});

// ─── /api/health contract ───────────────────────────────────────────────────

describe('/api/health contract', () => {
  let app;
  let state;

  beforeAll(() => {
    ({ app, state } = loadServer(TOKEN));
  });

  it('returns the exact shape {status, listeners, uptime, stream_active}', async () => {
    const res = await request(app).get('/api/health');
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
    const res = await request(app).get('/api/health');
    expect(res.body.stream_active).toBe(false);
  });

  it('stream_active is false when ffmpeg state is an empty object', async () => {
    state.ffmpeg = {};
    const res = await request(app).get('/api/health');
    expect(res.body.stream_active).toBe(false);
  });

  it('stream_active is true when ffmpeg speed is "1.01x"', async () => {
    state.ffmpeg = { speed: '1.01x' };
    const res = await request(app).get('/api/health');
    expect(res.body.stream_active).toBe(true);
  });

  it('listeners falls back to 0 when icecast state is missing', async () => {
    state.icecast = null;
    const res = await request(app).get('/api/health');
    expect(res.body.listeners).toBe(0);
  });

  it('listeners reflects icecast state when present', async () => {
    state.icecast = { listeners: 42, bitrate: 128, serverStart: '' };
    const res = await request(app).get('/api/health');
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

  beforeAll(() => {
    ({ app } = loadServer(TOKEN));
  });

  it('sets the exact CSP and hardening headers on a plain GET', async () => {
    const res = await request(app).get('/');
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
    const res = await request(app).get('/api/health');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});
