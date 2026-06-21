/**
 * tests/dashboard/videoPlaylistRouter.test.js
 *
 * Characterization tests for the video-playlist router (P2-1). Pins the CURRENT
 * behavior of createVideoPlaylistRouter AS-IS (bugs and quirks included) before
 * any future refactor — videoPlaylist.js lines 91-267, previously 0% covered.
 *
 * Scope (every router endpoint):
 *   - GET    /api/video-playlists                  — list with per-playlist trackCount
 *   - POST   /api/video-playlists                  — create manual / smart
 *   - GET    /api/video-playlists/:id              — details with resolvedTracks
 *   - PUT    /api/video-playlists/:id              — partial update + type guards
 *   - DELETE /api/video-playlists/:id              — delete + active-profile cleanup
 *   - POST   /api/video-playlists/:id/reorder      — splice-move a manual track
 *   - POST   /api/video-playlists/:id/load-queue   — write queue + setVisualMode('video-playlist')
 *   - POST   /api/video-playlists/:id/activate-profile — write active profile + setVisualMode('visual-radio')
 *
 * The pure resolve/CRUD-data functions are pinned separately in
 * videoPlaylist.test.js and are NOT re-covered here.
 *
 * fs strategy: see videoPlaylistHarness.js. The REAL router is mounted via
 * supertest; the in-memory harness backs PLAYLIST_FILE / QUEUE_FILE /
 * ACTIVE_FILE / the metadata file / the `.processed` listing, and spies on the
 * visualMode singleton's setVisualMode (lazily required inside the handlers).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

import {
  installVideoPlaylistFsHarness,
  QUEUE_FILE,
  ACTIVE_FILE,
} from './videoPlaylistHarness.js';

let h;
let makeApp;
let seed;
let savedPlaylists;

beforeEach(() => {
  vi.restoreAllMocks();
  h = installVideoPlaylistFsHarness();
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
    seed({});
    const res = await request(makeApp()).get('/api/video-playlists');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('manual trackCount = number of tracks whose file EXISTS in .processed', async () => {
    h.setProcessedFiles(['a.mp4', 'c.mp4']); // b.mp4 missing on disk
    seed({
      vpl_1: { id: 'vpl_1', name: 'Manual', type: 'manual', tracks: ['a.mp4', 'b.mp4', 'c.mp4'] }
    });

    const res = await request(makeApp()).get('/api/video-playlists');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    // AS-IS: the missing b.mp4 is excluded from the count (2, not 3).
    expect(res.body[0].trackCount).toBe(2);
    expect(res.body[0].id).toBe('vpl_1');
  });

  it('AS-IS: the count field is named trackCount (not videoCount)', async () => {
    h.setProcessedFiles(['a.mp4']);
    seed({ vpl_1: { id: 'vpl_1', name: 'M', type: 'manual', tracks: ['a.mp4'] } });

    const res = await request(makeApp()).get('/api/video-playlists');
    expect('trackCount' in res.body[0]).toBe(true);
    expect('videoCount' in res.body[0]).toBe(false);
  });

  it('smart trackCount = resolveSmartVideoPlaylist(...).length over .processed', async () => {
    h.setProcessedFiles(['x.mp4', 'y.mov']);
    seed({ vpl_s: { id: 'vpl_s', name: 'Smart', type: 'smart', rules: {} } });

    const res = await request(makeApp()).get('/api/video-playlists');
    expect(res.body[0].trackCount).toBe(2);
  });

  it('smart trackCount honours a namePattern rule', async () => {
    h.setProcessedFiles(['cyber_1.mp4', 'cyber_2.mp4', 'nature.mp4']);
    seed({ vpl_s: { id: 'vpl_s', name: 'Cyber', type: 'smart', rules: { namePattern: '^cyber_' } } });

    const res = await request(makeApp()).get('/api/video-playlists');
    expect(res.body[0].trackCount).toBe(2);
  });

  it('AS-IS: GET / COUNTS a path-separator track that GET /:id resolve DROPS', async () => {
    // GET / counts via existsSync(basename(t)) with NO `safe === t` guard, so
    // 'sub/x.mp4' (basename 'x.mp4' exists on disk) is counted. resolveVideoPlaylist
    // (used by GET /:id) requires basename(t) === t, so it drops 'sub/x.mp4'. This
    // divergence between the two count paths is pinned as-is; a future refactor
    // should reconcile them intentionally.
    h.setProcessedFiles(['x.mp4']);
    seed({
      vpl_d: { id: 'vpl_d', name: 'Div', type: 'manual', tracks: ['x.mp4', 'sub/x.mp4'] }
    });

    const list = await request(makeApp()).get('/api/video-playlists');
    // GET / counts BOTH: bare 'x.mp4' and 'sub/x.mp4' (latter via unguarded basename).
    expect(list.body[0].trackCount).toBe(2);

    const detail = await request(makeApp()).get('/api/video-playlists/vpl_d');
    // GET /:id resolve DROPS 'sub/x.mp4' (basename !== t) — only bare 'x.mp4' survives.
    expect(detail.body.resolvedTracks).toEqual(['x.mp4']);
    expect(detail.body.trackCount).toBe(1);
  });

  it('lists multiple playlists, each carrying its own trackCount', async () => {
    h.setProcessedFiles(['a.mp4', 'b.mp4']);
    seed({
      vpl_1: { id: 'vpl_1', name: 'M', type: 'manual', tracks: ['a.mp4'] },
      vpl_2: { id: 'vpl_2', name: 'S', type: 'smart', rules: {} }
    });

    const res = await request(makeApp()).get('/api/video-playlists');
    const byId = Object.fromEntries(res.body.map(p => [p.id, p]));
    expect(byId.vpl_1.trackCount).toBe(1);
    expect(byId.vpl_2.trackCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// POST / — create
// ---------------------------------------------------------------------------
describe('POST / — create', () => {
  beforeEach(() => seed({}));

  it('returns 400 { error: "name required" } when name is absent', async () => {
    const res = await request(makeApp()).post('/api/video-playlists').send({ type: 'manual' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'name required' });
  });

  it('defaults type to "manual", basenames tracks + drops falsy entries', async () => {
    const res = await request(makeApp())
      .post('/api/video-playlists')
      .send({ name: 'New', tracks: ['/visuals/a.mp4', 'sub/dir/b.mov', ''] });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('manual');
    expect(res.body.id).toMatch(/^vpl_\d+$/);
    // Paths basenamed; the '' entry basenames to '' and is filtered out.
    expect(res.body.tracks).toEqual(['a.mp4', 'b.mov']);
    expect(typeof res.body.createdAt).toBe('number');
    expect(typeof res.body.updatedAt).toBe('number');
  });

  it('non-array tracks on a manual playlist become [] (AS-IS)', async () => {
    const res = await request(makeApp())
      .post('/api/video-playlists')
      .send({ name: 'NoTracks', tracks: 'not-an-array' });
    expect(res.body.tracks).toEqual([]);
  });

  it('manual playlist with tracks omitted gets tracks: []', async () => {
    const res = await request(makeApp())
      .post('/api/video-playlists')
      .send({ name: 'Empty' });
    expect(res.body.tracks).toEqual([]);
  });

  it('smart playlist stores rules and has NO tracks key', async () => {
    const res = await request(makeApp())
      .post('/api/video-playlists')
      .send({ name: 'Smart', type: 'smart', rules: { namePattern: 'cyber' } });

    expect(res.body.type).toBe('smart');
    expect(res.body.rules).toEqual({ namePattern: 'cyber' });
    expect('tracks' in res.body).toBe(false);
  });

  it('smart playlist with rules omitted defaults rules to {}', async () => {
    const res = await request(makeApp())
      .post('/api/video-playlists')
      .send({ name: 'Smart', type: 'smart' });
    expect(res.body.rules).toEqual({});
  });

  it('AS-IS: an unknown type stores neither tracks nor rules', async () => {
    const res = await request(makeApp())
      .post('/api/video-playlists')
      .send({ name: 'Weird', type: 'bogus' });
    expect(res.body.type).toBe('bogus');
    expect('tracks' in res.body).toBe(false);
    expect('rules' in res.body).toBe(false);
  });

  it('persists the created playlist via saveVideoPlaylists', async () => {
    const res = await request(makeApp())
      .post('/api/video-playlists')
      .send({ name: 'Persisted', tracks: ['a.mp4'] });

    const saved = savedPlaylists();
    expect(saved[res.body.id]).toBeDefined();
    expect(saved[res.body.id].name).toBe('Persisted');
    expect(saved[res.body.id].tracks).toEqual(['a.mp4']);
  });
});

// ---------------------------------------------------------------------------
// GET /:id — details with resolved tracks
// ---------------------------------------------------------------------------
describe('GET /:id — details', () => {
  it('returns 404 { error: "not found" } for an unknown id', async () => {
    seed({});
    const res = await request(makeApp()).get('/api/video-playlists/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('returns playlist spread with resolvedTracks + trackCount (manual)', async () => {
    h.setProcessedFiles(['a.mp4', 'c.mp4']); // b.mp4 missing
    seed({
      vpl_1: { id: 'vpl_1', name: 'M', type: 'manual', tracks: ['a.mp4', 'b.mp4', 'c.mp4'] }
    });

    const res = await request(makeApp()).get('/api/video-playlists/vpl_1');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('M');
    // resolveVideoPlaylist drops the missing b.mp4.
    expect(res.body.resolvedTracks).toEqual(['a.mp4', 'c.mp4']);
    expect(res.body.trackCount).toBe(2);
  });

  it('AS-IS: manual tracks containing a path separator are rejected (basename !== t)', async () => {
    h.setProcessedFiles(['x.mp4']);
    seed({
      vpl_p: { id: 'vpl_p', name: 'P', type: 'manual', tracks: ['sub/x.mp4', 'x.mp4'] }
    });

    const res = await request(makeApp()).get('/api/video-playlists/vpl_p');
    // 'sub/x.mp4' has basename 'x.mp4' !== 'sub/x.mp4' → dropped; bare 'x.mp4' kept.
    expect(res.body.resolvedTracks).toEqual(['x.mp4']);
  });

  it('resolves a smart playlist via the .processed listing', async () => {
    h.setProcessedFiles(['k1.mp4', 'k2.mov']);
    seed({ vpl_s: { id: 'vpl_s', name: 'S', type: 'smart', rules: {} } });

    const res = await request(makeApp()).get('/api/video-playlists/vpl_s');
    expect(res.body.resolvedTracks).toEqual(['k1.mp4', 'k2.mov']);
    expect(res.body.trackCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PUT /:id — partial update
// ---------------------------------------------------------------------------
describe('PUT /:id — update', () => {
  it('returns 404 for an unknown id', async () => {
    seed({});
    const res = await request(makeApp()).put('/api/video-playlists/nope').send({ name: 'X' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('updates name only and bumps updatedAt', async () => {
    seed({
      vpl_1: { id: 'vpl_1', name: 'Old', type: 'manual', tracks: ['a.mp4'], updatedAt: 1 }
    });

    const res = await request(makeApp()).put('/api/video-playlists/vpl_1').send({ name: 'New' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New');
    expect(res.body.tracks).toEqual(['a.mp4']); // untouched
    expect(res.body.updatedAt).toBeGreaterThan(1);
  });

  it('updating tracks on a MANUAL playlist basenames + filters them', async () => {
    seed({
      vpl_1: { id: 'vpl_1', name: 'M', type: 'manual', tracks: ['a.mp4'], updatedAt: 1 }
    });

    const res = await request(makeApp())
      .put('/api/video-playlists/vpl_1')
      .send({ tracks: ['/x/new1.mp4', '', 'new2.mov'] });

    expect(res.body.tracks).toEqual(['new1.mp4', 'new2.mov']);
  });

  it('AS-IS: updating tracks on a SMART playlist is IGNORED (type guard)', async () => {
    seed({
      vpl_s: { id: 'vpl_s', name: 'S', type: 'smart', rules: { namePattern: 'x' }, updatedAt: 1 }
    });

    const res = await request(makeApp())
      .put('/api/video-playlists/vpl_s')
      .send({ tracks: ['injected.mp4'] });

    expect(res.status).toBe(200);
    // The manual-only guard skips it — no tracks key gets added.
    expect('tracks' in res.body).toBe(false);
    expect(res.body.rules).toEqual({ namePattern: 'x' });
  });

  it('updating rules on a SMART playlist replaces them', async () => {
    seed({
      vpl_s: { id: 'vpl_s', name: 'S', type: 'smart', rules: { namePattern: 'a' }, updatedAt: 1 }
    });

    const res = await request(makeApp())
      .put('/api/video-playlists/vpl_s')
      .send({ rules: { namePattern: 'b' } });

    expect(res.body.rules).toEqual({ namePattern: 'b' });
  });

  it('AS-IS: updating rules on a MANUAL playlist is IGNORED (type guard)', async () => {
    seed({
      vpl_1: { id: 'vpl_1', name: 'M', type: 'manual', tracks: ['a.mp4'], updatedAt: 1 }
    });

    const res = await request(makeApp())
      .put('/api/video-playlists/vpl_1')
      .send({ rules: { namePattern: 'z' } });

    expect(res.status).toBe(200);
    // The smart-only guard skips it — no rules key gets added.
    expect('rules' in res.body).toBe(false);
    expect(res.body.tracks).toEqual(['a.mp4']);
  });

  it('persists the update via saveVideoPlaylists', async () => {
    seed({
      vpl_1: { id: 'vpl_1', name: 'Old', type: 'manual', tracks: [], updatedAt: 1 }
    });

    await request(makeApp()).put('/api/video-playlists/vpl_1').send({ name: 'Saved' });
    expect(savedPlaylists().vpl_1.name).toBe('Saved');
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id
// ---------------------------------------------------------------------------
describe('DELETE /:id', () => {
  it('returns 404 for an unknown id', async () => {
    seed({});
    const res = await request(makeApp()).delete('/api/video-playlists/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('deletes the playlist, returns { ok: true }, persists removal', async () => {
    seed({
      vpl_1: { id: 'vpl_1', name: 'M', type: 'manual', tracks: [] },
      vpl_2: { id: 'vpl_2', name: 'N', type: 'manual', tracks: [] }
    });

    const res = await request(makeApp()).delete('/api/video-playlists/vpl_1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const saved = savedPlaylists();
    expect(saved.vpl_1).toBeUndefined();
    expect(saved.vpl_2).toBeDefined();
  });

  it('removes the ACTIVE_FILE when the deleted playlist was the active profile', async () => {
    seed({ vpl_1: { id: 'vpl_1', name: 'M', type: 'manual', tracks: [] } });
    h.files[ACTIVE_FILE] = JSON.stringify({ id: 'vpl_1', name: 'M', videos: [] });

    const res = await request(makeApp()).delete('/api/video-playlists/vpl_1');
    expect(res.status).toBe(200);
    expect(ACTIVE_FILE in h.files).toBe(false);
  });

  it('leaves the ACTIVE_FILE intact when a DIFFERENT playlist is active', async () => {
    seed({
      vpl_1: { id: 'vpl_1', name: 'M', type: 'manual', tracks: [] },
      vpl_2: { id: 'vpl_2', name: 'N', type: 'manual', tracks: [] }
    });
    h.files[ACTIVE_FILE] = JSON.stringify({ id: 'vpl_2', name: 'N', videos: [] });

    await request(makeApp()).delete('/api/video-playlists/vpl_1');
    expect(ACTIVE_FILE in h.files).toBe(true);
  });

  it('AS-IS: a corrupt ACTIVE_FILE is swallowed and the delete still succeeds', async () => {
    seed({ vpl_1: { id: 'vpl_1', name: 'M', type: 'manual', tracks: [] } });
    h.files[ACTIVE_FILE] = 'not json{{{';

    const res = await request(makeApp()).delete('/api/video-playlists/vpl_1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Corrupt file is NOT touched (parse threw before the id check / unlink).
    expect(h.files[ACTIVE_FILE]).toBe('not json{{{');
    expect(savedPlaylists().vpl_1).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /:id/reorder
// ---------------------------------------------------------------------------
describe('POST /:id/reorder', () => {
  it('returns 404 for an unknown id', async () => {
    seed({});
    const res = await request(makeApp())
      .post('/api/video-playlists/nope/reorder')
      .send({ from: 0, to: 1 });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('returns 400 { error: "only manual playlists" } for a smart playlist', async () => {
    seed({ vpl_s: { id: 'vpl_s', name: 'S', type: 'smart', rules: {} } });

    const res = await request(makeApp())
      .post('/api/video-playlists/vpl_s/reorder')
      .send({ from: 0, to: 1 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'only manual playlists' });
  });

  it('returns 400 when from/to are not numbers', async () => {
    seed({ vpl_1: { id: 'vpl_1', name: 'M', type: 'manual', tracks: ['a', 'b'] } });

    const res = await request(makeApp())
      .post('/api/video-playlists/vpl_1/reorder')
      .send({ from: 'a', to: 1 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'from and to must be numbers' });
  });

  it('AS-IS: a NUMERIC STRING ("0") is rejected by the typeof check', async () => {
    seed({ vpl_1: { id: 'vpl_1', name: 'M', type: 'manual', tracks: ['a', 'b', 'c'] } });

    const res = await request(makeApp())
      .post('/api/video-playlists/vpl_1/reorder')
      .send({ from: '0', to: '1' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'from and to must be numbers' });
  });

  it('returns 400 { error: "index out of range" } when from is out of range', async () => {
    seed({ vpl_1: { id: 'vpl_1', name: 'M', type: 'manual', tracks: ['a', 'b'] } });

    const res = await request(makeApp())
      .post('/api/video-playlists/vpl_1/reorder')
      .send({ from: 5, to: 0 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'index out of range' });
  });

  it('returns 400 index out of range when to is negative', async () => {
    seed({ vpl_1: { id: 'vpl_1', name: 'M', type: 'manual', tracks: ['a', 'b'] } });

    const res = await request(makeApp())
      .post('/api/video-playlists/vpl_1/reorder')
      .send({ from: 0, to: -1 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'index out of range' });
  });

  it('splice-moves a track from idx 0 to idx 2 and persists the new order', async () => {
    seed({
      vpl_1: { id: 'vpl_1', name: 'M', type: 'manual', tracks: ['a', 'b', 'c', 'd'], updatedAt: 1 }
    });

    const res = await request(makeApp())
      .post('/api/video-playlists/vpl_1/reorder')
      .send({ from: 0, to: 2 });

    expect(res.status).toBe(200);
    // Remove 'a' from front, insert at index 2: b, c, a, d.
    expect(res.body.tracks).toEqual(['b', 'c', 'a', 'd']);
    expect(res.body.updatedAt).toBeGreaterThan(1);
    expect(savedPlaylists().vpl_1.tracks).toEqual(['b', 'c', 'a', 'd']);
  });
});

// ---------------------------------------------------------------------------
// POST /:id/load-queue
// ---------------------------------------------------------------------------
describe('POST /:id/load-queue', () => {
  it('returns 404 for an unknown id', async () => {
    seed({});
    const res = await request(makeApp()).post('/api/video-playlists/nope/load-queue');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('returns 400 { error: "playlist resolves to 0 videos" } when nothing resolves', async () => {
    h.setProcessedFiles([]); // no files on disk → manual tracks all filtered out
    seed({ vpl_e: { id: 'vpl_e', name: 'E', type: 'manual', tracks: ['a.mp4'] } });

    const res = await request(makeApp()).post('/api/video-playlists/vpl_e/load-queue');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'playlist resolves to 0 videos' });
    // No queue written and visualMode not switched on the failure path.
    expect(QUEUE_FILE in h.files).toBe(false);
    expect(h.setVisualModeSpy).not.toHaveBeenCalled();
  });

  it('writes the queue file, switches visualMode, returns the resolved videos', async () => {
    h.setProcessedFiles(['v1.mp4', 'v2.mp4']);
    seed({ vpl_1: { id: 'vpl_1', name: 'M', type: 'manual', tracks: ['v1.mp4', 'v2.mp4'] } });

    const res = await request(makeApp()).post('/api/video-playlists/vpl_1/load-queue');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, loaded: 2, videos: ['v1.mp4', 'v2.mp4'] });

    // File: sanitized basenames, newline-joined with a trailing newline.
    expect(h.files[QUEUE_FILE]).toBe('v1.mp4\nv2.mp4\n');
    // visualMode switched to 'video-playlist' (lazy-required singleton).
    expect(h.setVisualModeSpy).toHaveBeenCalledTimes(1);
    expect(h.setVisualModeSpy).toHaveBeenCalledWith('video-playlist');
  });

  it('writes atomically via QUEUE_FILE+".tmp" then rename (no .tmp left behind)', async () => {
    h.setProcessedFiles(['v1.mp4']);
    seed({ vpl_1: { id: 'vpl_1', name: 'M', type: 'manual', tracks: ['v1.mp4'] } });

    await request(makeApp()).post('/api/video-playlists/vpl_1/load-queue');
    expect(h.files[QUEUE_FILE]).toBe('v1.mp4\n');
    expect((QUEUE_FILE + '.tmp') in h.files).toBe(false);
  });

  it('AS-IS: response `videos` is the resolved list; the FILE holds basename()ed names', async () => {
    // resolveVideoPlaylist only ever yields bare basenames (manual rejects path
    // separators, smart lists .processed filenames), so the basename() applied
    // before writing the file is a no-op here: file names == response names. We
    // pin both, and pin that they carry the SAME names while differing in shape
    // (newline-joined string in the file vs JSON array in the response).
    h.setProcessedFiles(['clip_a.mov', 'clip_b.mkv']);
    seed({
      vpl_s: { id: 'vpl_s', name: 'S', type: 'smart', rules: { namePattern: '^clip_' } }
    });

    const res = await request(makeApp()).post('/api/video-playlists/vpl_s/load-queue');
    const fileNames = h.files[QUEUE_FILE].trimEnd().split('\n');
    expect(res.body.videos).toEqual(['clip_a.mov', 'clip_b.mkv']);
    expect(fileNames).toEqual(['clip_a.mov', 'clip_b.mkv']);
    expect(fileNames).toEqual(res.body.videos);
  });
});

// ---------------------------------------------------------------------------
// POST /:id/activate-profile
// ---------------------------------------------------------------------------
describe('POST /:id/activate-profile', () => {
  it('returns 404 for an unknown id', async () => {
    seed({});
    const res = await request(makeApp()).post('/api/video-playlists/nope/activate-profile');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('returns 400 { error: "playlist resolves to 0 videos" } when nothing resolves', async () => {
    h.setProcessedFiles([]);
    seed({ vpl_e: { id: 'vpl_e', name: 'E', type: 'manual', tracks: ['a.mp4'] } });

    const res = await request(makeApp()).post('/api/video-playlists/vpl_e/activate-profile');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'playlist resolves to 0 videos' });
    expect(ACTIVE_FILE in h.files).toBe(false);
    expect(h.setVisualModeSpy).not.toHaveBeenCalled();
  });

  it('writes the active profile, switches visualMode, returns the summary', async () => {
    const before = Date.now();
    h.setProcessedFiles(['v1.mp4', 'v2.mp4', 'v3.mp4']);
    seed({ vpl_1: { id: 'vpl_1', name: 'Cyber', type: 'manual', tracks: ['v1.mp4', 'v2.mp4', 'v3.mp4'] } });

    const res = await request(makeApp()).post('/api/video-playlists/vpl_1/activate-profile');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ activated: true, videoCount: 3, mode: 'visual-radio' });

    const written = JSON.parse(h.files[ACTIVE_FILE]);
    expect(written.id).toBe('vpl_1');
    expect(written.name).toBe('Cyber');
    // videos are the sanitized basenames of the resolved list.
    expect(written.videos).toEqual(['v1.mp4', 'v2.mp4', 'v3.mp4']);
    // activatedAt is a timestamp — assert numeric & sane, never an exact value.
    expect(typeof written.activatedAt).toBe('number');
    expect(written.activatedAt).toBeGreaterThanOrEqual(before);

    expect(h.setVisualModeSpy).toHaveBeenCalledTimes(1);
    expect(h.setVisualModeSpy).toHaveBeenCalledWith('visual-radio');
  });

  it('resolves + activates a SMART playlist over the .processed listing', async () => {
    h.setProcessedFiles(['cyber_1.mp4', 'cyber_2.mp4', 'nature.mp4']);
    seed({ vpl_s: { id: 'vpl_s', name: 'Cyber', type: 'smart', rules: { namePattern: '^cyber_' } } });

    const res = await request(makeApp()).post('/api/video-playlists/vpl_s/activate-profile');
    expect(res.status).toBe(200);
    expect(res.body.videoCount).toBe(2);
    expect(JSON.parse(h.files[ACTIVE_FILE]).videos).toEqual(['cyber_1.mp4', 'cyber_2.mp4']);
  });
});
