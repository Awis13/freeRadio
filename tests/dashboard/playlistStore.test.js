/**
 * tests/dashboard/playlistStore.test.js
 *
 * Proves dashboard/lib/playlistStore.js can reproduce BOTH shipped contracts —
 * lib/playlist.js (audio) and lib/videoPlaylist.js (video) — before C2 cuts
 * either of them over to it.
 *
 * The suite is driven twice from one table: once with the audio parameter set,
 * once with the video one. Everything asserted in the shared block must hold
 * for both; the divergence block asserts, per domain, the things that are
 * deliberately NOT the same today. Those divergence tests are the written
 * record of what C2 will decide to align:
 *
 *   - track directory: audio reads the directory it is given, video reads
 *     <dir>/.processed;
 *   - extensions: audio wav/mp3/flac/ogg/aac/m4a, video mp4/mov/mkv;
 *   - smart scan: video also skips _standby_ files;
 *   - smart rules: audio honours bpmMin/bpmMax and genre, video ignores both
 *     (a video playlist carrying a genre rule resolves as if it were absent);
 *   - id prefix: pl_ vs vpl_.
 *
 * REAL filesystem: the store round-trips through jsonStore, so the test writes
 * to a mkdtemp directory rather than mocking fs. That also keeps the assertion
 * on the written data shape honest.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serverAgent } from './helpers/serverAgent.js';

const nodeRequire = createRequire(import.meta.url);
const { createPlaylistStore } = nodeRequire('../../dashboard/lib/playlistStore');
const trackMeta = nodeRequire('../../dashboard/lib/trackMeta');

const AUDIO_EXT = /\.(wav|mp3|flac|ogg|aac|m4a)$/i;
const VIDEO_EXT = /\.(mp4|mov|mkv)$/i;

/** The two parameter sets, mirroring what C2 will pass from each module. */
const DOMAINS = {
  audio: {
    storeFile: 'playlists.json',
    idPrefix: 'pl_',
    extensions: AUDIO_EXT,
    trackDir: (dir) => dir,
    skipPrefixes: [],
    smartRules: { bpm: true, genre: true },
    present: ['keep.mp3', 'other.wav'],
    foreign: 'clip.mp4',
  },
  video: {
    storeFile: 'video_playlists.json',
    idPrefix: 'vpl_',
    extensions: VIDEO_EXT,
    trackDir: (dir) => path.join(dir, '.processed'),
    skipPrefixes: ['_standby_'],
    smartRules: {},
    present: ['keep.mp4', 'other.mov'],
    foreign: 'song.mp3',
  },
};

let tmp;
let metaSpy;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plstore-'));
  metaSpy = vi.spyOn(trackMeta, 'loadMeta').mockReturnValue({ tracks: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Build a store + its track directory for one domain. */
function setup(domainName, { files = [], meta = null, bpmMap = {} } = {}) {
  const d = DOMAINS[domainName];
  const baseDir = path.join(tmp, 'media');
  const dir = d.trackDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of files) fs.writeFileSync(path.join(dir, name), 'x');
  if (meta) metaSpy.mockReturnValue(meta);

  const store = createPlaylistStore({
    file: path.join(tmp, d.storeFile),
    idPrefix: d.idPrefix,
    extensions: d.extensions,
    trackDir: d.trackDir,
    skipPrefixes: d.skipPrefixes,
    smartRules: d.smartRules,
  });
  return { store, baseDir, dir, d, bpmMap };
}

async function mount(store, baseDir, opts) {
  const app = express();
  app.use('/api/pl', store.createRouter(baseDir, opts));
  return serverAgent(app);
}

// ---------------------------------------------------------------------------
// Shared contract — must hold identically for both domains
// ---------------------------------------------------------------------------
for (const domainName of Object.keys(DOMAINS)) {
  describe(`shared contract (${domainName} parameters)`, () => {
    it('load returns the empty shape when the store file is absent', () => {
      const { store } = setup(domainName);
      expect(store.load()).toEqual({ playlists: {} });
    });

    it('save writes { playlists } and load reads it back', () => {
      const { store, d } = setup(domainName);
      store.save({ playlists: { a: { id: 'a', name: 'A' } } });
      expect(store.load()).toEqual({ playlists: { a: { id: 'a', name: 'A' } } });
      // Written shape, not just round-trip: this is what syncWatcher backs up.
      const raw = JSON.parse(fs.readFileSync(path.join(tmp, d.storeFile), 'utf8'));
      expect(raw).toEqual({ playlists: { a: { id: 'a', name: 'A' } } });
    });

    it('get returns null for an unknown id', () => {
      const { store } = setup(domainName);
      expect(store.get('nope')).toBeNull();
    });

    it('manual resolve keeps order and drops missing files', () => {
      const { store, baseDir, d } = setup(domainName, { files: DOMAINS[domainName].present });
      store.save({ playlists: { p: { id: 'p', type: 'manual', tracks: [d.present[1], 'gone.xyz', d.present[0]] } } });
      expect(store.resolve('p', baseDir)).toEqual([d.present[1], d.present[0]]);
    });

    it('manual resolve drops a traversal-shaped entry even when its basename exists', () => {
      const { store, baseDir, d } = setup(domainName, { files: DOMAINS[domainName].present });
      store.save({ playlists: { p: { id: 'p', type: 'manual', tracks: ['../' + d.present[0]] } } });
      expect(store.resolve('p', baseDir)).toEqual([]);
    });

    it('resolve returns [] for an unknown playlist and for an unknown type', () => {
      const { store, baseDir } = setup(domainName);
      expect(store.resolve('nope', baseDir)).toEqual([]);
      store.save({ playlists: { p: { id: 'p', type: 'weird' } } });
      expect(store.resolve('p', baseDir)).toEqual([]);
    });

    it('smart resolve ignores dotfiles and unknown extensions', () => {
      const dom = DOMAINS[domainName];
      const { store, baseDir, d } = setup(domainName, { files: [...dom.present, '.hidden' + path.extname(dom.present[0]), dom.foreign] });
      store.save({ playlists: { s: { id: 's', type: 'smart', rules: {} } } });
      expect(store.resolve('s', baseDir).sort()).toEqual([...d.present].sort());
    });

    it('smart namePattern filters, and an invalid regex is ignored', () => {
      const { store, baseDir, d } = setup(domainName, { files: DOMAINS[domainName].present });
      store.save({ playlists: {
        good: { id: 'good', type: 'smart', rules: { namePattern: '^keep' } },
        bad: { id: 'bad', type: 'smart', rules: { namePattern: '([' } },
      } });
      expect(store.resolve('good', baseDir)).toEqual([d.present[0]]);
      expect(store.resolve('bad', baseDir).sort()).toEqual([...d.present].sort());
    });

    it('smart tag rules honour any (default) and all modes', () => {
      const dom = DOMAINS[domainName];
      const { store, baseDir, d } = setup(domainName, {
        files: dom.present,
        meta: { tracks: {
          [dom.present[0]]: { tags: ['chill', 'night'] },
          [dom.present[1]]: { tags: ['chill'] },
        } },
      });
      store.save({ playlists: {
        any: { id: 'any', type: 'smart', rules: { tags: ['night', 'nope'] } },
        all: { id: 'all', type: 'smart', rules: { tags: ['chill', 'night'], tagMode: 'all' } },
      } });
      expect(store.resolve('any', baseDir)).toEqual([d.present[0]]);
      expect(store.resolve('all', baseDir)).toEqual([d.present[0]]);
    });

    it('smart resolve returns [] when the directory does not exist', () => {
      const { store } = setup(domainName);
      store.save({ playlists: { s: { id: 's', type: 'smart', rules: {} } } });
      expect(store.resolve('s', path.join(tmp, 'no-such-dir'))).toEqual([]);
    });

    describe('router', () => {
      let client, close, store, baseDir, d;

      beforeEach(async () => {
        ({ store, baseDir, d } = setup(domainName, { files: DOMAINS[domainName].present }));
        ({ client, close } = await mount(store, baseDir));
      });

      afterEach(async () => { await close(); });

      it('GET / lists playlists as a bare array with a trackCount', async () => {
        store.save({ playlists: { p: { id: 'p', name: 'P', type: 'manual', tracks: [d.present[0], 'gone.xyz'] } } });
        const res = await client.get('/api/pl');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body).toEqual([expect.objectContaining({ id: 'p', trackCount: 1 })]);
      });

      it('POST / creates with the domain id prefix and rejects a missing name', async () => {
        const bad = await client.post('/api/pl').send({});
        expect(bad.status).toBe(400);
        expect(bad.body).toEqual({ error: 'name required' });

        const res = await client.post('/api/pl').send({ name: 'New', tracks: ['../x' + path.extname(d.present[0])] });
        expect(res.status).toBe(200);
        expect(res.body.id.startsWith(d.idPrefix)).toBe(true);
        expect(res.body.type).toBe('manual');
        // create sanitises with basename() but does NOT check existence
        expect(res.body.tracks).toEqual(['x' + path.extname(d.present[0])]);
      });

      it('GET /:id returns resolvedTracks and a resolved trackCount, 404 otherwise', async () => {
        store.save({ playlists: { p: { id: 'p', name: 'P', type: 'manual', tracks: [d.present[0], 'gone.xyz'] } } });
        const res = await client.get('/api/pl/p');
        expect(res.body.resolvedTracks).toEqual([d.present[0]]);
        expect(res.body.trackCount).toBe(1);
        expect((await client.get('/api/pl/nope')).status).toBe(404);
      });

      it('PUT /:id updates name and tracks, bumps updatedAt, 404s unknown', async () => {
        store.save({ playlists: { p: { id: 'p', name: 'Old', type: 'manual', tracks: [], updatedAt: 1 } } });
        const res = await client.put('/api/pl/p').send({ name: 'New', tracks: ['../y' + path.extname(d.present[0])] });
        expect(res.body.name).toBe('New');
        expect(res.body.tracks).toEqual(['y' + path.extname(d.present[0])]);
        expect(res.body.updatedAt).toBeGreaterThan(1);
        expect((await client.put('/api/pl/nope').send({ name: 'x' })).status).toBe(404);
      });

      it('DELETE /:id removes it, 404s unknown', async () => {
        store.save({ playlists: { p: { id: 'p', name: 'P', type: 'manual', tracks: [] } } });
        const res = await client.delete('/api/pl/p');
        expect(res.body).toEqual({ ok: true });
        expect(store.load().playlists.p).toBeUndefined();
        expect((await client.delete('/api/pl/p')).status).toBe(404);
      });

      it('POST /:id/reorder moves a track and guards type, arg types and range', async () => {
        store.save({ playlists: {
          p: { id: 'p', name: 'P', type: 'manual', tracks: ['a', 'b', 'c'] },
          s: { id: 's', name: 'S', type: 'smart', rules: {} },
        } });
        const ok = await client.post('/api/pl/p/reorder').send({ from: 0, to: 2 });
        expect(ok.body.tracks).toEqual(['b', 'c', 'a']);

        expect((await client.post('/api/pl/s/reorder').send({ from: 0, to: 1 })).body)
          .toEqual({ error: 'only manual playlists' });
        expect((await client.post('/api/pl/p/reorder').send({ from: '0', to: 1 })).body)
          .toEqual({ error: 'from and to must be numbers' });
        expect((await client.post('/api/pl/p/reorder').send({ from: 0, to: 9 })).body)
          .toEqual({ error: 'index out of range' });
        expect((await client.post('/api/pl/nope/reorder').send({ from: 0, to: 1 })).status).toBe(404);
      });

      it('list counts a traversal entry that detail refuses to resolve (shared quirk, AS-IS)', async () => {
        // GET / counts with basename() only; GET /:id additionally requires
        // safe === t. Both domains have carried this gap; C2 decides whether to
        // close it, and this pin is what will fail when it does.
        store.save({ playlists: { p: { id: 'p', name: 'P', type: 'manual', tracks: ['../' + d.present[0]] } } });
        const list = await client.get('/api/pl');
        const detail = await client.get('/api/pl/p');
        expect(list.body[0].trackCount).toBe(1);
        expect(detail.body.trackCount).toBe(0);
      });

      it('extraRoutes and beforeDelete hooks reach the shared store', async () => {
        const seen = [];
        const { store: s2, baseDir: b2 } = setup(domainName);
        const agent = await mount(s2, b2, {
          beforeDelete: (id) => seen.push(id),
          extraRoutes: (router, ctx) => {
            router.post('/:id/extra', (req, res) => res.json({ known: ctx.get(req.params.id) !== null }));
          },
        });
        try {
          s2.save({ playlists: { p: { id: 'p', type: 'manual', tracks: [] } } });
          expect((await agent.client.post('/api/pl/p/extra')).body).toEqual({ known: true });
          await agent.client.delete('/api/pl/p');
          expect(seen).toEqual(['p']);
        } finally {
          await agent.close();
        }
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Divergences — what C2 has to decide about
// ---------------------------------------------------------------------------
describe('divergences between the two parameter sets', () => {
  it('audio reads the directory it is given; video reads <dir>/.processed', () => {
    const a = setup('audio', { files: ['keep.mp3'] });
    a.store.save({ playlists: { p: { id: 'p', type: 'manual', tracks: ['keep.mp3'] } } });
    expect(a.store.resolve('p', a.baseDir)).toEqual(['keep.mp3']);
    expect(a.dir).toBe(a.baseDir);

    const v = setup('video', { files: ['keep.mp4'] });
    v.store.save({ playlists: { p: { id: 'p', type: 'manual', tracks: ['keep.mp4'] } } });
    expect(v.store.resolve('p', v.baseDir)).toEqual(['keep.mp4']);
    expect(v.dir).toBe(path.join(v.baseDir, '.processed'));
    // The same file directly under the base dir is invisible to the video store.
    fs.writeFileSync(path.join(v.baseDir, 'loose.mp4'), 'x');
    v.store.save({ playlists: { q: { id: 'q', type: 'smart', rules: {} } } });
    expect(v.store.resolve('q', v.baseDir)).toEqual(['keep.mp4']);
  });

  it('each domain ignores the other domain extensions', () => {
    const a = setup('audio', { files: ['song.mp3', 'clip.mp4'] });
    a.store.save({ playlists: { s: { id: 's', type: 'smart', rules: {} } } });
    expect(a.store.resolve('s', a.baseDir)).toEqual(['song.mp3']);

    const v = setup('video', { files: ['clip.mp4', 'song.mp3'] });
    v.store.save({ playlists: { s: { id: 's', type: 'smart', rules: {} } } });
    expect(v.store.resolve('s', v.baseDir)).toEqual(['clip.mp4']);
  });

  it('video skips _standby_ files, audio has no such exclusion', () => {
    const v = setup('video', { files: ['keep.mp4', '_standby_filler.mp4'] });
    v.store.save({ playlists: { s: { id: 's', type: 'smart', rules: {} } } });
    expect(v.store.resolve('s', v.baseDir)).toEqual(['keep.mp4']);

    const a = setup('audio', { files: ['keep.mp3', '_standby_filler.mp3'] });
    a.store.save({ playlists: { s: { id: 's', type: 'smart', rules: {} } } });
    expect(a.store.resolve('s', a.baseDir).sort()).toEqual(['_standby_filler.mp3', 'keep.mp3']);
  });

  it('bpm rules filter audio and are ignored by video', () => {
    const a = setup('audio', { files: ['slow.mp3', 'fast.mp3'] });
    a.store.save({ playlists: { s: { id: 's', type: 'smart', rules: { bpmMin: 120 } } } });
    expect(a.store.resolve('s', a.baseDir, { 'slow.mp3': 90, 'fast.mp3': 140 })).toEqual(['fast.mp3']);

    const v = setup('video', { files: ['a.mp4', 'b.mp4'] });
    v.store.save({ playlists: { s: { id: 's', type: 'smart', rules: { bpmMin: 120 } } } });
    // No bpm rule for video: the constraint is inert, both clips resolve.
    expect(v.store.resolve('s', v.baseDir, { 'a.mp4': 90 }).sort()).toEqual(['a.mp4', 'b.mp4']);
  });

  it('genre rules filter audio and are ignored by video', () => {
    const a = setup('audio', {
      files: ['jazz.mp3', 'rock.mp3'],
      meta: { tracks: { 'jazz.mp3': { genre: 'Jazz' }, 'rock.mp3': { genre: 'Rock' } } },
    });
    a.store.save({ playlists: { s: { id: 's', type: 'smart', rules: { genre: 'jazz' } } } });
    expect(a.store.resolve('s', a.baseDir)).toEqual(['jazz.mp3']);

    const v = setup('video', {
      files: ['a.mp4', 'b.mp4'],
      meta: { tracks: { 'a.mp4': { genre: 'Jazz' } } },
    });
    v.store.save({ playlists: { s: { id: 's', type: 'smart', rules: { genre: 'jazz' } } } });
    expect(v.store.resolve('s', v.baseDir).sort()).toEqual(['a.mp4', 'b.mp4']);
  });
});
