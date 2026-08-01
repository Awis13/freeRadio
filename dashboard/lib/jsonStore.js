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
/** How many suffixed names to try before giving up on quarantining. */
const MAX_QUARANTINE_ATTEMPTS = 50;

/**
 * Pick a free `<file>.corrupt-<ts>` name, or null if one cannot be found.
 *
 * The search is BOUNDED. An earlier version looped until existsSync said no,
 * which never terminates if existsSync keeps saying yes — it took a whole test
 * worker down with an out-of-memory abort. Fifty collisions would mean fifty
 * corruptions of the same file inside one millisecond; past that, skipping the
 * quarantine is far better than hanging the caller.
 */
function quarantineTarget(file) {
  const base = `${file}.corrupt-${Date.now()}`;
  if (!fs.existsSync(base)) return base;
  for (let n = 1; n <= MAX_QUARANTINE_ATTEMPTS; n++) {
    const candidate = `${base}-${n}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function quarantine(file) {
  const target = quarantineTarget(file);
  if (!target) {
    console.error(`[jsonStore] could not find a free quarantine name for ${file}`);
    return null;
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
 * Does the parsed document match the shape the caller declared via `defaults`?
 *
 * This is not type pedantry — it decides whether the CALLER will crash. `null`
 * throws on any property access, and several stores dereference two levels
 * (`data.playlists[id]`, `data.tracks[name]`), so a top-level string, number or
 * array throws there too: `"abc".playlists` is undefined, and indexing that
 * undefined is a TypeError escaping as a 500. Those dereferences used to sit
 * inside each store's own try/catch, which the migration to this module removes.
 *
 * So: a document whose top-level type contradicts the defaults is treated as
 * corrupt. When the caller passes null/undefined defaults it is claiming no
 * shape, and scalars are handed back as before — one-level access on them
 * yields undefined, which every such store already falls back on.
 */
function shapeMatches(parsed, defaults) {
  if (parsed === null) return false;
  if (defaults === null || defaults === undefined) return true;
  if (typeof defaults !== 'object') return true;
  if (typeof parsed !== 'object') return false;
  return Array.isArray(parsed) === Array.isArray(defaults);
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

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return quarantineAndDefault(file, defaults, `not valid JSON (${e.message})`);
  }

  if (!shapeMatches(parsed, defaults)) {
    return quarantineAndDefault(file, defaults, `parsed as ${describe(parsed)}, which callers cannot use`);
  }
  return parsed;
}

/** Human-readable type for the log line. */
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function quarantineAndDefault(file, defaults, reason) {
  const moved = quarantine(file);
  console.error(
    `[jsonStore] ${file} ${reason} — ` +
    (moved ? `quarantined as ${moved}; ` : 'could not quarantine it; ') +
    'returning defaults',
  );
  return defaults;
}

/**
 * Write `data` as JSON to `file` atomically.
 *
 * `indent` matches what each store already produces: 2 for the human-edited
 * config files, 0 for the compact machine-written ones. Errors propagate, as
 * they do from the fs.writeFileSync calls this replaces.
 *
 * If the rename fails the `<file>.tmp` is deliberately left behind: the target
 * still holds the previous document, and the tmp file is the only copy of the
 * write that did not land — deleting it would destroy the evidence and the data.
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
