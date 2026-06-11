/**
 * tests/dashboard/history.test.js
 *
 * Unit tests for dashboard/lib/history.js — play history tracking.
 * Tests: appendEntry, readHistory, getStats.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

const HISTORY_FILE = '/shared/play_history.jsonl';
let files = {};

vi.mock('express', () => ({
  default: { Router: vi.fn(() => ({ get: vi.fn() })) },
  Router: vi.fn(() => ({ get: vi.fn() }))
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
  vi.spyOn(fs, 'appendFileSync').mockImplementation((p, data) => {
    if (p in files) {
      files[p] += data;
    } else {
      throw new Error('ENOENT');
    }
  });
});

const { appendEntry, readHistory, getStats } =
  await import('../../dashboard/lib/history.js');

// ---------------------------------------------------------------------------
// appendEntry
// ---------------------------------------------------------------------------
describe('appendEntry', () => {
  it('creates file on first write', () => {
    appendEntry({ track: 'test.mp3', ts: 1000 });
    expect(files[HISTORY_FILE]).toBeDefined();
    expect(files[HISTORY_FILE]).toContain('test.mp3');
  });

  it('appends to existing file', () => {
    files[HISTORY_FILE] = JSON.stringify({ track: 'first.mp3' }) + '\n';
    appendEntry({ track: 'second.mp3', ts: 2000 });
    expect(files[HISTORY_FILE]).toContain('first.mp3');
    expect(files[HISTORY_FILE]).toContain('second.mp3');
  });

  it('writes one JSON line per entry', () => {
    appendEntry({ track: 'test.mp3', ts: 1000 });
    // Should end with newline
    expect(files[HISTORY_FILE].endsWith('\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readHistory
// ---------------------------------------------------------------------------
describe('readHistory', () => {
  it('returns empty array when no file exists', () => {
    expect(readHistory()).toEqual([]);
  });

  it('reads JSONL entries', () => {
    files[HISTORY_FILE] =
      JSON.stringify({ track: 'a.mp3', ts: 1 }) + '\n' +
      JSON.stringify({ track: 'b.mp3', ts: 2 }) + '\n';
    const entries = readHistory();
    expect(entries.length).toBe(2);
    expect(entries[0].track).toBe('a.mp3');
    expect(entries[1].track).toBe('b.mp3');
  });

  it('respects limit parameter', () => {
    files[HISTORY_FILE] =
      JSON.stringify({ track: 'a.mp3' }) + '\n' +
      JSON.stringify({ track: 'b.mp3' }) + '\n' +
      JSON.stringify({ track: 'c.mp3' }) + '\n';
    const entries = readHistory(2);
    expect(entries.length).toBe(2);
    // Should return last 2 entries
    expect(entries[0].track).toBe('b.mp3');
    expect(entries[1].track).toBe('c.mp3');
  });

  it('returns all entries when limit exceeds count', () => {
    files[HISTORY_FILE] = JSON.stringify({ track: 'a.mp3' }) + '\n';
    expect(readHistory(100).length).toBe(1);
  });

  it('skips invalid JSON lines', () => {
    files[HISTORY_FILE] =
      JSON.stringify({ track: 'good.mp3' }) + '\n' +
      'not json\n' +
      JSON.stringify({ track: 'also_good.mp3' }) + '\n';
    const entries = readHistory();
    expect(entries.length).toBe(2);
  });

  it('handles empty file', () => {
    files[HISTORY_FILE] = '';
    expect(readHistory()).toEqual([]);
  });

  it('handles file with only whitespace', () => {
    files[HISTORY_FILE] = '   \n\n  \n';
    expect(readHistory()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getStats
// ---------------------------------------------------------------------------
describe('getStats', () => {
  it('returns zero counts when no history', () => {
    const stats = getStats();
    expect(stats.totalPlayed).toBe(0);
    expect(stats.uniqueTracks).toBe(0);
    expect(stats.topTracks).toEqual([]);
    expect(stats.firstEntry).toBeNull();
    expect(stats.lastEntry).toBeNull();
  });

  it('counts total and unique tracks', () => {
    files[HISTORY_FILE] =
      JSON.stringify({ track: 'a.mp3', ts: 1 }) + '\n' +
      JSON.stringify({ track: 'b.mp3', ts: 2 }) + '\n' +
      JSON.stringify({ track: 'a.mp3', ts: 3 }) + '\n';
    const stats = getStats();
    expect(stats.totalPlayed).toBe(3);
    expect(stats.uniqueTracks).toBe(2);
  });

  it('ranks top tracks by play count', () => {
    files[HISTORY_FILE] =
      JSON.stringify({ track: 'a.mp3', ts: 1 }) + '\n' +
      JSON.stringify({ track: 'b.mp3', ts: 2 }) + '\n' +
      JSON.stringify({ track: 'a.mp3', ts: 3 }) + '\n' +
      JSON.stringify({ track: 'a.mp3', ts: 4 }) + '\n';
    const stats = getStats();
    expect(stats.topTracks[0].track).toBe('a.mp3');
    expect(stats.topTracks[0].count).toBe(3);
    expect(stats.topTracks[1].track).toBe('b.mp3');
    expect(stats.topTracks[1].count).toBe(1);
  });

  it('limits top tracks to 20', () => {
    let content = '';
    for (let i = 0; i < 25; i++) {
      content += JSON.stringify({ track: `track${i}.mp3`, ts: i }) + '\n';
    }
    files[HISTORY_FILE] = content;
    expect(getStats().topTracks.length).toBe(20);
  });

  it('extracts filename from full path in track field', () => {
    files[HISTORY_FILE] =
      JSON.stringify({ track: '/music/processed/song.mp3', ts: 1 }) + '\n';
    const stats = getStats();
    expect(stats.topTracks[0].track).toBe('song.mp3');
  });

  it('returns first and last entry timestamps', () => {
    files[HISTORY_FILE] =
      JSON.stringify({ track: 'a.mp3', ts: 100 }) + '\n' +
      JSON.stringify({ track: 'b.mp3', ts: 200 }) + '\n';
    const stats = getStats();
    expect(stats.firstEntry).toBe(100);
    expect(stats.lastEntry).toBe(200);
  });

  it('reports uptime', () => {
    const stats = getStats();
    expect(stats.uptimeMs).toBeGreaterThan(0);
    expect(typeof stats.uptimeMs).toBe('number');
  });
});
