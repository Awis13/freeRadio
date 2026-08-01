const path = require('path');

/**
 * Single source of truth for the filesystem locations and service host the
 * dashboard runs against.
 *
 * These values are hardcoded across ~25 files today, and inconsistently: some
 * read process.env (server.js, status.js, syncWatcher.js), some hardcode the
 * same literal the env is supposed to control (schedule.js MUSIC_DIR,
 * queue.js toProcessedPath, track.js analysis map, boot.js dj host). This
 * module holds one definition of each so callers stop disagreeing.
 *
 * Defaults reproduce today's hardcoded values exactly, so with no env set
 * nothing moves. Env is read once at require time, matching how liqClient.js,
 * syncWatcher.js and s3.js already do it — a process that wants different
 * paths sets them before boot, not per call. Tests that need other values
 * re-require this module with the cache evicted (see tests/dashboard/paths.test.js).
 */

// --- Directories -----------------------------------------------------------

/** Shared state directory: json stores, txt handoff files, overlay assets. */
const SHARED_DIR = process.env.SHARED_DIR || '/shared';

/** Music library root (raw uploads live directly under it). */
const MUSIC_DIR = process.env.MUSIC_DIR || '/music';

/**
 * Transcoder output directory.
 *
 * Derived from MUSIC_DIR rather than hardcoded, which is the fix for the
 * split this module exists to close: schedule.js and queue.js hardcode
 * '/music/processed' while the rest of the app honours MUSIC_DIR, so setting
 * MUSIC_DIR today moves the library but not the processed files. With no env
 * set the value is byte-identical to the old literal.
 */
const PROCESSED_DIR = process.env.PROCESSED_DIR || path.join(MUSIC_DIR, 'processed');

/** Video/visual assets root. */
const VISUALS_DIR = process.env.VISUALS_DIR || '/visuals';

/** HLS segment output directory served to players. */
const HLS_DIR = process.env.HLS_DIR || '/hls';

// --- Files -----------------------------------------------------------------

/**
 * The hls.js bundle. Fetched into the image at build time (see
 * dashboard/Dockerfile) rather than vendored in the repo, so it lives outside
 * the app directory tree and cannot be resolved relative to a source file.
 */
const HLS_JS_PATH = process.env.HLS_JS_PATH || '/app/hls.min.js';

/** Track analysis map written by the analyzer next to the music library. */
const ANALYSIS_MAP = process.env.ANALYSIS_MAP || path.join(MUSIC_DIR, '.analysis_map');

// --- Liquidsoap service ----------------------------------------------------

/** Defaults match the docker-compose `dj` service. */
const DJ_HOST = process.env.DJ_HOST || 'dj';
const DJ_PORT = parseInt(process.env.DJ_PORT || '7000', 10);

// --- Joiners ---------------------------------------------------------------
//
// The ~30 distinct /shared/<file> literals are each used once or twice, so
// they are composed at the call site instead of being enumerated here: one
// name per store would make this module a second place to edit every time a
// file is added.

/** Path inside SHARED_DIR, e.g. shared('tier.json'). */
function shared(...segments) {
  return path.join(SHARED_DIR, ...segments);
}

/** Path inside MUSIC_DIR. */
function music(...segments) {
  return path.join(MUSIC_DIR, ...segments);
}

/** Path inside PROCESSED_DIR, e.g. processed(`${base}.wav`). */
function processed(...segments) {
  return path.join(PROCESSED_DIR, ...segments);
}

/** Path inside VISUALS_DIR. */
function visuals(...segments) {
  return path.join(VISUALS_DIR, ...segments);
}

module.exports = {
  SHARED_DIR, MUSIC_DIR, PROCESSED_DIR, VISUALS_DIR, HLS_DIR,
  HLS_JS_PATH, ANALYSIS_MAP,
  DJ_HOST, DJ_PORT,
  shared, music, processed, visuals
};
