const fs = require('fs');
const path = require('path');
const s3 = require('./s3');

/**
 * Regular files under `dir`, with the stat fields the cache logic needs.
 *
 * One lister for both callers, because they have to agree: server.js decides
 * whether to evict from getCacheSize and then lets evictOldest work out its own
 * total. If those two counted differently, the trigger and the thing it
 * triggers would be measuring different numbers.
 *
 * Options mirror what each caller means. getCacheSize walks the whole tree and
 * counts everything, matching what `du` reported; evictOldest stays at the top
 * level and skips dotfiles, because those are the only files it can delete.
 */
function listFiles(dir, { recursive = false, skipDotfiles = false } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (skipDotfiles && entry.name.startsWith('.')) continue;
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) files.push(...listFiles(fp, { recursive, skipDotfiles }));
      continue;
    }
    // Symlinks are skipped rather than followed: du -sb did not add the target
    // twice, and following them could leave the cache directory entirely.
    if (!entry.isFile()) continue;
    try {
      const stat = fs.statSync(fp);
      files.push({ path: fp, name: entry.name, atime: stat.atimeMs, size: stat.size });
    } catch (e) {}
  }
  return files;
}

/**
 * Total bytes of cached content under `dir`.
 *
 * Was `du -sb`, which busybox does not support — alpine's du has no -b, so the
 * shell-out failed on every call in the shipped image, the catch returned 0,
 * and the eviction it gates therefore NEVER ran. Same intent, computed in
 * process: the apparent size of every regular file in the tree.
 *
 * Two harmless differences from du: directory inodes themselves are not counted
 * (du adds a block per directory, noise at the MB/GB scale this guards), and
 * symlinks are not followed.
 */
function getCacheSize(dir) {
  return listFiles(dir, { recursive: true })
    .reduce((sum, f) => sum + f.size, 0);
}

// LRU eviction — delete files by atime while size > maxBytes
function evictOldest(dir, maxBytes) {
  if (!fs.existsSync(dir)) return 0;
  const files = listFiles(dir, { skipDotfiles: true });
  // Sort by atime (oldest first)
  files.sort((a, b) => a.atime - b.atime);

  let currentSize = files.reduce((sum, f) => sum + f.size, 0);
  let evicted = 0;
  for (const f of files) {
    if (currentSize <= maxBytes) break;
    try {
      fs.unlinkSync(f.path);
      currentSize -= f.size;
      evicted++;
      console.log(`[cache] evicted ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`);
    } catch (e) {}
  }
  return evicted;
}

// Batch prefetch audio files
async function prefetchTracks(filenames, musicDir) {
  if (!s3.S3_ENABLED || !filenames || filenames.length === 0) return;
  const processedDir = path.join(musicDir, 'processed');
  for (const filename of filenames) {
    const base = path.basename(filename, path.extname(filename));
    const localPath = path.join(processedDir, base + '.wav');
    const s3Key = `music/processed/${base}.wav`;
    try {
      await s3.ensureCached(s3Key, localPath);
    } catch (e) {
      console.error(`[cache] prefetch track failed: ${base}: ${e.message}`);
    }
  }
}

// Batch prefetch video files (processed)
async function prefetchVideos(filenames, visualsDir) {
  if (!s3.S3_ENABLED || !filenames || filenames.length === 0) return;
  const processedDir = path.join(visualsDir, '.processed');
  for (const filename of filenames) {
    const name = path.basename(filename);
    const localPath = path.join(processedDir, name);
    const s3Key = `visuals/processed/${name}`;
    try {
      await s3.ensureCached(s3Key, localPath);
    } catch (e) {
      console.error(`[cache] prefetch video failed: ${name}: ${e.message}`);
    }
  }
}

function isLocallyAvailable(filePath) {
  return fs.existsSync(filePath);
}

module.exports = {
  getCacheSize, evictOldest,
  prefetchTracks, prefetchVideos,
  isLocallyAvailable
};
