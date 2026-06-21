/**
 * tests/dashboard/playlistRouter.test.js
 *
 * Characterization tests for the playlist CRUD + reorder router endpoints (P1-9).
 * Pins CURRENT behavior AS-IS (bugs and quirks included) before any future refactor.
 *
 * Scope (the endpoints P1-8 explicitly deferred):
 *   - GET    /api/playlists           — list with per-playlist trackCount
 *   - POST   /api/playlists           — create manual / smart
 *   - GET    /api/playlists/:id        — details with resolvedTracks
 *   - PUT    /api/playlists/:id        — partial update
 *   - DELETE /api/playlists/:id        — delete
 *   - POST   /api/playlists/:id/reorder — splice-move a manual track
 *
 * /import + parseM3U are pinned separately in playlistImport.test.js (P1-8) and
 * are NOT re-covered here.
 *
 * Why a SEPARATE file from playlist.test.js: that file mocks express.Router with
 * a stub, so the real router never runs there. Here we mount the REAL router via
 * supertest, mirroring playlistImport.test.js. We must NOT mock express/multer.
 *
 * fs strategy: playlist.js is CommonJS required through Node's native require
 * chain, sharing this process's `fs` instance — so vi.spyOn(fs, ...) intercepts
 * loadPlaylists/savePlaylists/existsSync/readdirSync inside the endpoint. We back
 * PLAYLIST_FILE and the musicDir existence/listing with the shared in-memory fs
 * harness (installPlaylistFsHarness), which delegates unowned paths to the real
 * fs so body-parser's lazy require() at request time does not blow up.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

import { installPlaylistFsHarness } from './playlistHarness.js';

let h;
let makeApp;
let seed;
let savedPlaylists;

beforeEach(() => {
  vi.restoreAllMocks();
  h = installPlaylistFsHarness();
  ({ makeApp, seed, savedPlaylists } = h);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// GET / — list with trackCount
// ---------------------------------------------------------------------------
describe('GET / — list', () => {
  it('returns [] when there are no playlists', async () => {
    const res = await request(makeApp()).get('/api/playlists');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('manual trackCount = number of tracks whose file EXISTS in musicDir', async () => {
    h.setMusicFiles(['a.mp3', 'c.mp3']); // b.mp3 missing on disk
    seed({
      pl_1: { id: 'pl_1', name: 'Manual', type: 'manual', tracks: ['a.mp3', 'b.mp3', 'c.mp3'] }
    });

    const res = await request(makeApp()).get('/api/playlists');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    // AS-IS: b.mp3 has no file → excluded from the count (2, not 3).
    expect(res.body[0].trackCount).toBe(2);
    expect(res.body[0].id).toBe('pl_1');
  });

  it('smart trackCount = resolveSmartPlaylist(...).length over musicDir listing', async () => {
    // Two audio files in musicDir; smart playlist has no rules → all match.
    h.setMusicFiles(['x.mp3', 'y.flac']);
    seed({
      pl_smart: { id: 'pl_smart', name: 'Smart', type: 'smart', rules: {} }
    });

    const res = await request(makeApp()).get('/api/playlists');
    expect(res.body[0].trackCount).toBe(2);
  });

  it('smart trackCount honours a namePattern rule', async () => {
    h.setMusicFiles(['rock_1.mp3', 'rock_2.mp3', 'jazz_1.mp3']);
    seed({
      pl_smart: { id: 'pl_smart', name: 'Rock', type: 'smart', rules: { namePattern: '^rock_' } }
    });

    const res = await request(makeApp()).get('/api/playlists');
    expect(res.body[0].trackCount).toBe(2);
  });

  it('lists multiple playlists, each carrying its own trackCount', async () => {
    h.setMusicFiles(['a.mp3', 'b.mp3']);
    seed({
      pl_1: { id: 'pl_1', name: 'M', type: 'manual', tracks: ['a.mp3'] },
      pl_2: { id: 'pl_2', name: 'S', type: 'smart', rules: {} }
    });

    const res = await request(makeApp()).get('/api/playlists');
    const byId = Object.fromEntries(res.body.map(p => [p.id, p]));
    expect(byId.pl_1.trackCount).toBe(1);
    expect(byId.pl_2.trackCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// POST / — create
// ---------------------------------------------------------------------------
describe('POST / — create', () => {
  it('returns 400 { error: "name required" } when name is absent', async () => {
    const res = await request(makeApp()).post('/api/playlists').send({ type: 'manual' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'name required' });
  });

  it('defaults type to "manual" and basenames + drops falsy tracks', async () => {
    const res = await request(makeApp())
      .post('/api/playlists')
      .send({ name: 'New', tracks: ['/music/a.mp3', 'sub/dir/b.flac', ''] });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('manual');
    expect(res.body.id).toMatch(/^pl_\d+$/);
    // Paths basenamed; the '' entry basenames to '' and is filtered out.
    expect(res.body.tracks).toEqual(['a.mp3', 'b.flac']);
    expect(typeof res.body.createdAt).toBe('number');
    expect(typeof res.body.updatedAt).toBe('number');
  });

  it('non-array tracks on a manual playlist become [] (AS-IS)', async () => {
    const res = await request(makeApp())
      .post('/api/playlists')
      .send({ name: 'NoTracks', tracks: 'not-an-array' });
    expect(res.body.tracks).toEqual([]);
  });

  it('manual playlist with tracks omitted gets tracks: []', async () => {
    const res = await request(makeApp())
      .post('/api/playlists')
      .send({ name: 'Empty' });
    expect(res.body.tracks).toEqual([]);
  });

  it('smart playlist stores rules and has NO tracks key', async () => {
    const res = await request(makeApp())
      .post('/api/playlists')
      .send({ name: 'Smart', type: 'smart', rules: { bpmMin: 120 } });

    expect(res.body.type).toBe('smart');
    expect(res.body.rules).toEqual({ bpmMin: 120 });
    expect('tracks' in res.body).toBe(false);
  });

  it('smart playlist with rules omitted defaults rules to {}', async () => {
    const res = await request(makeApp())
      .post('/api/playlists')
      .send({ name: 'Smart', type: 'smart' });
    expect(res.body.rules).toEqual({});
  });

  it('persists the created playlist via savePlaylists', async () => {
    const res = await request(makeApp())
      .post('/api/playlists')
      .send({ name: 'Persisted', tracks: ['a.mp3'] });

    const saved = savedPlaylists();
    expect(saved[res.body.id]).toBeDefined();
    expect(saved[res.body.id].name).toBe('Persisted');
    expect(saved[res.body.id].tracks).toEqual(['a.mp3']);
  });
});

// ---------------------------------------------------------------------------
// GET /:id — details with resolved tracks
// ---------------------------------------------------------------------------
describe('GET /:id — details', () => {
  it('returns 404 { error: "not found" } for an unknown id', async () => {
    const res = await request(makeApp()).get('/api/playlists/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('returns playlist spread with resolvedTracks + trackCount (manual)', async () => {
    h.setMusicFiles(['a.mp3', 'c.mp3']); // b.mp3 missing
    seed({
      pl_1: { id: 'pl_1', name: 'M', type: 'manual', tracks: ['a.mp3', 'b.mp3', 'c.mp3'] }
    });

    const res = await request(makeApp()).get('/api/playlists/pl_1');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('M');
    // resolvePlaylist drops the missing b.mp3.
    expect(res.body.resolvedTracks).toEqual(['a.mp3', 'c.mp3']);
    expect(res.body.trackCount).toBe(2);
  });

  it('resolves a smart playlist via the musicDir listing', async () => {
    h.setMusicFiles(['k1.mp3', 'k2.mp3']);
    seed({
      pl_s: { id: 'pl_s', name: 'S', type: 'smart', rules: {} }
    });

    const res = await request(makeApp()).get('/api/playlists/pl_s');
    expect(res.body.resolvedTracks).toEqual(['k1.mp3', 'k2.mp3']);
    expect(res.body.trackCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PUT /:id — partial update
// ---------------------------------------------------------------------------
describe('PUT /:id — update', () => {
  it('returns 404 for an unknown id', async () => {
    const res = await request(makeApp()).put('/api/playlists/nope').send({ name: 'X' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('updates name only and bumps updatedAt', async () => {
    seed({
      pl_1: { id: 'pl_1', name: 'Old', type: 'manual', tracks: ['a.mp3'], updatedAt: 1 }
    });

    const res = await request(makeApp()).put('/api/playlists/pl_1').send({ name: 'New' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New');
    expect(res.body.tracks).toEqual(['a.mp3']); // untouched
    expect(res.body.updatedAt).toBeGreaterThan(1);
  });

  it('updating tracks on a MANUAL playlist basenames + filters them', async () => {
    seed({
      pl_1: { id: 'pl_1', name: 'M', type: 'manual', tracks: ['a.mp3'], updatedAt: 1 }
    });

    const res = await request(makeApp())
      .put('/api/playlists/pl_1')
      .send({ tracks: ['/x/new1.mp3', '', 'new2.flac'] });

    expect(res.body.tracks).toEqual(['new1.mp3', 'new2.flac']);
  });

  it('AS-IS: updating tracks on a SMART playlist is IGNORED (type guard)', async () => {
    seed({
      pl_s: { id: 'pl_s', name: 'S', type: 'smart', rules: { bpmMin: 100 }, updatedAt: 1 }
    });

    const res = await request(makeApp())
      .put('/api/playlists/pl_s')
      .send({ tracks: ['injected.mp3'] });

    expect(res.status).toBe(200);
    // No tracks key gets added — the manual-only guard skips it.
    expect('tracks' in res.body).toBe(false);
    expect(res.body.rules).toEqual({ bpmMin: 100 });
  });

  it('updating rules on a SMART playlist replaces them', async () => {
    seed({
      pl_s: { id: 'pl_s', name: 'S', type: 'smart', rules: { bpmMin: 100 }, updatedAt: 1 }
    });

    const res = await request(makeApp())
      .put('/api/playlists/pl_s')
      .send({ rules: { bpmMax: 90 } });

    expect(res.body.rules).toEqual({ bpmMax: 90 });
  });

  it('AS-IS: updating rules on a MANUAL playlist is IGNORED (type guard)', async () => {
    seed({
      pl_1: { id: 'pl_1', name: 'M', type: 'manual', tracks: ['a.mp3'], updatedAt: 1 }
    });

    const res = await request(makeApp())
      .put('/api/playlists/pl_1')
      .send({ rules: { bpmMin: 50 } });

    expect(res.status).toBe(200);
    // No rules key gets added — the smart-only guard skips it.
    expect('rules' in res.body).toBe(false);
    expect(res.body.tracks).toEqual(['a.mp3']);
  });

  it('persists the update via savePlaylists', async () => {
    seed({
      pl_1: { id: 'pl_1', name: 'Old', type: 'manual', tracks: [], updatedAt: 1 }
    });

    await request(makeApp()).put('/api/playlists/pl_1').send({ name: 'Saved' });
    expect(savedPlaylists().pl_1.name).toBe('Saved');
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id
// ---------------------------------------------------------------------------
describe('DELETE /:id', () => {
  it('returns 404 for an unknown id', async () => {
    const res = await request(makeApp()).delete('/api/playlists/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('deletes the playlist, returns { ok: true }, persists removal', async () => {
    seed({
      pl_1: { id: 'pl_1', name: 'M', type: 'manual', tracks: [] },
      pl_2: { id: 'pl_2', name: 'N', type: 'manual', tracks: [] }
    });

    const res = await request(makeApp()).delete('/api/playlists/pl_1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const saved = savedPlaylists();
    expect(saved.pl_1).toBeUndefined();
    expect(saved.pl_2).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST /:id/reorder
// ---------------------------------------------------------------------------
describe('POST /:id/reorder', () => {
  it('returns 404 for an unknown id', async () => {
    const res = await request(makeApp())
      .post('/api/playlists/nope/reorder')
      .send({ from: 0, to: 1 });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('returns 400 { error: "only manual playlists" } for a smart playlist', async () => {
    seed({ pl_s: { id: 'pl_s', name: 'S', type: 'smart', rules: {} } });

    const res = await request(makeApp())
      .post('/api/playlists/pl_s/reorder')
      .send({ from: 0, to: 1 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'only manual playlists' });
  });

  it('returns 400 when from/to are not numbers', async () => {
    seed({ pl_1: { id: 'pl_1', name: 'M', type: 'manual', tracks: ['a', 'b'] } });

    const res = await request(makeApp())
      .post('/api/playlists/pl_1/reorder')
      .send({ from: 'a', to: 1 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'from and to must be numbers' });
  });

  it('AS-IS: a NUMERIC STRING ("1") is rejected by the typeof check', async () => {
    seed({ pl_1: { id: 'pl_1', name: 'M', type: 'manual', tracks: ['a', 'b', 'c'] } });

    const res = await request(makeApp())
      .post('/api/playlists/pl_1/reorder')
      .send({ from: '0', to: '1' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'from and to must be numbers' });
  });

  it('returns 400 { error: "index out of range" } when from is out of range', async () => {
    seed({ pl_1: { id: 'pl_1', name: 'M', type: 'manual', tracks: ['a', 'b'] } });

    const res = await request(makeApp())
      .post('/api/playlists/pl_1/reorder')
      .send({ from: 5, to: 0 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'index out of range' });
  });

  it('returns 400 index out of range when to is negative', async () => {
    seed({ pl_1: { id: 'pl_1', name: 'M', type: 'manual', tracks: ['a', 'b'] } });

    const res = await request(makeApp())
      .post('/api/playlists/pl_1/reorder')
      .send({ from: 0, to: -1 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'index out of range' });
  });

  it('splice-moves a track from idx 0 to idx 2 and persists the new order', async () => {
    seed({
      pl_1: { id: 'pl_1', name: 'M', type: 'manual', tracks: ['a', 'b', 'c', 'd'], updatedAt: 1 }
    });

    const res = await request(makeApp())
      .post('/api/playlists/pl_1/reorder')
      .send({ from: 0, to: 2 });

    expect(res.status).toBe(200);
    // Remove 'a' from front, insert at index 2: b, c, a, d.
    expect(res.body.tracks).toEqual(['b', 'c', 'a', 'd']);
    expect(res.body.updatedAt).toBeGreaterThan(1);
    expect(savedPlaylists().pl_1.tracks).toEqual(['b', 'c', 'a', 'd']);
  });
});
