/**
 * tests/dashboard/playlist.test.js
 *
 * Unit tests for dashboard/lib/playlist.js — audio playlist management.
 * Tests: loadPlaylists, getPlaylist, resolvePlaylist (manual + smart).
 * parseM3U and resolveSmartPlaylist tested indirectly through resolvePlaylist.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const PLAYLIST_FILE = '/shared/playlists.json';
const META_FILE = '/shared/track_metadata.json';
const MUSIC_DIR = '/music';

let files = {};
let musicFiles = [];

vi.mock('express', () => ({
  default: {
    Router: vi.fn(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() })),
    json: vi.fn(),
    text: vi.fn()
  },
  Router: vi.fn(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }))
}));
vi.mock('multer', () => ({ default: vi.fn(() => ({ single: vi.fn() })) }));

beforeEach(() => {
  files = {};
  musicFiles = [];
  vi.restoreAllMocks();

  vi.spyOn(fs, 'existsSync').mockImplementation(p => {
    if (p in files) return true;
    // Check if file is in music dir
    const base = path.basename(p);
    if (p.startsWith(MUSIC_DIR) && musicFiles.includes(base)) return true;
    return false;
  });
  vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
    if (p in files) return files[p];
    throw new Error('ENOENT');
  });
  vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
    files[p] = data;
  });
  // jsonStore writes <file>.tmp and renames it into place, so the mock fs has
  // to model the move (and tolerate the mkdir) or a store write vanishes.
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (from in files) {
      files[to] = files[from];
      delete files[from];
    }
  });
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});

  vi.spyOn(fs, 'readdirSync').mockImplementation((dir) => {
    if (dir === MUSIC_DIR) return musicFiles;
    return [];
  });
});

const { loadPlaylists, getPlaylist, resolvePlaylist } =
  await import('../../dashboard/lib/playlist.js');

// ---------------------------------------------------------------------------
// loadPlaylists
// ---------------------------------------------------------------------------
describe('loadPlaylists', () => {
  it('returns empty playlists when no file exists', () => {
    const data = loadPlaylists();
    expect(data.playlists).toEqual({});
  });

  it('reads playlists from file', () => {
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: { pl_1: { id: 'pl_1', name: 'Test', type: 'manual', tracks: [] } }
    });
    const data = loadPlaylists();
    expect(data.playlists['pl_1'].name).toBe('Test');
  });

  it('handles corrupt JSON gracefully', () => {
    files[PLAYLIST_FILE] = 'broken';
    const data = loadPlaylists();
    expect(data.playlists).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// getPlaylist
// ---------------------------------------------------------------------------
describe('getPlaylist', () => {
  it('returns null for unknown playlist', () => {
    expect(getPlaylist('nonexistent')).toBeNull();
  });

  it('returns playlist by id', () => {
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: { pl_1: { id: 'pl_1', name: 'My Playlist', type: 'manual', tracks: ['a.mp3'] } }
    });
    const pl = getPlaylist('pl_1');
    expect(pl.name).toBe('My Playlist');
    expect(pl.tracks).toEqual(['a.mp3']);
  });
});

// ---------------------------------------------------------------------------
// resolvePlaylist — manual
// ---------------------------------------------------------------------------
describe('resolvePlaylist — manual', () => {
  it('returns empty array for nonexistent playlist', () => {
    expect(resolvePlaylist('none', MUSIC_DIR, {})).toEqual([]);
  });

  it('returns tracks that exist on disk', () => {
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: {
        pl_1: { id: 'pl_1', type: 'manual', tracks: ['a.mp3', 'b.mp3', 'c.mp3'] }
      }
    });
    musicFiles = ['a.mp3', 'c.mp3'];
    const resolved = resolvePlaylist('pl_1', MUSIC_DIR, {});
    expect(resolved).toEqual(['a.mp3', 'c.mp3']);
  });

  it('filters out path traversal attempts', () => {
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: {
        pl_1: { id: 'pl_1', type: 'manual', tracks: ['../etc/passwd', 'good.mp3'] }
      }
    });
    musicFiles = ['good.mp3'];
    const resolved = resolvePlaylist('pl_1', MUSIC_DIR, {});
    expect(resolved).toEqual(['good.mp3']);
  });

  it('handles empty tracks array', () => {
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: { pl_1: { id: 'pl_1', type: 'manual', tracks: [] } }
    });
    expect(resolvePlaylist('pl_1', MUSIC_DIR, {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolvePlaylist — smart (BPM filter)
// ---------------------------------------------------------------------------
describe('resolvePlaylist — smart BPM filter', () => {
  beforeEach(() => {
    musicFiles = ['slow.mp3', 'mid.mp3', 'fast.mp3'];
    files[META_FILE] = JSON.stringify({ tracks: {} });
  });

  it('filters by bpmMin', () => {
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: {
        pl_1: { id: 'pl_1', type: 'smart', rules: { bpmMin: 140 } }
      }
    });
    const bpmMap = { 'slow.mp3': 120, 'mid.mp3': 140, 'fast.mp3': 160 };
    const resolved = resolvePlaylist('pl_1', MUSIC_DIR, bpmMap);
    expect(resolved).toContain('mid.mp3');
    expect(resolved).toContain('fast.mp3');
    expect(resolved).not.toContain('slow.mp3');
  });

  it('filters by bpmMax', () => {
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: {
        pl_1: { id: 'pl_1', type: 'smart', rules: { bpmMax: 140 } }
      }
    });
    const bpmMap = { 'slow.mp3': 120, 'mid.mp3': 140, 'fast.mp3': 160 };
    const resolved = resolvePlaylist('pl_1', MUSIC_DIR, bpmMap);
    expect(resolved).toContain('slow.mp3');
    expect(resolved).toContain('mid.mp3');
    expect(resolved).not.toContain('fast.mp3');
  });

  it('filters by BPM range', () => {
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: {
        pl_1: { id: 'pl_1', type: 'smart', rules: { bpmMin: 130, bpmMax: 150 } }
      }
    });
    const bpmMap = { 'slow.mp3': 120, 'mid.mp3': 140, 'fast.mp3': 160 };
    const resolved = resolvePlaylist('pl_1', MUSIC_DIR, bpmMap);
    expect(resolved).toEqual(['mid.mp3']);
  });

  it('excludes tracks without BPM data when BPM filter active', () => {
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: {
        pl_1: { id: 'pl_1', type: 'smart', rules: { bpmMin: 100 } }
      }
    });
    const bpmMap = { 'mid.mp3': 140 };
    const resolved = resolvePlaylist('pl_1', MUSIC_DIR, bpmMap);
    expect(resolved).toEqual(['mid.mp3']);
  });
});

// ---------------------------------------------------------------------------
// resolvePlaylist — smart (name pattern)
// ---------------------------------------------------------------------------
describe('resolvePlaylist — smart name pattern', () => {
  beforeEach(() => {
    musicFiles = ['dark_techno_01.mp3', 'acid_house_02.mp3', 'dark_acid_03.mp3'];
    files[META_FILE] = JSON.stringify({ tracks: {} });
  });

  it('filters by regex pattern', () => {
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: {
        pl_1: { id: 'pl_1', type: 'smart', rules: { namePattern: 'dark' } }
      }
    });
    const resolved = resolvePlaylist('pl_1', MUSIC_DIR, {});
    expect(resolved).toContain('dark_techno_01.mp3');
    expect(resolved).toContain('dark_acid_03.mp3');
    expect(resolved).not.toContain('acid_house_02.mp3');
  });

  it('pattern is case insensitive', () => {
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: {
        pl_1: { id: 'pl_1', type: 'smart', rules: { namePattern: 'DARK' } }
      }
    });
    const resolved = resolvePlaylist('pl_1', MUSIC_DIR, {});
    expect(resolved).toContain('dark_techno_01.mp3');
  });

  it('ignores invalid regex gracefully', () => {
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: {
        pl_1: { id: 'pl_1', type: 'smart', rules: { namePattern: '[invalid(' } }
      }
    });
    // Should not crash, returns all tracks (invalid regex is skipped)
    const resolved = resolvePlaylist('pl_1', MUSIC_DIR, {});
    expect(resolved.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// resolvePlaylist — smart (tag filter)
// ---------------------------------------------------------------------------
describe('resolvePlaylist — smart tag filter', () => {
  beforeEach(() => {
    musicFiles = ['a.mp3', 'b.mp3', 'c.mp3'];
    files[META_FILE] = JSON.stringify({
      tracks: {
        'a.mp3': { tags: ['dark', 'hard'], genre: '' },
        'b.mp3': { tags: ['acid'], genre: '' },
        'c.mp3': { tags: ['dark', 'acid'], genre: '' }
      }
    });
  });

  it('filters by tag (any mode — default)', () => {
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: {
        pl_1: { id: 'pl_1', type: 'smart', rules: { tags: ['acid'] } }
      }
    });
    const resolved = resolvePlaylist('pl_1', MUSIC_DIR, {});
    expect(resolved).toContain('b.mp3');
    expect(resolved).toContain('c.mp3');
    expect(resolved).not.toContain('a.mp3');
  });

  it('filters by multiple tags (any mode)', () => {
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: {
        pl_1: { id: 'pl_1', type: 'smart', rules: { tags: ['hard', 'acid'], tagMode: 'any' } }
      }
    });
    const resolved = resolvePlaylist('pl_1', MUSIC_DIR, {});
    expect(resolved.length).toBe(3); // all have at least one
  });

  it('filters by tags (all mode)', () => {
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: {
        pl_1: { id: 'pl_1', type: 'smart', rules: { tags: ['dark', 'acid'], tagMode: 'all' } }
      }
    });
    const resolved = resolvePlaylist('pl_1', MUSIC_DIR, {});
    expect(resolved).toEqual(['c.mp3']); // only c has both
  });
});

// ---------------------------------------------------------------------------
// resolvePlaylist — smart (genre filter)
// ---------------------------------------------------------------------------
describe('resolvePlaylist — smart genre filter', () => {
  beforeEach(() => {
    musicFiles = ['a.mp3', 'b.mp3'];
    files[META_FILE] = JSON.stringify({
      tracks: {
        'a.mp3': { tags: [], genre: 'Techno' },
        'b.mp3': { tags: [], genre: 'House' }
      }
    });
  });

  it('filters by genre (case insensitive)', () => {
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: {
        pl_1: { id: 'pl_1', type: 'smart', rules: { genre: 'techno' } }
      }
    });
    const resolved = resolvePlaylist('pl_1', MUSIC_DIR, {});
    expect(resolved).toEqual(['a.mp3']);
  });

  it('excludes tracks without genre metadata', () => {
    musicFiles = ['a.mp3', 'b.mp3', 'c.mp3'];
    files[META_FILE] = JSON.stringify({
      tracks: {
        'a.mp3': { tags: [], genre: 'Techno' }
      }
    });
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: {
        pl_1: { id: 'pl_1', type: 'smart', rules: { genre: 'techno' } }
      }
    });
    const resolved = resolvePlaylist('pl_1', MUSIC_DIR, {});
    expect(resolved).toEqual(['a.mp3']);
  });
});

// ---------------------------------------------------------------------------
// resolvePlaylist — smart (combined filters)
// ---------------------------------------------------------------------------
describe('resolvePlaylist — smart combined filters', () => {
  it('applies BPM + tag filters together', () => {
    musicFiles = ['a.mp3', 'b.mp3', 'c.mp3'];
    files[META_FILE] = JSON.stringify({
      tracks: {
        'a.mp3': { tags: ['dark'] },
        'b.mp3': { tags: ['dark'] },
        'c.mp3': { tags: ['light'] }
      }
    });
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: {
        pl_1: { id: 'pl_1', type: 'smart', rules: { bpmMin: 140, tags: ['dark'] } }
      }
    });
    const bpmMap = { 'a.mp3': 150, 'b.mp3': 130, 'c.mp3': 150 };
    const resolved = resolvePlaylist('pl_1', MUSIC_DIR, bpmMap);
    expect(resolved).toEqual(['a.mp3']); // only a has BPM>=140 AND tag dark
  });

  it('returns all tracks when no rules specified', () => {
    musicFiles = ['a.mp3', 'b.mp3'];
    files[META_FILE] = JSON.stringify({ tracks: {} });
    files[PLAYLIST_FILE] = JSON.stringify({
      playlists: {
        pl_1: { id: 'pl_1', type: 'smart', rules: {} }
      }
    });
    const resolved = resolvePlaylist('pl_1', MUSIC_DIR, {});
    expect(resolved.length).toBe(2);
  });
});
