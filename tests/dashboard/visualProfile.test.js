/**
 * tests/dashboard/visualProfile.test.js
 *
 * Characterization of dashboard/lib/visualProfile.js (P1-5).
 *
 * Strategy: vi.mock() is inert for requires made inside CJS modules in
 * this repo (verified here too — the mocked cacheManager factory was
 * ignored), so this file uses the server.test.js technique: pre-seed
 * require.cache with a cacheManager stub, then nodeRequire visualProfile
 * so its require('./cacheManager') resolves to the stub. fs is the node
 * builtin singleton -> mockFsMap from helpers.js gives an in-memory
 * /shared, plus an unlinkSync spy for deactivation.
 *
 * Pinned here (current behavior, callers depend on it):
 *   - CRUD happy paths, 400 on missing name, 404s;
 *   - SECURITY: every video list entering storage is reduced to
 *     path.basename (POST, PUT, activateProfile) — path traversal like
 *     '../../../etc/passwd' is stored as 'passwd', never as a path;
 *   - GET /:id existingVideos roundtrip check rejects entries where
 *     basename(v) !== v even if the target file exists;
 *   - ACTIVE_FILE external contract (the streamer script reads this file):
 *     exactly {id, name, videos, activatedAt} JSON, rewritten by PUT on the
 *     active profile, removed by DELETE of the active profile and by
 *     POST /deactivate;
 *   - activate triggers cacheManager.prefetchVideos with the SANITIZED list
 *     in the background; a prefetch rejection never fails the route.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import { mockFsMap, mockRes, getRouteHandler } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
const CACHE_SPEC = '../../dashboard/lib/cacheManager';
const VP_SPEC = '../../dashboard/lib/visualProfile';

const prefetchVideosMock = vi.fn();

// Pre-seed require.cache: visualProfile's require('./cacheManager') resolves
// to this stub (minimal Module stub, same convention as server.test.js).
const cacheId = nodeRequire.resolve(CACHE_SPEC);
nodeRequire.cache[cacheId] = {
  id: cacheId, filename: cacheId, loaded: true,
  exports: { prefetchVideos: prefetchVideosMock }
};

delete nodeRequire.cache[nodeRequire.resolve(VP_SPEC)];
const { createVisualProfileRouter, getActiveProfile, activateProfile } =
  nodeRequire(VP_SPEC);

afterAll(() => {
  delete nodeRequire.cache[cacheId];
  delete nodeRequire.cache[nodeRequire.resolve(VP_SPEC)];
});

const PROFILES_FILE = '/shared/visual_profiles.json';
const ACTIVE_FILE = '/shared/active_visual_profile.json';
const VISUALS_DIR = '/visuals';

let files;

beforeEach(() => {
  vi.restoreAllMocks();
  prefetchVideosMock.mockReset();
  prefetchVideosMock.mockResolvedValue(undefined);
  ({ files } = mockFsMap());
  vi.spyOn(fs, 'unlinkSync').mockImplementation((p) => { delete files[p]; });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function seedProfiles(profiles) {
  files[PROFILES_FILE] = JSON.stringify({ profiles });
}

function storedProfiles() {
  return JSON.parse(files[PROFILES_FILE]).profiles;
}

function router() {
  return createVisualProfileRouter(VISUALS_DIR);
}

function call(method, routePath, req = {}) {
  const handler = getRouteHandler(router(), method, routePath);
  const res = mockRes();
  handler({ params: {}, body: {}, ...req }, res);
  return res;
}

const PROFILE_A = {
  id: 'vp_1', name: 'Chill', videos: ['a.mp4', 'b.mp4'],
  createdAt: 1000, updatedAt: 1000
};

// ---------------------------------------------------------------------------
// GET /
// ---------------------------------------------------------------------------
describe('GET /', () => {
  it('returns empty list and null activeId with no state files', () => {
    const res = call('get', '/');
    expect(res.body).toEqual({ profiles: [], activeId: null });
  });

  it('lists profiles with videoCount and isActive flags', () => {
    seedProfiles({ vp_1: PROFILE_A, vp_2: { ...PROFILE_A, id: 'vp_2', name: 'Dark', videos: [] } });
    files[ACTIVE_FILE] = JSON.stringify({ id: 'vp_1', name: 'Chill', videos: ['a.mp4'], activatedAt: 5 });
    const res = call('get', '/');
    expect(res.body.activeId).toBe('vp_1');
    const byId = Object.fromEntries(res.body.profiles.map((p) => [p.id, p]));
    expect(byId.vp_1.videoCount).toBe(2);
    expect(byId.vp_1.isActive).toBe(true);
    expect(byId.vp_2.videoCount).toBe(0);
    expect(byId.vp_2.isActive).toBe(false);
  });

  it('treats corrupt profiles file as empty', () => {
    files[PROFILES_FILE] = 'not json{{{';
    const res = call('get', '/');
    expect(res.body).toEqual({ profiles: [], activeId: null });
  });
});

// ---------------------------------------------------------------------------
// POST / — create
// ---------------------------------------------------------------------------
describe('POST /', () => {
  it('400 without name', () => {
    const res = call('post', '/', { body: { videos: ['a.mp4'] } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'name required' });
  });

  it('creates a profile and persists it', () => {
    const res = call('post', '/', { body: { name: 'New', videos: ['a.mp4'] } });
    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe('New');
    expect(res.body.id).toMatch(/^vp_\d+$/);
    expect(res.body.createdAt).toBe(res.body.updatedAt);
    expect(storedProfiles()[res.body.id]).toEqual(res.body);
  });

  it('SECURITY: stores only basenames — path traversal is neutralized', () => {
    const res = call('post', '/', {
      body: { name: 'Evil', videos: ['../../../etc/passwd', 'sub/dir/file.mp4', 'ok.mp4'] }
    });
    expect(res.body.videos).toEqual(['passwd', 'file.mp4', 'ok.mp4']);
    expect(storedProfiles()[res.body.id].videos).toEqual(['passwd', 'file.mp4', 'ok.mp4']);
  });

  it('non-array videos becomes empty list', () => {
    const res = call('post', '/', { body: { name: 'NoVids', videos: 'a.mp4' } });
    expect(res.body.videos).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /:id
// ---------------------------------------------------------------------------
describe('GET /:id', () => {
  it('404 for unknown id', () => {
    const res = call('get', '/:id', { params: { id: 'vp_nope' } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('returns profile with existingVideos filtered to files on disk', () => {
    seedProfiles({ vp_1: { ...PROFILE_A, videos: ['a.mp4', 'missing.mp4'] } });
    files['/visuals/a.mp4'] = 'x';
    const res = call('get', '/:id', { params: { id: 'vp_1' } });
    expect(res.body.existingVideos).toEqual(['a.mp4']);
    // Pin: with no active profile the flag is null (active && ...), not false.
    expect(res.body.isActive).toBeNull();
  });

  it('SECURITY: roundtrip check rejects entries where basename(v) !== v even if the file exists', () => {
    seedProfiles({ vp_1: { ...PROFILE_A, videos: ['../evil.mp4', 'ok.mp4'] } });
    files['/visuals/evil.mp4'] = 'x'; // basename target exists on disk
    files['/visuals/ok.mp4'] = 'x';
    const res = call('get', '/:id', { params: { id: 'vp_1' } });
    expect(res.body.existingVideos).toEqual(['ok.mp4']);
  });

  it('marks isActive when the active file points at this profile', () => {
    seedProfiles({ vp_1: PROFILE_A });
    files[ACTIVE_FILE] = JSON.stringify({ id: 'vp_1', name: 'Chill', videos: [], activatedAt: 5 });
    const res = call('get', '/:id', { params: { id: 'vp_1' } });
    expect(res.body.isActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PUT /:id
// ---------------------------------------------------------------------------
describe('PUT /:id', () => {
  it('404 for unknown id', () => {
    const res = call('put', '/:id', { params: { id: 'vp_nope' }, body: { name: 'X' } });
    expect(res.statusCode).toBe(404);
  });

  it('updates name and bumps updatedAt, keeping videos untouched', () => {
    seedProfiles({ vp_1: PROFILE_A });
    const res = call('put', '/:id', { params: { id: 'vp_1' }, body: { name: 'Renamed' } });
    expect(res.body.name).toBe('Renamed');
    expect(res.body.videos).toEqual(['a.mp4', 'b.mp4']);
    expect(res.body.updatedAt).toBeGreaterThan(1000);
    expect(storedProfiles().vp_1.name).toBe('Renamed');
  });

  it('SECURITY: sanitizes videos to basenames on update', () => {
    seedProfiles({ vp_1: PROFILE_A });
    const res = call('put', '/:id', {
      params: { id: 'vp_1' },
      body: { videos: ['../../../etc/passwd', 'sub/dir/file.mp4', 'ok.mp4'] }
    });
    expect(res.body.videos).toEqual(['passwd', 'file.mp4', 'ok.mp4']);
    expect(storedProfiles().vp_1.videos).toEqual(['passwd', 'file.mp4', 'ok.mp4']);
  });

  it('rewrites ACTIVE_FILE when the updated profile is the active one', () => {
    seedProfiles({ vp_1: PROFILE_A });
    files[ACTIVE_FILE] = JSON.stringify({ id: 'vp_1', name: 'Chill', videos: ['a.mp4', 'b.mp4'], activatedAt: 5 });
    call('put', '/:id', { params: { id: 'vp_1' }, body: { videos: ['new.mp4'] } });
    const active = JSON.parse(files[ACTIVE_FILE]);
    expect(active.videos).toEqual(['new.mp4']);
    expect(active.activatedAt).toBeGreaterThan(5);
  });

  it('does not touch ACTIVE_FILE when a different profile is active', () => {
    seedProfiles({ vp_1: PROFILE_A, vp_2: { ...PROFILE_A, id: 'vp_2' } });
    const before = JSON.stringify({ id: 'vp_2', name: 'Chill', videos: [], activatedAt: 5 });
    files[ACTIVE_FILE] = before;
    call('put', '/:id', { params: { id: 'vp_1' }, body: { videos: ['new.mp4'] } });
    expect(files[ACTIVE_FILE]).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id
// ---------------------------------------------------------------------------
describe('DELETE /:id', () => {
  it('404 for unknown id', () => {
    const res = call('delete', '/:id', { params: { id: 'vp_nope' } });
    expect(res.statusCode).toBe(404);
  });

  it('deletes the profile from storage', () => {
    seedProfiles({ vp_1: PROFILE_A, vp_2: { ...PROFILE_A, id: 'vp_2' } });
    const res = call('delete', '/:id', { params: { id: 'vp_1' } });
    expect(res.body).toEqual({ ok: true });
    expect(storedProfiles()).not.toHaveProperty('vp_1');
    expect(storedProfiles()).toHaveProperty('vp_2');
  });

  it('removes ACTIVE_FILE when deleting the active profile', () => {
    seedProfiles({ vp_1: PROFILE_A });
    files[ACTIVE_FILE] = JSON.stringify({ id: 'vp_1', name: 'Chill', videos: [], activatedAt: 5 });
    call('delete', '/:id', { params: { id: 'vp_1' } });
    expect(ACTIVE_FILE in files).toBe(false);
  });

  it('keeps ACTIVE_FILE when deleting a non-active profile', () => {
    seedProfiles({ vp_1: PROFILE_A, vp_2: { ...PROFILE_A, id: 'vp_2' } });
    files[ACTIVE_FILE] = JSON.stringify({ id: 'vp_2', name: 'Chill', videos: [], activatedAt: 5 });
    call('delete', '/:id', { params: { id: 'vp_1' } });
    expect(ACTIVE_FILE in files).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /:id/activate — ACTIVE_FILE external contract + prefetch
// ---------------------------------------------------------------------------
describe('POST /:id/activate', () => {
  it('404 for unknown id', () => {
    const res = call('post', '/:id/activate', { params: { id: 'vp_nope' } });
    expect(res.statusCode).toBe(404);
    expect(prefetchVideosMock).not.toHaveBeenCalled();
  });

  it('writes ACTIVE_FILE with the exact external contract shape {id, name, videos, activatedAt}', () => {
    seedProfiles({ vp_1: PROFILE_A });
    const res = call('post', '/:id/activate', { params: { id: 'vp_1' } });
    const active = JSON.parse(files[ACTIVE_FILE]);
    expect(Object.keys(active).sort()).toEqual(['activatedAt', 'id', 'name', 'videos']);
    expect(active.id).toBe('vp_1');
    expect(active.name).toBe('Chill');
    expect(active.videos).toEqual(['a.mp4', 'b.mp4']);
    expect(typeof active.activatedAt).toBe('number');
    expect(res.body).toEqual(active);
  });

  it('SECURITY: activation sanitizes stored traversal paths before writing ACTIVE_FILE', () => {
    seedProfiles({ vp_1: { ...PROFILE_A, videos: ['../../../etc/passwd', 'clip.mp4', ''] } });
    call('post', '/:id/activate', { params: { id: 'vp_1' } });
    expect(JSON.parse(files[ACTIVE_FILE]).videos).toEqual(['passwd', 'clip.mp4']);
  });

  it('triggers background prefetch with the sanitized list and the visuals dir', () => {
    seedProfiles({ vp_1: { ...PROFILE_A, videos: ['sub/clip.mp4', 'ok.mp4'] } });
    call('post', '/:id/activate', { params: { id: 'vp_1' } });
    expect(prefetchVideosMock).toHaveBeenCalledTimes(1);
    expect(prefetchVideosMock).toHaveBeenCalledWith(['clip.mp4', 'ok.mp4'], VISUALS_DIR);
  });

  it('skips prefetch when the profile has no videos', () => {
    seedProfiles({ vp_1: { ...PROFILE_A, videos: [] } });
    const res = call('post', '/:id/activate', { params: { id: 'vp_1' } });
    expect(res.statusCode).toBe(200);
    expect(prefetchVideosMock).not.toHaveBeenCalled();
  });

  it('prefetch rejection is swallowed — route still succeeds', async () => {
    prefetchVideosMock.mockRejectedValueOnce(new Error('s3 down'));
    seedProfiles({ vp_1: PROFILE_A });
    const res = call('post', '/:id/activate', { params: { id: 'vp_1' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe('vp_1');
    await new Promise((r) => setImmediate(r)); // let the background .catch run
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('prefetch profile videos failed: s3 down')
    );
  });
});

// ---------------------------------------------------------------------------
// POST /deactivate
// ---------------------------------------------------------------------------
describe('POST /deactivate', () => {
  it('removes ACTIVE_FILE and returns ok', () => {
    files[ACTIVE_FILE] = JSON.stringify({ id: 'vp_1', name: 'Chill', videos: [], activatedAt: 5 });
    const res = call('post', '/deactivate', {});
    expect(res.body).toEqual({ ok: true });
    expect(ACTIVE_FILE in files).toBe(false);
  });

  it('is a no-op when nothing is active', () => {
    const res = call('post', '/deactivate', {});
    expect(res.body).toEqual({ ok: true });
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------
describe('getActiveProfile / activateProfile exports', () => {
  it('getActiveProfile returns null when ACTIVE_FILE is absent', () => {
    expect(getActiveProfile()).toBeNull();
  });

  it('getActiveProfile returns null on corrupt ACTIVE_FILE', () => {
    files[ACTIVE_FILE] = 'garbage{{{';
    expect(getActiveProfile()).toBeNull();
  });

  it('getActiveProfile parses the active file', () => {
    files[ACTIVE_FILE] = JSON.stringify({ id: 'vp_1', name: 'Chill', videos: ['a.mp4'], activatedAt: 5 });
    expect(getActiveProfile()).toEqual({ id: 'vp_1', name: 'Chill', videos: ['a.mp4'], activatedAt: 5 });
  });

  it('activateProfile returns null for unknown id and writes nothing', () => {
    seedProfiles({});
    expect(activateProfile('vp_nope')).toBeNull();
    expect(ACTIVE_FILE in files).toBe(false);
  });

  it('activateProfile sanitizes videos and returns the active record', () => {
    seedProfiles({ vp_1: { ...PROFILE_A, videos: ['../escape.mp4', 'ok.mp4'] } });
    const active = activateProfile('vp_1');
    expect(active.videos).toEqual(['escape.mp4', 'ok.mp4']);
    expect(JSON.parse(files[ACTIVE_FILE])).toEqual(active);
  });
});
