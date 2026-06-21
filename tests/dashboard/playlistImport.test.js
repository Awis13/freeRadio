/**
 * tests/dashboard/playlistImport.test.js
 *
 * Characterization tests for the playlist IMPORT path (P1-8).
 * Pins CURRENT behavior AS-IS (bugs included) before any future refactor.
 *
 * Scope (and ONLY this):
 *   - parseM3U(content)               — pure m3u line parser (lines 97-110)
 *   - POST /api/playlists/import      — m3u/pls upload endpoint (lines 224-264)
 *
 * The OTHER router endpoints (GET/POST '/', GET/PUT/DELETE '/:id', reorder) are
 * deliberately NOT pinned here — they belong to a later step (P1-9 routes).
 *
 * Why a SEPARATE file from playlist.test.js: that file mocks express.Router with
 * a stub, so the real router never runs there (which is why /import was at 0%
 * coverage). Here we mount the REAL router via supertest and drive multer with
 * .attach(). We must NOT mock express/multer in this file.
 *
 * fs strategy: playlist.js is CommonJS required through Node's native require
 * chain, sharing this process's `fs` instance — so vi.spyOn(fs, ...) intercepts
 * loadPlaylists/savePlaylists/existsSync inside the endpoint. We back PLAYLIST_FILE
 * and the musicDir existence check with the shared in-memory fs harness
 * (installPlaylistFsHarness), which is also used by playlistRouter.test.js.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

import { installPlaylistFsHarness } from './playlistHarness.js';

const { parseM3U } = (await import('../../dashboard/lib/playlist.js'))._test;

let h;
let makeApp;
let savedPlaylists;

beforeEach(() => {
  vi.restoreAllMocks();
  h = installPlaylistFsHarness();
  ({ makeApp, savedPlaylists } = h);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// parseM3U — pure parser
// ---------------------------------------------------------------------------
describe('parseM3U', () => {
  it('skips empty lines and #-comment lines (EXTM3U headers)', () => {
    const content = '#EXTM3U\n#EXTINF:123,Artist - Title\n\n  \na.mp3\n';
    expect(parseM3U(content)).toEqual(['a.mp3']);
  });

  it('reduces a full unix path to its basename', () => {
    expect(parseM3U('/music/a/b/song.mp3')).toEqual(['song.mp3']);
  });

  it('reduces a windows path to its basename', () => {
    expect(parseM3U('C:\\x\\song.mp3')).toEqual(['song.mp3']);
  });

  it('keeps only audio extensions and drops .txt / .jpg lines', () => {
    const content = 'notes.txt\ncover.jpg\nreal.mp3\n';
    expect(parseM3U(content)).toEqual(['real.mp3']);
  });

  it('matches audio extension case-insensitively (.MP3 kept)', () => {
    expect(parseM3U('LOUD.MP3')).toEqual(['LOUD.MP3']);
  });

  it('preserves order and does NOT dedupe duplicates (AS-IS)', () => {
    const content = 'a.mp3\nb.flac\na.mp3\n';
    expect(parseM3U(content)).toEqual(['a.mp3', 'b.flac', 'a.mp3']);
  });

  it('returns empty array for empty / comment-only content', () => {
    expect(parseM3U('')).toEqual([]);
    expect(parseM3U('#EXTM3U\n#only comments\n')).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    expect(parseM3U('a.mp3\r\nb.ogg\r\n')).toEqual(['a.mp3', 'b.ogg']);
  });
});

// ---------------------------------------------------------------------------
// POST /import — no file
// ---------------------------------------------------------------------------
describe('POST /import — no file', () => {
  it('returns 400 { error: "no file" } when no file attached', async () => {
    const res = await request(makeApp()).post('/api/playlists/import');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'no file' });
  });
});

// ---------------------------------------------------------------------------
// POST /import — m3u happy path + existence filter
// ---------------------------------------------------------------------------
describe('POST /import — m3u', () => {
  it('imports only existing tracks; importedCount vs totalParsed gap pinned', async () => {
    // Three parsed tracks, but only two exist in musicDir.
    h.setMusicFiles(['a.mp3', 'c.mp3']);
    const content = 'a.mp3\nb.mp3\nc.mp3\n';

    const res = await request(makeApp())
      .post('/api/playlists/import')
      .field('name', 'My Import')
      .attach('file', Buffer.from(content), 'set.m3u');

    expect(res.status).toBe(200);
    // Saved tracks = only the existing ones (b.mp3 dropped).
    expect(res.body.tracks).toEqual(['a.mp3', 'c.mp3']);
    // AS-IS gap: importedCount counts only existing, totalParsed counts ALL parsed.
    expect(res.body.importedCount).toBe(2);
    expect(res.body.totalParsed).toBe(3);
    expect(res.body.name).toBe('My Import');
    expect(res.body.type).toBe('manual');
    expect(res.body.id).toMatch(/^pl_\d+$/);
    expect(typeof res.body.createdAt).toBe('number');
    expect(typeof res.body.updatedAt).toBe('number');
  });

  it('persists the new playlist via savePlaylists (writeFileSync payload)', async () => {
    h.setMusicFiles(['x.mp3']);
    const res = await request(makeApp())
      .post('/api/playlists/import')
      .field('name', 'Persisted')
      .attach('file', Buffer.from('x.mp3\n'), 'p.m3u');

    const saved = savedPlaylists();
    expect(saved[res.body.id]).toBeDefined();
    expect(saved[res.body.id].name).toBe('Persisted');
    expect(saved[res.body.id].tracks).toEqual(['x.mp3']);
    expect(saved[res.body.id].type).toBe('manual');
  });

  it('drops ALL tracks when none exist; importedCount 0, totalParsed kept', async () => {
    h.setMusicFiles([]);
    const res = await request(makeApp())
      .post('/api/playlists/import')
      .attach('file', Buffer.from('a.mp3\nb.mp3\n'), 'none.m3u');

    expect(res.body.tracks).toEqual([]);
    expect(res.body.importedCount).toBe(0);
    expect(res.body.totalParsed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// POST /import — name resolution
// ---------------------------------------------------------------------------
describe('POST /import — name resolution', () => {
  it('explicit body.name overrides the originalname-derived name', async () => {
    h.setMusicFiles(['a.mp3']);
    const res = await request(makeApp())
      .post('/api/playlists/import')
      .field('name', 'Explicit')
      .attach('file', Buffer.from('a.mp3\n'), 'ignored-name.m3u');
    expect(res.body.name).toBe('Explicit');
  });

  it('derives name from originalname minus extension when no name field', async () => {
    h.setMusicFiles(['a.mp3']);
    const res = await request(makeApp())
      .post('/api/playlists/import')
      .attach('file', Buffer.from('a.mp3\n'), 'My Set.m3u');
    expect(res.body.name).toBe('My Set');
  });

  it('AS-IS edge: originalname ".m3u" strips to "" then falls back to "Imported"', async () => {
    h.setMusicFiles(['a.mp3']);
    const res = await request(makeApp())
      .post('/api/playlists/import')
      .attach('file', Buffer.from('a.mp3\n'), '.m3u');
    expect(res.body.name).toBe('Imported');
  });
});

// ---------------------------------------------------------------------------
// POST /import — pls branch
// ---------------------------------------------------------------------------
describe('POST /import — pls', () => {
  it('parses a real PLS sample, basename + audio-ext filter', async () => {
    h.setMusicFiles(['first.mp3', 'second.flac']);
    const content = [
      '[playlist]',
      'NumberOfEntries=2',
      'File1=/music/first.mp3',
      'Title1=First',
      'File2=C:\\songs\\second.flac',
      'Title2=Second',
      'Version=2',
    ].join('\n');

    const res = await request(makeApp())
      .post('/api/playlists/import')
      .attach('file', Buffer.from(content), 'list.pls');

    expect(res.status).toBe(200);
    expect(res.body.tracks).toEqual(['first.mp3', 'second.flac']);
    expect(res.body.totalParsed).toBe(2);
    expect(res.body.importedCount).toBe(2);
  });

  it('AS-IS quirk: File-prefix match is loose — numbered File1/File2 lines all match', async () => {
    // Pins that l.startsWith('File') accepts any "File..." line, including
    // multi-digit indices, while non-File lines (Title=, Length=) are ignored.
    h.setMusicFiles(['a.mp3', 'b.mp3', 'c.mp3']);
    const content = [
      'File1=a.mp3',
      'Title1=A',
      'File2=b.mp3',
      'File10=c.mp3',
      'Length1=-1',
    ].join('\n');

    const res = await request(makeApp())
      .post('/api/playlists/import')
      .attach('file', Buffer.from(content), 'numbered.pls');

    expect(res.body.tracks).toEqual(['a.mp3', 'b.mp3', 'c.mp3']);
    expect(res.body.totalParsed).toBe(3);
  });

  it('pls existence filter drops non-existing tracks but keeps totalParsed', async () => {
    h.setMusicFiles(['a.mp3']); // b.mp3 missing
    const content = 'File1=a.mp3\nFile2=b.mp3\n';
    const res = await request(makeApp())
      .post('/api/playlists/import')
      .attach('file', Buffer.from(content), 'gap.pls');
    expect(res.body.tracks).toEqual(['a.mp3']);
    expect(res.body.importedCount).toBe(1);
    expect(res.body.totalParsed).toBe(2);
  });
});
