/**
 * tests/dashboard/trackMeta.test.js
 *
 * Unit tests for dashboard/lib/trackMeta.js — per-track metadata.
 * Tests: loadMeta, getTrackMeta, setTrackMeta, bulkTag (add/remove), getAllTags.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

const META_FILE = '/shared/track_metadata.json';
let files = {};

vi.mock('express', () => ({
  default: { Router: vi.fn(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() })), json: vi.fn() },
  Router: vi.fn(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }))
}));

beforeEach(() => {
  files = {};
  vi.restoreAllMocks();

  vi.spyOn(fs, 'existsSync').mockImplementation(p => p in files);
  vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
    if (p in files) return files[p];
    throw new Error('ENOENT');
  });
  vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
    files[p] = data;
  });
  vi.spyOn(fs, 'statSync').mockImplementation(() => ({ size: 1000, mtime: new Date() }));
  vi.spyOn(fs, 'readdirSync').mockImplementation(() => []);
});

const { loadMeta, getTrackMeta, setTrackMeta, getAllTags } =
  await import('../../dashboard/lib/trackMeta.js');

// We need to import bulkTag — check if it's exported
// Looking at the module: module.exports includes createTrackRouter, getTrackMeta, setTrackMeta, loadMeta, getAllTags
// bulkTag is NOT exported. We test it indirectly through setTrackMeta or can't test it.
// Actually, checking the source again... the module only exports:
// { createTrackRouter, getTrackMeta, setTrackMeta, loadMeta, getAllTags }
// bulkTag is internal. We'll test tag management through setTrackMeta.

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
