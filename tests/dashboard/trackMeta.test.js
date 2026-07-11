/**
 * tests/dashboard/trackMeta.test.js
 *
 * Characterization tests for dashboard/lib/trackMeta.js — per-track metadata.
 * Pins CURRENT behavior AS-IS (bugs/quirks included) before any future refactor.
 *
 * Pure helpers: loadMeta, getTrackMeta, setTrackMeta, getAllTags.
 * Router (createTrackRouter) + the internal bulkTag (reached through the
 * POST /bulk-tag handler) are pinned via the REAL express router mounted with
 * supertest — see the "createTrackRouter" describe block.
 *
 * fs strategy: an in-memory `files` map backs META_FILE and the music dir.
 * express is NOT mocked here (the real Router is mounted), so the in-memory
 * fs spies delegate unowned paths to the real fs — body-parser's express.json()
 * lazily require()s modules at request time and must be able to read its own
 * source. statSync/readdirSync are driven from `files` / `musicFiles`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { serverAgent } from './helpers/serverAgent.js';

const META_FILE = '/shared/track_metadata.json';
const MUSIC_DIR = '/music';
let files = {};
// Names "present" in MUSIC_DIR -> stat overrides. Used by readdirSync/statSync
// and by the router's existsSync check for PUT /:filename/meta.
let musicFiles = {};

beforeEach(() => {
  files = {};
  musicFiles = {};
  vi.restoreAllMocks();

  const realExistsSync = fs.existsSync;
  const realReadFileSync = fs.readFileSync;
  const realReaddirSync = fs.readdirSync;

  vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
    if (typeof p === 'string') {
      if (p in files) return true;
      if (p.startsWith(MUSIC_DIR + '/')) {
        return path.basename(p) in musicFiles;
      }
      if (p === MUSIC_DIR) return true;
    }
    return realExistsSync(p);
  });
  vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
    if (typeof p === 'string' && p in files) return files[p];
    if (typeof p === 'string' && p === META_FILE) throw new Error('ENOENT');
    return realReadFileSync(p, ...rest);
  });
  vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
    files[p] = data;
  });
  vi.spyOn(fs, 'statSync').mockImplementation((p) => {
    const base = typeof p === 'string' ? path.basename(p) : '';
    const override = musicFiles[base] || {};
    return { size: override.size != null ? override.size : 1000, mtime: override.mtime || new Date(0) };
  });
  vi.spyOn(fs, 'readdirSync').mockImplementation((dir, ...rest) => {
    if (typeof dir === 'string' && dir === MUSIC_DIR) return Object.keys(musicFiles);
    return realReaddirSync(dir, ...rest);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const { loadMeta, getTrackMeta, setTrackMeta, getAllTags, createTrackRouter } =
  await import('../../dashboard/lib/trackMeta.js');

// bulkTag is NOT in module.exports; it is pinned through POST /bulk-tag below.

// ---------------------------------------------------------------------------
// loadMeta
// ---------------------------------------------------------------------------
describe('loadMeta', () => {
  it('returns empty tracks when no file exists', () => {
    const meta = loadMeta();
    expect(meta.tracks).toEqual({});
  });

  it('reads metadata from file', () => {
    files[META_FILE] = JSON.stringify({
      tracks: { 'test.mp3': { tags: ['hard'], genre: 'techno', custom: {} } }
    });
    const meta = loadMeta();
    expect(meta.tracks['test.mp3'].genre).toBe('techno');
  });

  it('handles corrupt JSON gracefully', () => {
    files[META_FILE] = 'broken{{{';
    const meta = loadMeta();
    expect(meta.tracks).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// getTrackMeta
// ---------------------------------------------------------------------------
describe('getTrackMeta', () => {
  it('returns defaults for unknown track', () => {
    const meta = getTrackMeta('nonexistent.mp3');
    expect(meta.tags).toEqual([]);
    expect(meta.genre).toBe('');
    expect(meta.custom).toEqual({});
  });

  it('returns metadata for known track', () => {
    files[META_FILE] = JSON.stringify({
      tracks: {
        'track.mp3': { tags: ['dark', 'industrial'], genre: 'techno', custom: { bpm: 150 } }
      }
    });
    const meta = getTrackMeta('track.mp3');
    expect(meta.tags).toEqual(['dark', 'industrial']);
    expect(meta.genre).toBe('techno');
    expect(meta.custom.bpm).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// setTrackMeta
// ---------------------------------------------------------------------------
describe('setTrackMeta', () => {
  it('creates metadata for new track', () => {
    const result = setTrackMeta('new.mp3', { tags: ['acid'], genre: 'acid techno' });
    expect(result.tags).toEqual(['acid']);
    expect(result.genre).toBe('acid techno');
    expect(files[META_FILE]).toBeDefined();
  });

  it('preserves existing tags when not specified', () => {
    files[META_FILE] = JSON.stringify({
      tracks: { 'track.mp3': { tags: ['old'], genre: 'techno', custom: {} } }
    });
    const result = setTrackMeta('track.mp3', { genre: 'hard techno' });
    expect(result.tags).toEqual(['old']);
    expect(result.genre).toBe('hard techno');
  });

  it('preserves existing genre when not specified', () => {
    files[META_FILE] = JSON.stringify({
      tracks: { 'track.mp3': { tags: [], genre: 'techno', custom: {} } }
    });
    const result = setTrackMeta('track.mp3', { tags: ['new'] });
    expect(result.genre).toBe('techno');
  });

  it('merges custom fields with existing', () => {
    files[META_FILE] = JSON.stringify({
      tracks: { 'track.mp3': { tags: [], genre: '', custom: { a: 1 } } }
    });
    const result = setTrackMeta('track.mp3', { custom: { b: 2 } });
    expect(result.custom.a).toBe(1);
    expect(result.custom.b).toBe(2);
  });

  it('overwrites custom field values', () => {
    files[META_FILE] = JSON.stringify({
      tracks: { 'track.mp3': { tags: [], genre: '', custom: { a: 1 } } }
    });
    const result = setTrackMeta('track.mp3', { custom: { a: 99 } });
    expect(result.custom.a).toBe(99);
  });

  it('does not affect other tracks', () => {
    files[META_FILE] = JSON.stringify({
      tracks: {
        'a.mp3': { tags: ['x'], genre: 'g', custom: {} },
        'b.mp3': { tags: ['y'], genre: 'h', custom: {} }
      }
    });
    setTrackMeta('a.mp3', { tags: ['z'] });
    const saved = JSON.parse(files[META_FILE]);
    expect(saved.tracks['b.mp3'].tags).toEqual(['y']);
  });
});

// ---------------------------------------------------------------------------
// getAllTags
// ---------------------------------------------------------------------------
describe('getAllTags', () => {
  it('returns empty array when no metadata', () => {
    expect(getAllTags()).toEqual([]);
  });

  it('returns sorted unique tags across all tracks', () => {
    files[META_FILE] = JSON.stringify({
      tracks: {
        'a.mp3': { tags: ['dark', 'acid'] },
        'b.mp3': { tags: ['dark', 'industrial'] },
        'c.mp3': { tags: ['acid'] }
      }
    });
    const tags = getAllTags();
    expect(tags).toEqual(['acid', 'dark', 'industrial']);
  });

  it('handles tracks with no tags field', () => {
    files[META_FILE] = JSON.stringify({
      tracks: {
        'a.mp3': { genre: 'techno' },
        'b.mp3': { tags: ['dark'] }
      }
    });
    const tags = getAllTags();
    expect(tags).toEqual(['dark']);
  });

  it('handles empty tags arrays', () => {
    files[META_FILE] = JSON.stringify({
      tracks: {
        'a.mp3': { tags: [] },
        'b.mp3': { tags: ['solo'] }
      }
    });
    expect(getAllTags()).toEqual(['solo']);
  });
});

// ---------------------------------------------------------------------------
// setTrackMeta — additional AS-IS quirks
// ---------------------------------------------------------------------------
describe('setTrackMeta — quirks', () => {
  it('preserves existing custom when custom not specified (shared reference, not a clone)', () => {
    files[META_FILE] = JSON.stringify({
      tracks: { 'track.mp3': { tags: [], genre: '', custom: { a: 1 } } }
    });
    // meta.custom undefined -> the branch assigns `existing.custom` directly.
    const result = setTrackMeta('track.mp3', { genre: 'g' });
    expect(result.custom).toEqual({ a: 1 });
  });

  it('accepts empty-object meta and rebuilds entry from defaults of a brand-new track', () => {
    // No file, no existing entry: existing defaults to { tags:[], genre:'', custom:{} }.
    const result = setTrackMeta('fresh.mp3', {});
    expect(result).toEqual({ tags: [], genre: '', custom: {} });
    expect(JSON.parse(files[META_FILE]).tracks['fresh.mp3']).toEqual({ tags: [], genre: '', custom: {} });
  });

  it('writes JSON with 2-space indentation (saveMeta pretty-print)', () => {
    setTrackMeta('x.mp3', { tags: ['t'] });
    expect(files[META_FILE]).toBe(JSON.stringify(JSON.parse(files[META_FILE]), null, 2));
    expect(files[META_FILE]).toContain('\n  "tracks"');
  });
});

// ---------------------------------------------------------------------------
// createTrackRouter — REAL express router mounted via supertest.
// Pins the router (lines 64-124) and the internal bulkTag (37-53) AS-IS.
// ---------------------------------------------------------------------------
describe('createTrackRouter', () => {
  let bpmMap;
  let client;
  let closeServer;
  function makeApp() {
    bpmMap = bpmMap || {};
    const app = express();
    app.use('/api/tracks', createTrackRouter(MUSIC_DIR, () => bpmMap));
    return app;
  }

  beforeEach(async () => {
    bpmMap = {};
    ({ client, close: closeServer } = await serverAgent(makeApp()));
  });

  afterEach(async () => {
    await closeServer();
  });

  // ----- GET / -----
  describe('GET /', () => {
    it('returns [] when the music dir is empty', async () => {
      const res = await client.get('/api/tracks');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('filters dotfiles and non-audio extensions, and sorts the rest', async () => {
      musicFiles = {
        'b.mp3': {}, 'a.wav': {}, 'c.txt': {}, '.hidden.mp3': {}, 'd.flac': {},
        'e.ogg': {}, 'f.aac': {}, 'g.m4a': {}, 'h.MP3': {}
      };
      const res = await client.get('/api/tracks');
      const names = res.body.map(t => t.name);
      // .txt dropped, dotfile dropped, uppercase ext kept (regex is /i), sorted.
      expect(names).toEqual(['a.wav', 'b.mp3', 'd.flac', 'e.ogg', 'f.aac', 'g.m4a', 'h.MP3']);
    });

    it('maps size, modified, bpm and metadata defaults for an un-tagged track', async () => {
      musicFiles = { 'song.mp3': { size: 4242, mtime: new Date('2020-01-02T03:04:05.000Z') } };
      const res = await client.get('/api/tracks');
      expect(res.body).toEqual([{
        name: 'song.mp3',
        size: 4242,
        modified: '2020-01-02T03:04:05.000Z',
        bpm: null,
        tags: [],
        genre: '',
        custom: {}
      }]);
    });

    it('uses stored metadata and bpm from the bpm map when present', async () => {
      musicFiles = { 'song.mp3': { size: 10, mtime: new Date(0) } };
      bpmMap = { 'song.mp3': 174 };
      files[META_FILE] = JSON.stringify({
        tracks: { 'song.mp3': { tags: ['dnb'], genre: 'jungle', custom: { key: 'Am' } } }
      });
      const res = await client.get('/api/tracks');
      expect(res.body[0]).toMatchObject({ bpm: 174, tags: ['dnb'], genre: 'jungle', custom: { key: 'Am' } });
    });

    it('returns 500 with the error message when readdir throws', async () => {
      vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('boom'); });
      const res = await client.get('/api/tracks');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'boom' });
    });
  });

  // ----- GET /tags -----
  describe('GET /tags', () => {
    it('returns sorted unique tags across all tracks', async () => {
      files[META_FILE] = JSON.stringify({
        tracks: {
          'a.mp3': { tags: ['z', 'a'] },
          'b.mp3': { tags: ['a', 'm'] }
        }
      });
      const res = await client.get('/api/tracks/tags');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(['a', 'm', 'z']);
    });

    it('returns [] when there is no metadata', async () => {
      const res = await client.get('/api/tracks/tags');
      expect(res.body).toEqual([]);
    });
  });

  // ----- PUT /:filename/meta -----
  describe('PUT /:filename/meta', () => {
    it('returns 404 when the track file does not exist in the music dir', async () => {
      const res = await client
        .put('/api/tracks/ghost.mp3/meta')
        .send({ tags: ['x'] });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'track not found' });
    });

    it('updates metadata and returns the merged entry when the file exists', async () => {
      musicFiles = { 'real.mp3': {} };
      files[META_FILE] = JSON.stringify({
        tracks: { 'real.mp3': { tags: ['old'], genre: 'techno', custom: { a: 1 } } }
      });
      const res = await client
        .put('/api/tracks/real.mp3/meta')
        .send({ tags: ['new'], custom: { b: 2 } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ tags: ['new'], genre: 'techno', custom: { a: 1, b: 2 } });
      // persisted
      expect(JSON.parse(files[META_FILE]).tracks['real.mp3'].tags).toEqual(['new']);
    });
  });

  // ----- POST /bulk-tag (drives internal bulkTag) -----
  describe('POST /bulk-tag', () => {
    it('returns 400 when filenames is not an array', async () => {
      const res = await client
        .post('/api/tracks/bulk-tag')
        .send({ filenames: 'a.mp3', tags: ['x'] });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'filenames and tags must be arrays' });
    });

    it('returns 400 when tags is not an array', async () => {
      const res = await client
        .post('/api/tracks/bulk-tag')
        .send({ filenames: ['a.mp3'], tags: 'x' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'filenames and tags must be arrays' });
    });

    it('adds tags (default action) creating entries for unknown tracks, dedupes via Set', async () => {
      files[META_FILE] = JSON.stringify({
        tracks: { 'a.mp3': { tags: ['existing'], genre: '', custom: {} } }
      });
      const res = await client
        .post('/api/tracks/bulk-tag')
        .send({ filenames: ['a.mp3', 'b.mp3'], tags: ['existing', 'fresh'] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 2 });
      const saved = JSON.parse(files[META_FILE]).tracks;
      // a.mp3 dedupes 'existing', appends 'fresh'; b.mp3 created from defaults
      // then gets BOTH requested tags (Set over the empty starting set).
      expect(saved['a.mp3'].tags).toEqual(['existing', 'fresh']);
      expect(saved['b.mp3']).toEqual({ tags: ['existing', 'fresh'], genre: '', custom: {} });
    });

    it('removes tags when action is "remove", leaving other tags intact', async () => {
      files[META_FILE] = JSON.stringify({
        tracks: { 'a.mp3': { tags: ['keep', 'drop'], genre: '', custom: {} } }
      });
      const res = await client
        .post('/api/tracks/bulk-tag')
        .send({ filenames: ['a.mp3'], tags: ['drop'], action: 'remove' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 1 });
      expect(JSON.parse(files[META_FILE]).tracks['a.mp3'].tags).toEqual(['keep']);
    });

    it('remove on a previously-unknown track creates it then filters (net empty tags)', async () => {
      const res = await client
        .post('/api/tracks/bulk-tag')
        .send({ filenames: ['new.mp3'], tags: ['x'], action: 'remove' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 1 });
      // Created from defaults, then filter removes nothing -> tags stays [].
      expect(JSON.parse(files[META_FILE]).tracks['new.mp3'])
        .toEqual({ tags: [], genre: '', custom: {} });
    });

    it('treats any non-"remove" action as add (e.g. an explicit "add")', async () => {
      const res = await client
        .post('/api/tracks/bulk-tag')
        .send({ filenames: ['a.mp3'], tags: ['t'], action: 'add' });
      expect(res.body).toEqual({ updated: 1 });
      expect(JSON.parse(files[META_FILE]).tracks['a.mp3'].tags).toEqual(['t']);
    });

    it('reports updated count equal to filenames.length even with duplicate names', async () => {
      const res = await client
        .post('/api/tracks/bulk-tag')
        .send({ filenames: ['a.mp3', 'a.mp3'], tags: ['t'] });
      // Quirk: count is the raw array length, not distinct tracks touched.
      expect(res.body).toEqual({ updated: 2 });
    });
  });
});
