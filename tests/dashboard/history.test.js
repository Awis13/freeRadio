/**
 * tests/dashboard/history.test.js
 *
 * Unit tests for dashboard/lib/history.js — play history tracking.
 * Tests: appendEntry, readHistory, getStats.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import { serverAgent } from './helpers/serverAgent.js';

const HISTORY_FILE = '/shared/play_history.jsonl';
let files = {};

// Mount the REAL history router on a real express app so the route handler
// bodies (history.js 58-88) execute for real. The in-memory `files` map (backed
// by the fs spies installed in beforeEach) is what readHistory/getStats read,
// so each endpoint sees whatever the test seeded.
function makeApp() {
  const app = express();
  app.use('/api/history', createHistoryRouter());
  return app;
}

let client;
let closeServer;

beforeEach(async () => {
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
  ({ client, close: closeServer } = await serverAgent(makeApp()));
});

afterEach(async () => {
  await closeServer();
  vi.restoreAllMocks();
});

const { createHistoryRouter, appendEntry, readHistory, getStats } =
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

  // QUIRK: track name is `(e.track || '').split('/').pop()`. An entry whose
  // track basename resolves to '' is dropped by the `if (name)` guard, so it
  // counts toward totalPlayed (entries.length) but NOT toward trackCounts /
  // uniqueTracks / topTracks. Missing track, '', and a trailing-slash path all
  // collapse to '' here.
  it('counts nameless entries in totalPlayed but excludes them from track stats', () => {
    files[HISTORY_FILE] =
      JSON.stringify({ ts: 1 }) + '\n' +            // no track key -> ''
      JSON.stringify({ track: '', ts: 2 }) + '\n' + // empty string -> ''
      JSON.stringify({ track: 'music/', ts: 3 }) + '\n' + // basename '' -> ''
      JSON.stringify({ track: 'real.mp3', ts: 4 }) + '\n';
    const stats = getStats();
    expect(stats.totalPlayed).toBe(4);
    expect(stats.uniqueTracks).toBe(1);
    expect(stats.topTracks).toEqual([{ track: 'real.mp3', count: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// readHistory — outer catch (29-30): unexpected fs failure -> []
// ---------------------------------------------------------------------------
describe('readHistory outer catch', () => {
  it('returns [] when readFileSync throws after existsSync says the file is present', () => {
    // existsSync true but readFileSync explodes -> outer try/catch swallows
    // and returns [] (the inner per-line try/catch only guards JSON.parse).
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockImplementation(() => { throw new Error('EIO'); });
    expect(readHistory()).toEqual([]);
    expect(readHistory(5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createHistoryRouter — route registration + handler bodies (58-88)
// ---------------------------------------------------------------------------
describe('createHistoryRouter', () => {
  describe('GET /api/history', () => {
    it('defaults to a limit of 50 when no query is given', async () => {
      // Seed 60 entries; handler uses `parseInt(req.query.limit) || 50`.
      let content = '';
      for (let i = 0; i < 60; i++) {
        content += JSON.stringify({ track: `t${i}.mp3`, ts: i }) + '\n';
      }
      files[HISTORY_FILE] = content;

      const res = await client.get('/api/history');
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(50);
      // slice(-50) -> last 50, so first returned is t10.mp3.
      expect(res.body[0].track).toBe('t10.mp3');
      expect(res.body[49].track).toBe('t59.mp3');
    });

    it('honours an explicit numeric limit query', async () => {
      files[HISTORY_FILE] =
        JSON.stringify({ track: 'a.mp3', ts: 1 }) + '\n' +
        JSON.stringify({ track: 'b.mp3', ts: 2 }) + '\n' +
        JSON.stringify({ track: 'c.mp3', ts: 3 }) + '\n';

      const res = await client.get('/api/history?limit=2');
      expect(res.status).toBe(200);
      expect(res.body.map(e => e.track)).toEqual(['b.mp3', 'c.mp3']);
    });

    // QUIRK: `parseInt(req.query.limit) || 50`. limit '0' -> 0 (falsy) -> 50;
    // a non-numeric limit -> NaN (falsy) -> 50. Both fall back to 50, never 0.
    it('falls back to 50 for a zero or non-numeric limit', async () => {
      let content = '';
      for (let i = 0; i < 55; i++) {
        content += JSON.stringify({ track: `t${i}.mp3`, ts: i }) + '\n';
      }
      files[HISTORY_FILE] = content;

      const zero = await client.get('/api/history?limit=0');
      expect(zero.body.length).toBe(50);

      const junk = await client.get('/api/history?limit=abc');
      expect(junk.body.length).toBe(50);
    });

    it('returns [] when no history file exists', async () => {
      const res = await client.get('/api/history');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('GET /api/history/stats', () => {
    it('delegates to getStats and returns its shape', async () => {
      files[HISTORY_FILE] =
        JSON.stringify({ track: 'a.mp3', ts: 10 }) + '\n' +
        JSON.stringify({ track: 'a.mp3', ts: 20 }) + '\n' +
        JSON.stringify({ track: 'b.mp3', ts: 30 }) + '\n';

      const res = await client.get('/api/history/stats');
      expect(res.status).toBe(200);
      const stats = res.body;
      expect(stats.totalPlayed).toBe(3);
      expect(stats.uniqueTracks).toBe(2);
      expect(stats.firstEntry).toBe(10);
      expect(stats.lastEntry).toBe(30);
      expect(stats.topTracks[0]).toEqual({ track: 'a.mp3', count: 2 });
      expect(typeof stats.uptimeMs).toBe('number');
    });
  });

  describe('GET /api/history/analytics', () => {
    it('maps stats and formats sub-hour uptime as "<mins>m"', async () => {
      files[HISTORY_FILE] =
        JSON.stringify({ track: 'a.mp3', ts: 1 }) + '\n' +
        JSON.stringify({ track: 'b.mp3', ts: 2 }) + '\n';

      const res = await client.get('/api/history/analytics');
      expect(res.status).toBe(200);
      const payload = res.body;
      // startedAt is captured at module import (real time) and tests run within
      // the same hour, so uptimeMs < 3600000 -> hours === 0 -> "<mins>m".
      expect(payload.totalTracks).toBe(2);
      expect(payload.uniqueTracks).toBe(2);
      expect(payload.peakListeners).toBe(0);
      expect(payload.uptime).toMatch(/^\d+m$/);
    });

    it('formats multi-hour uptime as "<h>h <m>m" when uptime exceeds an hour', async () => {
      // Push Date.now far past module-load startedAt so uptimeMs > 1h, hitting
      // the hours>0 branch. Stub Date.now only (NOT full fake timers) so the
      // real loopback http stack supertest uses still completes. getStats reads
      // uptimeMs = Date.now() - startedAt; analytics derives hours/mins from it.
      const real = Date.now();
      const spy = vi.spyOn(Date, 'now').mockReturnValue(real + (2 * 3600000) + (5 * 60000));
      try {
        const res = await client.get('/api/history/analytics');
        const payload = res.body;
        // hours>0 -> "<h>h <m>m"; exact h/m depends on real startedAt, so pin
        // the FORMAT and that hours is at least 2.
        expect(payload.uptime).toMatch(/^\d+h \d+m$/);
        const hours = parseInt(payload.uptime, 10);
        expect(hours).toBeGreaterThanOrEqual(2);
      } finally {
        spy.mockRestore();
      }
    });

    it('reports zeros when there is no history', async () => {
      const res = await client.get('/api/history/analytics');
      const payload = res.body;
      expect(payload.totalTracks).toBe(0);
      expect(payload.uniqueTracks).toBe(0);
      expect(payload.peakListeners).toBe(0);
      expect(payload.uptime).toMatch(/^\d+m$/);
    });
  });
});
