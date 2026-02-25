const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const s3 = require('./s3');

const MUSIC_DIR = process.env.MUSIC_DIR || '/music';
const VISUALS_DIR = process.env.VISUALS_DIR || '/visuals';
const SHARED_DIR = '/shared';

// 17 конфиг-файлов для бэкапа в S3
const CONFIG_FILES = [
  'playlists.json', 'schedule.json', 'track_metadata.json', 'play_history.jsonl',
  'visual_profiles.json', 'active_visual_profile.json', 'overlays.json',
  'stream_keys.enc', 'stream_quality.json', 'stream_audio.json', 'stream_video.json',
  'stream_control.json', 'restream_settings.json', 'live_mode.json', 'visual_mode.json',
  'channel_strip.json', 'video_playlists.json'
];

// Метаданные от audio-analyzer
const METADATA_FILES = [
  { local: path.join(MUSIC_DIR, '.analysis_map'), s3Key: 'music/.analysis_map' },
  { local: path.join(MUSIC_DIR, '.bpm_map'), s3Key: 'music/.bpm_map' }
];

// Директории с processed файлами
const PROCESSED_DIRS = [
  { local: path.join(MUSIC_DIR, 'processed'), s3Prefix: 'music/processed/', ext: /\.(wav|mp3|flac)$/i },
  { local: path.join(VISUALS_DIR, '.processed'), s3Prefix: 'visuals/processed/', ext: /\.(mp4|mov|mkv)$/i }
];

// Пропускаемые файлы
const SKIP_PATTERN = /^(\.transcoding_|_standby_|.*\.s3tmp$)/;

// In-memory state
const _knownUploaded = new Set();
const _hashes = new Map();
let _timers = [];

// --- Helpers ---

function md5(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

function fileHash(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    return md5(data);
  } catch (e) {
    return null;
  }
}

function listLocalFiles(dir, extPattern) {
  try {
    return fs.readdirSync(dir).filter(f =>
      extPattern.test(f) && !SKIP_PATTERN.test(f)
    );
  } catch (e) {
    return [];
  }
}

// --- Init: restore конфигов из S3 + snapshot хэшей ---

async function init() {
  if (!s3.S3_ENABLED) return;
  console.log('[syncWatcher] initializing...');

  // Restore конфигов из S3
  await restoreConfigs();

  // Snapshot текущих хэшей (чтобы первый poll не перезалил всё)
  for (const name of CONFIG_FILES) {
    const h = fileHash(path.join(SHARED_DIR, name));
    if (h) _hashes.set('config/' + name, h);
  }
  for (const meta of METADATA_FILES) {
    const h = fileHash(meta.local);
    if (h) _hashes.set(meta.s3Key, h);
  }

  // Первый скан processed файлов — заполнить _knownUploaded через s3.list()
  for (const pd of PROCESSED_DIRS) {
    try {
      const objects = await s3.list(pd.s3Prefix);
      for (const obj of objects) {
        _knownUploaded.add(obj.key);
      }
    } catch (e) {
      console.error(`[syncWatcher] init list ${pd.s3Prefix}: ${e.message}`);
    }
    // Также добавить все локальные файлы, которые уже есть в S3
    const localFiles = listLocalFiles(pd.local, pd.ext);
    for (const f of localFiles) {
      const key = pd.s3Prefix + f;
      if (_knownUploaded.has(key)) continue;
      // Файл есть локально, но нет в S3 — не добавляем в known, будет загружен
    }
  }

  console.log(`[syncWatcher] initialized: ${_knownUploaded.size} known S3 objects, ${_hashes.size} config hashes`);
}

// --- Restore: скачать конфиги/метаданные из S3 если нет локально ---

async function restoreConfigs() {
  let restored = 0;

  // Конфиги
  for (const name of CONFIG_FILES) {
    const localPath = path.join(SHARED_DIR, name);
    if (fs.existsSync(localPath)) continue;
    try {
      await s3.download('config/' + name, localPath);
      restored++;
    } catch (e) {
      // Нормально — файл может не существовать в S3 (новый tenant)
      if (e.name !== 'NoSuchKey' && e.$metadata?.httpStatusCode !== 404) {
        console.error(`[syncWatcher] restore config ${name}: ${e.message}`);
      }
    }
  }

  // Overlay assets
  try {
    const assets = await s3.list('config/overlay_assets/');
    const assetsDir = path.join(SHARED_DIR, 'overlay_assets');
    for (const obj of assets) {
      const filename = path.basename(obj.key);
      if (!filename) continue;
      const localPath = path.join(assetsDir, filename);
      if (fs.existsSync(localPath)) continue;
      try {
        await s3.download(obj.key, localPath);
        restored++;
      } catch (e) {
        console.error(`[syncWatcher] restore overlay asset ${filename}: ${e.message}`);
      }
    }
  } catch (e) {
    // S3 list может упасть — не критично
  }

  // Метаданные
  for (const meta of METADATA_FILES) {
    if (fs.existsSync(meta.local)) continue;
    try {
      await s3.download(meta.s3Key, meta.local);
      restored++;
    } catch (e) {
      if (e.name !== 'NoSuchKey' && e.$metadata?.httpStatusCode !== 404) {
        console.error(`[syncWatcher] restore metadata ${meta.s3Key}: ${e.message}`);
      }
    }
  }

  if (restored > 0) console.log(`[syncWatcher] restored ${restored} files from S3`);
}

// --- Poll: processed файлы → S3 ---

async function pollProcessed() {
  for (const pd of PROCESSED_DIRS) {
    const files = listLocalFiles(pd.local, pd.ext);
    for (const f of files) {
      const key = pd.s3Prefix + f;
      if (_knownUploaded.has(key)) continue;
      try {
        await s3.upload(path.join(pd.local, f), key);
        _knownUploaded.add(key);
      } catch (e) {
        console.error(`[syncWatcher] upload processed ${key}: ${e.message}`);
      }
    }
  }
}

// --- Poll: метаданные → S3 ---

async function pollMetadata() {
  for (const meta of METADATA_FILES) {
    const h = fileHash(meta.local);
    if (!h) continue;
    if (_hashes.get(meta.s3Key) === h) continue;
    try {
      await s3.upload(meta.local, meta.s3Key);
      _hashes.set(meta.s3Key, h);
    } catch (e) {
      console.error(`[syncWatcher] upload metadata ${meta.s3Key}: ${e.message}`);
    }
  }
}

// --- Poll: конфиги → S3 ---

async function pollConfigs() {
  for (const name of CONFIG_FILES) {
    const localPath = path.join(SHARED_DIR, name);
    const hashKey = 'config/' + name;
    const h = fileHash(localPath);
    if (!h) continue;
    if (_hashes.get(hashKey) === h) continue;
    try {
      await s3.upload(localPath, 'config/' + name);
      _hashes.set(hashKey, h);
    } catch (e) {
      console.error(`[syncWatcher] upload config ${name}: ${e.message}`);
    }
  }

  // Overlay assets
  const assetsDir = path.join(SHARED_DIR, 'overlay_assets');
  if (fs.existsSync(assetsDir)) {
    try {
      const assets = fs.readdirSync(assetsDir).filter(f => !f.startsWith('.'));
      for (const f of assets) {
        const localPath = path.join(assetsDir, f);
        const hashKey = 'config/overlay_assets/' + f;
        const h = fileHash(localPath);
        if (!h) continue;
        if (_hashes.get(hashKey) === h) continue;
        try {
          await s3.upload(localPath, 'config/overlay_assets/' + f);
          _hashes.set(hashKey, h);
        } catch (e) {
          console.error(`[syncWatcher] upload overlay asset ${f}: ${e.message}`);
        }
      }
    } catch (e) {}
  }
}

// --- Start/Stop ---

function start() {
  if (!s3.S3_ENABLED) return;
  _timers.push(setInterval(() => pollProcessed().catch(e => console.error('[syncWatcher] processed poll error:', e.message)), 30000));
  _timers.push(setInterval(() => pollMetadata().catch(e => console.error('[syncWatcher] metadata poll error:', e.message)), 60000));
  _timers.push(setInterval(() => pollConfigs().catch(e => console.error('[syncWatcher] config poll error:', e.message)), 30000));
  console.log('[syncWatcher] polling started (processed: 30s, metadata: 60s, configs: 30s)');
}

function stop() {
  for (const t of _timers) clearInterval(t);
  _timers = [];
  console.log('[syncWatcher] stopped');
}

module.exports = { init, start, stop, restoreConfigs };
