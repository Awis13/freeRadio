const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const s3 = require('./s3');

// Размер директории в байтах
function getCacheSize(dir) {
  try {
    const output = execSync(`du -sb "${dir}" 2>/dev/null`).toString().trim();
    return parseInt(output.split('\t')[0]) || 0;
  } catch (e) {
    return 0;
  }
}

// LRU eviction — удалить файлы по atime пока size > maxBytes
function evictOldest(dir, maxBytes) {
  if (!fs.existsSync(dir)) return 0;
  const files = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const fp = path.join(dir, name);
    try {
      const stat = fs.statSync(fp);
      if (stat.isFile()) files.push({ path: fp, name, atime: stat.atimeMs, size: stat.size });
    } catch (e) {}
  }
  // Сортируем по atime (самые старые первые)
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

// Batch prefetch аудио файлов
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

// Batch prefetch видео файлов (processed)
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
