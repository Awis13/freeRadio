const fs = require('fs');
const path = require('path');

/**
 * Shared read/write for the JSON files under SHARED_DIR.
 *
 * Two problems this exists to fix, both real data-loss paths:
 *
 *   1. Most stores write with a bare fs.writeFileSync, so a crash mid-write
 *      leaves a truncated file. writeStore() uses the tmp-and-rename pattern
 *      streamControl.js/liveMode.js/visualMode.js/restreamSettings.js already
 *      use: rename(2) is atomic within a filesystem, so a reader sees either
 *      the old file or the new one, never a partial one. The tmp file is a
 *      SIBLING of the target — renaming across devices fails.
 *
 *   2. Every loader catches a parse failure and returns defaults, so a
 *      corrupted file silently becomes an empty playlist/schedule and the
 *      damage is invisible. readStore() still returns the defaults — callers
 *      depend on never seeing an exception — but it QUARANTINES the bad file
 *      first, renaming it to <file>.corrupt-<timestamp> and logging loudly.
 *      The evidence survives, and because the original path is now missing
 *      rather than present-but-broken, syncWatcher's restore can heal it from
 *      S3 (its restore skips files that exist and are non-empty).
 *
 * Everything here is synchronous, matching every store it replaces. Callers
 * pass absolute paths (composed via paths.js); this module never builds one.
 */

/**
 * Move a file that failed to parse aside, so it is neither read again nor
 * silently overwritten. Returns the quarantine path, or null if it could not
 * be moved (a read-only mount, say) — in which case the caller still gets
 * defaults, which is exactly the old behaviour.
 */
function quarantine(file) {
  const base = `${file}.corrupt-${Date.now()}`;
  // Two corruptions inside the same millisecond must not overwrite each other.
  let target = base;
  let n = 1;
  while (fs.existsSync(target)) {
    target = `${base}-${n}`;
    n++;
  }
  try {
    fs.renameSync(file, target);
    return target;
  } catch (e) {
    console.error(`[jsonStore] could not quarantine ${file}: ${e.message}`);
    return null;
  }
}

/**
 * Read and parse `file`. Missing file or unreadable/unparseable content both
 * yield `defaults`; the unparseable case quarantines first. Never throws.
 */
function readStore(file, defaults) {
  let raw;
  try {
    if (!fs.existsSync(file)) return defaults;
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // Present but unreadable (permissions, a directory in its place): leave it
    // alone — quarantining would not help and might destroy a mount point.
    console.error(`[jsonStore] could not read ${file}: ${e.message}`);
    return defaults;
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    const moved = quarantine(file);
    console.error(
      `[jsonStore] ${file} is not valid JSON (${e.message}) — ` +
      (moved ? `quarantined as ${moved}; ` : 'could not quarantine it; ') +
      'returning defaults',
    );
    return defaults;
  }
}

/**
 * Write `data` as JSON to `file` atomically.
 *
 * `indent` matches what each store already produces: 2 for the human-edited
 * config files, 0 for the compact machine-written ones. Errors propagate, as
 * they do from the fs.writeFileSync calls this replaces.
 */
function writeStore(file, data, { indent = 2 } = {}) {
  const payload = JSON.stringify(data, null, indent);
  const tmpFile = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmpFile, payload);
  fs.renameSync(tmpFile, file);
  return data;
}

module.exports = { readStore, writeStore };
