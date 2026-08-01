/**
 * tests/dashboard/cacheManager.test.js
 *
 * Characterization of dashboard/lib/cacheManager.js (P1-5).
 *
 * Strategy: eviction and size tests run against a REAL tmpdir with
 * fs.utimesSync staggering atimes — the module walks the filesystem itself,
 * so a real tree is both the simplest and the most honest fixture. The s3 dependency is
 * the shared CJS module instance (same require cache), and prefetch reads
 * s3.S3_ENABLED / s3.ensureCached as PROPERTIES at call time — so we flip
 * the flag and spy on the seam directly. Loaded via createRequire so both
 * modules live in Node's native cache, never mixed with Vitest's graph.
 *
 * Pinned here (current behavior, callers depend on it):
 *   - evictOldest deletes oldest-atime files FIRST (ascending sort —
 *     the audit's comparator-inversion warning is disproven here), stops
 *     as soon as size fits, returns the eviction count;
 *   - dotfiles are invisible to eviction: never counted, never deleted;
 *   - missing dir -> 0; unlink failures are swallowed (count stays 0);
 *   - getCacheSize: missing dir -> 0; otherwise the exact byte total,
 *     counting dotfiles and walking subdirectories. It used to shell out to
 *     `du -sb`, which neither busybox nor macOS supports, so the answer was 0
 *     everywhere that mattered and the size pins could only assert
 *     "non-negative";
 *   - prefetchTracks maps any extension to music/processed/<base>.wav
 *     (both S3 key and local path), prefetchVideos maps basename to
 *     visuals/processed/<name> -> <visualsDir>/.processed/<name>;
 *   - both prefetchers: no-op when S3 disabled or list empty/null;
 *     per-file ensureCached rejections are swallowed and do not stop
 *     the batch.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const CACHE_SPEC = '../../dashboard/lib/cacheManager';
const S3_SPEC = '../../dashboard/lib/s3';

// Make sure s3.js loads inert (no client, S3_ENABLED=false) before
// cacheManager pulls it in.
const ORIGINAL_S3_ENABLED_ENV = process.env.S3_ENABLED;
delete process.env.S3_ENABLED;

const cache = nodeRequire(CACHE_SPEC);
// Same cached instance cacheManager got via its own require('./s3').
const s3 = nodeRequire(S3_SPEC);
const ORIGINAL_S3_FLAG = s3.S3_ENABLED;

let tmpDirs = [];
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cachetest-'));
  tmpDirs.push(dir);
  return dir;
}

/** Create a file of `bytes` size with atime/mtime `ageSec` seconds in the past. */
function seedFile(dir, name, bytes, ageSec) {
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, Buffer.alloc(bytes, 0x61));
  const t = Date.now() / 1000 - ageSec;
  fs.utimesSync(fp, t, t);
  return fp;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  s3.S3_ENABLED = ORIGINAL_S3_FLAG;
  for (const dir of tmpDirs) {
    try {
      fs.chmodSync(dir, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {}
  }
  tmpDirs = [];
});

afterAll(() => {
  if (ORIGINAL_S3_ENABLED_ENV === undefined) delete process.env.S3_ENABLED;
  else process.env.S3_ENABLED = ORIGINAL_S3_ENABLED_ENV;
  delete nodeRequire.cache[nodeRequire.resolve(CACHE_SPEC)];
  delete nodeRequire.cache[nodeRequire.resolve(S3_SPEC)];
});

// ---------------------------------------------------------------------------
// evictOldest — LRU eviction order
// ---------------------------------------------------------------------------
describe('evictOldest', () => {
  it('evicts the OLDEST-atime files first and stops once under the limit', () => {
    const dir = makeTmpDir();
    seedFile(dir, 'oldest.bin', 100, 300);
    seedFile(dir, 'middle.bin', 100, 200);
    seedFile(dir, 'newest.bin', 100, 100);

    // 300 bytes total, limit 150: evict oldest (-> 200), evict middle (-> 100 <= 150), stop.
    const evicted = cache.evictOldest(dir, 150);
    expect(evicted).toBe(2);
    expect(fs.existsSync(path.join(dir, 'oldest.bin'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'middle.bin'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'newest.bin'))).toBe(true);
  });

  it('evicts nothing when already under the limit', () => {
    const dir = makeTmpDir();
    seedFile(dir, 'a.bin', 100, 200);
    seedFile(dir, 'b.bin', 100, 100);
    expect(cache.evictOldest(dir, 10000)).toBe(0);
    expect(fs.readdirSync(dir).sort()).toEqual(['a.bin', 'b.bin']);
  });

  it('ignores dotfiles entirely: not counted toward size, never deleted', () => {
    const dir = makeTmpDir();
    seedFile(dir, '.hidden', 1000, 400); // oldest AND biggest — would dominate if counted
    seedFile(dir, 'old.bin', 100, 300);
    seedFile(dir, 'new.bin', 100, 100);

    // Visible size 200, limit 150: exactly one eviction (old.bin).
    // If .hidden were counted (1200 total) two visible files would go.
    const evicted = cache.evictOldest(dir, 150);
    expect(evicted).toBe(1);
    expect(fs.existsSync(path.join(dir, '.hidden'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'old.bin'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'new.bin'))).toBe(true);
  });

  it('returns 0 for a nonexistent directory', () => {
    expect(cache.evictOldest('/nonexistent/cache/dir', 100)).toBe(0);
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'swallows unlink errors and does not count failed evictions',
    () => {
      const dir = makeTmpDir();
      seedFile(dir, 'stuck.bin', 100, 200);
      fs.chmodSync(dir, 0o555); // read-only dir -> unlink fails
      try {
        const evicted = cache.evictOldest(dir, 10);
        expect(evicted).toBe(0);
      } finally {
        fs.chmodSync(dir, 0o755);
      }
      expect(fs.existsSync(path.join(dir, 'stuck.bin'))).toBe(true);
    }
  );
});

// ---------------------------------------------------------------------------
// getCacheSize
//
// These used to be "non-negative number" pins because the implementation
// shelled out to `du -sb`, which macOS and busybox both reject — so the real
// answer everywhere except glibc Linux was 0, and the pins could not say more.
// It is computed in process now, so the size is assertable exactly.
// ---------------------------------------------------------------------------
describe('getCacheSize', () => {
  it('returns 0 for a nonexistent directory', () => {
    expect(cache.getCacheSize('/nonexistent/cache/dir')).toBe(0);
  });

  it('sums the bytes of the files in the directory', () => {
    const dir = makeTmpDir();
    seedFile(dir, 'a.bin', 100, 10);
    seedFile(dir, 'b.bin', 250, 10);
    expect(cache.getCacheSize(dir)).toBe(350);
  });

  it('counts dotfiles and walks into subdirectories, as du did', () => {
    const dir = makeTmpDir();
    seedFile(dir, 'a.bin', 100, 10);
    seedFile(dir, '.hidden', 7, 10);
    const sub = path.join(dir, 'nested');
    fs.mkdirSync(sub);
    seedFile(sub, 'deep.bin', 40, 10);
    expect(cache.getCacheSize(dir)).toBe(147);
  });

  it('returns 0 for an empty directory', () => {
    expect(cache.getCacheSize(makeTmpDir())).toBe(0);
  });

  it('eviction now actually fires at the threshold (the alpine bug)', () => {
    // server.js gates eviction on getCacheSize(dir) > maxBytes. With du -sb
    // failing in the image, that call returned 0, the comparison was never
    // true, and the cache grew without bound however full it got. This is the
    // whole chain: a directory over the limit reports its real size, and
    // eviction driven by that number removes the oldest files.
    const dir = makeTmpDir();
    seedFile(dir, 'old.bin', 300, 900);
    seedFile(dir, 'new.bin', 300, 10);
    const maxBytes = 400;

    const size = cache.getCacheSize(dir);
    expect(size).toBe(600);
    expect(size > maxBytes).toBe(true);

    const evicted = cache.evictOldest(dir, maxBytes);
    expect(evicted).toBe(1);
    expect(fs.existsSync(path.join(dir, 'old.bin'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'new.bin'))).toBe(true);
    expect(cache.getCacheSize(dir)).toBe(300);
  });

  it('agrees with what evictOldest reduces, for a flat cache directory', () => {
    // The trigger and the eviction have to measure the same thing; a flat
    // directory of cached media is what both actually see in production.
    const dir = makeTmpDir();
    seedFile(dir, 'a.bin', 100, 30);
    seedFile(dir, 'b.bin', 100, 20);
    seedFile(dir, 'c.bin', 100, 10);
    cache.evictOldest(dir, 150);
    expect(cache.getCacheSize(dir)).toBeLessThanOrEqual(150);
  });
});

// ---------------------------------------------------------------------------
// prefetchTracks — S3 key / local path mapping
// ---------------------------------------------------------------------------
describe('prefetchTracks', () => {
  let ensureCached;
  beforeEach(() => {
    s3.S3_ENABLED = true;
    ensureCached = vi.spyOn(s3, 'ensureCached').mockResolvedValue(undefined);
  });

  it('maps every filename to music/processed/<base>.wav (extension swapped)', async () => {
    await cache.prefetchTracks(['song.mp3', 'sub/beat.flac', 'plain.wav'], '/music');
    expect(ensureCached.mock.calls).toEqual([
      ['music/processed/song.wav', path.join('/music', 'processed', 'song.wav')],
      ['music/processed/beat.wav', path.join('/music', 'processed', 'beat.wav')],
      ['music/processed/plain.wav', path.join('/music', 'processed', 'plain.wav')]
    ]);
  });

  it('is a no-op when S3 is disabled', async () => {
    s3.S3_ENABLED = false;
    await cache.prefetchTracks(['song.mp3'], '/music');
    expect(ensureCached).not.toHaveBeenCalled();
  });

  it('is a no-op for empty or missing lists', async () => {
    await cache.prefetchTracks([], '/music');
    await cache.prefetchTracks(null, '/music');
    expect(ensureCached).not.toHaveBeenCalled();
  });

  it('swallows ensureCached rejections and keeps prefetching the rest', async () => {
    ensureCached
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(undefined);
    await expect(cache.prefetchTracks(['bad.mp3', 'good.mp3'], '/music')).resolves.toBeUndefined();
    expect(ensureCached).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('prefetch track failed: bad: network down')
    );
  });
});

// ---------------------------------------------------------------------------
// prefetchVideos — S3 key / local path mapping
// ---------------------------------------------------------------------------
describe('prefetchVideos', () => {
  let ensureCached;
  beforeEach(() => {
    s3.S3_ENABLED = true;
    ensureCached = vi.spyOn(s3, 'ensureCached').mockResolvedValue(undefined);
  });

  it('maps basenames to visuals/processed/<name> -> <visualsDir>/.processed/<name>', async () => {
    await cache.prefetchVideos(['clip.mp4', '../../etc/evil.mp4'], '/visuals');
    expect(ensureCached.mock.calls).toEqual([
      ['visuals/processed/clip.mp4', path.join('/visuals', '.processed', 'clip.mp4')],
      ['visuals/processed/evil.mp4', path.join('/visuals', '.processed', 'evil.mp4')]
    ]);
  });

  it('is a no-op when S3 is disabled', async () => {
    s3.S3_ENABLED = false;
    await cache.prefetchVideos(['clip.mp4'], '/visuals');
    expect(ensureCached).not.toHaveBeenCalled();
  });

  it('is a no-op for empty or missing lists', async () => {
    await cache.prefetchVideos([], '/visuals');
    await cache.prefetchVideos(undefined, '/visuals');
    expect(ensureCached).not.toHaveBeenCalled();
  });

  it('swallows ensureCached rejections and keeps prefetching the rest', async () => {
    ensureCached
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    await expect(cache.prefetchVideos(['bad.mp4', 'good.mp4'], '/visuals')).resolves.toBeUndefined();
    expect(ensureCached).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('prefetch video failed: bad.mp4: boom')
    );
  });
});

// ---------------------------------------------------------------------------
// isLocallyAvailable
// ---------------------------------------------------------------------------
describe('isLocallyAvailable', () => {
  it('mirrors fs.existsSync for the given path', () => {
    const dir = makeTmpDir();
    const fp = seedFile(dir, 'present.bin', 10, 1);
    expect(cache.isLocallyAvailable(fp)).toBe(true);
    expect(cache.isLocallyAvailable(path.join(dir, 'absent.bin'))).toBe(false);
  });
});
