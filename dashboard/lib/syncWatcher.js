const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const s3 = require('./s3');

const MUSIC_DIR = process.env.MUSIC_DIR || '/music';
const VISUALS_DIR = process.env.VISUALS_DIR || '/visuals';
const SHARED_DIR = '/shared';

// 17 config files to back up to S3
const CONFIG_FILES = [
  'playlists.json', 'schedule.json', 'track_metadata.json', 'play_history.jsonl',
  'visual_profiles.json', 'active_visual_profile.json', 'overlays.json',
  'stream_keys.enc', 'stream_quality.json', 'stream_audio.json', 'stream_video.json',
  'stream_control.json', 'restream_settings.json', 'live_mode.json', 'visual_mode.json',
  'channel_strip.json', 'video_playlists.json'
];

// Large append-only files — stat-based detection instead of full hash
const STAT_BASED_FILES = new Set(['play_history.jsonl']);

// Metadata from audio-analyzer
const METADATA_FILES = [
  { local: path.join(MUSIC_DIR, '.analysis_map'), s3Key: 'music/.analysis_map' },
  { local: path.join(MUSIC_DIR, '.bpm_map'), s3Key: 'music/.bpm_map' }
];

// Directories with processed files
const PROCESSED_DIRS = [
  { local: path.join(MUSIC_DIR, 'processed'), s3Prefix: 'music/processed/', ext: /\.(wav|mp3|flac)$/i },
  { local: path.join(VISUALS_DIR, '.processed'), s3Prefix: 'visuals/processed/', ext: /\.(mp4|mov|mkv)$/i }
];

// Files to skip
const SKIP_PATTERN = /^(\.transcoding_|_standby_|.*\.s3tmp$)/;

// In-memory state
const _knownUploaded = new Set();
const _hashes = new Map();
let _timers = [];

// --- Helpers ---

function md5(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

// Atomic read: read file once, return buffer + hash
function readAndHash(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    return { data, hash: md5(data) };
  } catch (e) {
    return null;
  }
}

// Stat-based change detection (for large files like play_history.jsonl)
function fileSig(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
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

// --- Init: restore configs from S3 + snapshot hashes ---

async function init() {
  if (!s3.S3_ENABLED) return;
  console.log('[syncWatcher] initializing...');

  // Restore configs from S3
  await restoreConfigs();

  // Snapshot current hashes (so first poll doesn't re-upload everything)
  for (const name of CONFIG_FILES) {
    const localPath = path.join(SHARED_DIR, name);
    const hashKey = 'config/' + name;
    if (STAT_BASED_FILES.has(name)) {
      const sig = fileSig(localPath);
      if (sig) _hashes.set(hashKey, sig);
    } else {
      const result = readAndHash(localPath);
      if (result) _hashes.set(hashKey, result.hash);
    }
  }
  for (const meta of METADATA_FILES) {
    const result = readAndHash(meta.local);
    if (result) _hashes.set(meta.s3Key, result.hash);
  }

  // Populate _knownUploaded from S3 listing
  for (const pd of PROCESSED_DIRS) {
    try {
      const objects = await s3.list(pd.s3Prefix);
      for (const obj of objects) {
        _knownUploaded.add(obj.key);
      }
    } catch (e) {
      console.error(`[syncWatcher] init list ${pd.s3Prefix}: ${e.message}`);
    }
  }

  console.log(`[syncWatcher] initialized: ${_knownUploaded.size} known S3 objects, ${_hashes.size} config hashes`);
}

// --- Restore: download configs/metadata from S3 if missing or empty locally ---

async function restoreConfigs() {
  let restored = 0;

  // Configs — restore if missing or empty (crash/power loss)
  for (const name of CONFIG_FILES) {
    const localPath = path.join(SHARED_DIR, name);
    const stat = fs.statSync(localPath, { throwIfNoEntry: false });
    if (stat && stat.size > 0) continue;
    try {
      await s3.download('config/' + name, localPath);
      restored++;
    } catch (e) {
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
    console.error(`[syncWatcher] overlay assets list: ${e.message}`);
  }

  // Metadata — restore if missing or empty
  for (const meta of METADATA_FILES) {
    const stat = fs.statSync(meta.local, { throwIfNoEntry: false });
    if (stat && stat.size > 0) continue;
    try {
      await s3.download(meta.s3Key, meta.local);
      restored++;
    } catch (e) {
      if (e.name !== 'NoSuchKey' && e.$metadata?.httpStatusCode !== 404) {
        console.error(`[syncWatcher] restore metadata ${meta.s3Key}: ${e.message}`);
      }
    }
  }

  // Raw content files — restore music and visuals uploaded via dashboard
  try {
    const musicCount = await s3.syncDir('music/raw/', MUSIC_DIR);
    restored += musicCount;
  } catch (e) {
    console.error(`[syncWatcher] restore music/raw: ${e.message}`);
  }
  try {
    const visualsCount = await s3.syncDir('visuals/incoming/', VISUALS_DIR);
    restored += visualsCount;
  } catch (e) {
    console.error(`[syncWatcher] restore visuals/incoming: ${e.message}`);
  }

  if (restored > 0) console.log(`[syncWatcher] restored ${restored} files from S3`);
}

// --- Poll: processed files -> S3 (upload) + S3 -> local (download new files from transcoder) ---

async function pollProcessed() {
  for (const pd of PROCESSED_DIRS) {
    // Upload: local → S3
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

    // Download: S3 → local (new files from shared transcoder)
    try {
      const remote = await s3.list(pd.s3Prefix);
      for (const obj of remote) {
        const filename = path.basename(obj.key);
        if (!filename || !pd.ext.test(filename)) continue;
        if (SKIP_PATTERN.test(filename)) continue;
        const localPath = path.join(pd.local, filename);
        if (fs.existsSync(localPath)) continue;
        try {
          await s3.download(pd.s3Prefix + filename, localPath);
          _knownUploaded.add(pd.s3Prefix + filename);
        } catch (e) {
          console.error(`[syncWatcher] download processed ${filename}: ${e.message}`);
        }
      }
    } catch (e) {
      console.error(`[syncWatcher] list S3 ${pd.s3Prefix}: ${e.message}`);
    }
  }
}

// --- Poll: metadata -> S3 (atomic: read once -> hash -> upload buffer) ---

async function pollMetadata() {
  for (const meta of METADATA_FILES) {
    const result = readAndHash(meta.local);
    if (!result) continue;
    if (_hashes.get(meta.s3Key) === result.hash) continue;
    try {
      await s3.uploadBuffer(result.data, meta.s3Key);
      _hashes.set(meta.s3Key, result.hash);
    } catch (e) {
      console.error(`[syncWatcher] upload metadata ${meta.s3Key}: ${e.message}`);
    }
  }
}

// --- Poll: configs -> S3 ---

async function pollConfigs() {
  for (const name of CONFIG_FILES) {
    const localPath = path.join(SHARED_DIR, name);
    const hashKey = 'config/' + name;

    if (STAT_BASED_FILES.has(name)) {
      // Large append-only files: stat-based detection + stream upload
      const sig = fileSig(localPath);
      if (!sig) continue;
      if (_hashes.get(hashKey) === sig) continue;
      try {
        await s3.upload(localPath, 'config/' + name);
        _hashes.set(hashKey, sig);
      } catch (e) {
        console.error(`[syncWatcher] upload config ${name}: ${e.message}`);
      }
    } else {
      // Small configs: atomic read -> hash -> upload buffer
      const result = readAndHash(localPath);
      if (!result) continue;
      if (_hashes.get(hashKey) === result.hash) continue;
      try {
        await s3.uploadBuffer(result.data, 'config/' + name);
        _hashes.set(hashKey, result.hash);
      } catch (e) {
        console.error(`[syncWatcher] upload config ${name}: ${e.message}`);
      }
    }
  }

  // Overlay assets
  const assetsDir = path.join(SHARED_DIR, 'overlay_assets');
  try {
    const assets = fs.readdirSync(assetsDir).filter(f => !f.startsWith('.'));
    for (const f of assets) {
      const localPath = path.join(assetsDir, f);
      const hashKey = 'config/overlay_assets/' + f;
      const result = readAndHash(localPath);
      if (!result) continue;
      if (_hashes.get(hashKey) === result.hash) continue;
      try {
        await s3.uploadBuffer(result.data, 'config/overlay_assets/' + f);
        _hashes.set(hashKey, result.hash);
      } catch (e) {
        console.error(`[syncWatcher] upload overlay asset ${f}: ${e.message}`);
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[syncWatcher] overlay assets poll: ${e.message}`);
  }
}

// --- Start/Stop: setTimeout chains (guaranteed non-overlapping) ---

function schedulePoll(fn, interval, label) {
  async function tick() {
    try { await fn(); } catch (e) {
      console.error(`[syncWatcher] ${label} poll error:`, e.message);
    }
    _timers.push(setTimeout(tick, interval));
  }
  _timers.push(setTimeout(tick, interval));
}

function start() {
  if (!s3.S3_ENABLED) return;
  schedulePoll(pollProcessed, 30000, 'processed');
  schedulePoll(pollMetadata, 60000, 'metadata');
  schedulePoll(pollConfigs, 30000, 'configs');
  console.log('[syncWatcher] polling started (processed: 30s, metadata: 60s, configs: 30s)');
}

function stop() {
  for (const t of _timers) clearTimeout(t);
  _timers = [];
  console.log('[syncWatcher] stopped');
}

module.exports = { init, start, stop, restoreConfigs };
