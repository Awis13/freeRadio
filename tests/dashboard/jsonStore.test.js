/**
 * tests/dashboard/jsonStore.test.js
 *
 * Tests dashboard/lib/jsonStore.js — the atomic read/write helper the JSON
 * stores converge on in C2.
 *
 * REAL filesystem, not an fs mock: what is being tested is atomicity and
 * quarantine, i.e. exactly the behaviour of rename(2) and of files left on
 * disk. A mocked fs would only prove that the module calls the functions the
 * test told it to expect. Each test gets its own mkdtemp directory.
 *
 * The quarantine name embeds Date.now(), so the assertions match the
 * <file>.corrupt-<digits> shape rather than a literal timestamp.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const { readStore, writeStore } = nodeRequire('../../dashboard/lib/jsonStore');

let dir;
let errors;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstore-'));
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((msg) => { errors.push(String(msg)); });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Files left in the temp dir, for asserting what a failed write did or did not leave. */
function listDir() {
  return fs.readdirSync(dir).sort();
}

describe('readStore', () => {
  it('returns the parsed contents of a healthy file', () => {
    const file = path.join(dir, 'playlists.json');
    fs.writeFileSync(file, JSON.stringify({ playlists: [{ id: 'a' }] }));
    expect(readStore(file, { playlists: [] })).toEqual({ playlists: [{ id: 'a' }] });
    expect(errors).toEqual([]);
  });

  it('returns defaults when the file does not exist, and creates nothing', () => {
    const file = path.join(dir, 'missing.json');
    const defaults = { tier: 'free' };
    expect(readStore(file, defaults)).toBe(defaults);
    expect(listDir()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('quarantines an unparseable file: content preserved, defaults returned, logged', () => {
    const file = path.join(dir, 'schedule.json');
    fs.writeFileSync(file, '{"slots": [truncated');

    const defaults = { slots: [] };
    expect(readStore(file, defaults)).toBe(defaults);

    // Original path is now free — which is what lets syncWatcher restore it.
    expect(fs.existsSync(file)).toBe(false);

    const quarantined = listDir();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatch(/^schedule\.json\.corrupt-\d+$/);
    // The damaged bytes survive verbatim for diagnosis.
    expect(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8')).toBe('{"slots": [truncated');

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('not valid JSON');
    expect(errors[0]).toContain('quarantined as');
  });

  it('does not quarantine an empty file silently — empty is invalid JSON too', () => {
    const file = path.join(dir, 'truncated.json');
    fs.writeFileSync(file, '');
    expect(readStore(file, { a: 1 })).toEqual({ a: 1 });
    expect(listDir()).toEqual([expect.stringMatching(/^truncated\.json\.corrupt-\d+$/)]);
  });

  it('two corruptions of the same file do not overwrite each other', () => {
    const file = path.join(dir, 'quality.json');

    fs.writeFileSync(file, 'first-corruption');
    readStore(file, {});
    fs.writeFileSync(file, 'second-corruption');
    readStore(file, {});

    const quarantined = listDir();
    expect(quarantined).toHaveLength(2);
    const contents = quarantined.map(n => fs.readFileSync(path.join(dir, n), 'utf8')).sort();
    expect(contents).toEqual(['first-corruption', 'second-corruption']);
  });

  it('treats a file containing null as corrupt — it is what makes callers throw', () => {
    // JSON.parse('null') succeeds, so this file is "valid JSON" — but every
    // store dereferences the result, and null.tier is a TypeError that would
    // escape as a 500 now that the stores' own try/catch is gone.
    const file = path.join(dir, 'tier.json');
    fs.writeFileSync(file, 'null');

    const defaults = { tier: 'free' };
    expect(readStore(file, defaults)).toBe(defaults);
    expect(listDir()).toEqual([expect.stringMatching(/^tier\.json\.corrupt-\d+$/)]);
    expect(errors[0]).toContain('parsed as null');
  });

  it('quarantines a top-level type that contradicts the defaults', () => {
    // "abc".playlists is undefined, and playlist.js then indexes it —
    // data.playlists[id] is a TypeError one level deeper than null.
    const file = path.join(dir, 'playlists.json');
    fs.writeFileSync(file, '"just a string"');
    expect(readStore(file, { playlists: {} })).toEqual({ playlists: {} });
    expect(errors[0]).toContain('parsed as a string');

    // An array where an object is expected breaks the same dereference.
    const arrayFile = path.join(dir, 'schedule.json');
    fs.writeFileSync(arrayFile, '[]');
    expect(readStore(arrayFile, { weekly: {} })).toEqual({ weekly: {} });
  });

  it('accepts a scalar when the caller declares no shape', () => {
    // Stores that pass null defaults check truthiness before dereferencing, so
    // a scalar is handed back exactly as it was before this module existed.
    const file = path.join(dir, 'loose.json');
    fs.writeFileSync(file, '"a string"');
    expect(readStore(file, null)).toBe('a string');
    expect(listDir()).toEqual(['loose.json']);
    expect(errors).toEqual([]);
  });

  it('accepts an array when the defaults are an array', () => {
    const file = path.join(dir, 'list.json');
    fs.writeFileSync(file, '[1,2,3]');
    expect(readStore(file, [])).toEqual([1, 2, 3]);
    expect(errors).toEqual([]);
  });

  it('gives up on the quarantine name instead of looping when every name is taken', () => {
    // Regression: the collision search used to loop until existsSync said no,
    // so an existsSync that always says yes spun until the process died of an
    // out-of-memory abort. It must terminate and fall back to "not quarantined".
    const file = path.join(dir, 'stuck.json');
    fs.writeFileSync(file, 'not json');
    let existsCalls = 0;
    vi.spyOn(fs, 'existsSync').mockImplementation(() => { existsCalls++; return true; });

    const defaults = { ok: true };
    expect(readStore(file, defaults)).toBe(defaults);

    expect(existsCalls).toBeLessThan(100);
    expect(errors.some(e => e.includes('could not find a free quarantine name'))).toBe(true);
  });

  it('still returns defaults when the corrupt file cannot be moved aside', () => {
    // Read-only mount, no permission on the directory: quarantine fails, but a
    // caller asking for its config must still get one rather than an exception.
    const file = path.join(dir, 'overlays.json');
    fs.writeFileSync(file, 'not json at all');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
    });

    const defaults = { enabled: false, layers: [] };
    expect(readStore(file, defaults)).toBe(defaults);

    // The damaged file is left exactly where it was — nothing was destroyed.
    expect(fs.readFileSync(file, 'utf8')).toBe('not json at all');
    expect(errors.some(e => e.includes('could not quarantine'))).toBe(true);
    expect(errors.some(e => e.includes('not valid JSON'))).toBe(true);
  });

  it('returns defaults without quarantining when the path is unreadable', () => {
    // A directory where a file is expected: readFileSync throws EISDIR. Moving
    // it aside would be worse than leaving it, so it must survive.
    const file = path.join(dir, 'weird.json');
    fs.mkdirSync(file);
    expect(readStore(file, { ok: true })).toEqual({ ok: true });
    expect(fs.existsSync(file)).toBe(true);
    expect(listDir()).toEqual(['weird.json']);
    expect(errors[0]).toContain('could not read');
  });
});

describe('writeStore', () => {
  it('round-trips through readStore', () => {
    const file = path.join(dir, 'store.json');
    writeStore(file, { a: 1, b: ['x'] });
    expect(readStore(file, {})).toEqual({ a: 1, b: ['x'] });
  });

  it('defaults to 2-space JSON and writes compact when asked', () => {
    const pretty = path.join(dir, 'pretty.json');
    const compact = path.join(dir, 'compact.json');
    writeStore(pretty, { a: 1 });
    writeStore(compact, { a: 1 }, { indent: 0 });
    // The stores being migrated produce exactly these two shapes today.
    expect(fs.readFileSync(pretty, 'utf8')).toBe('{\n  "a": 1\n}');
    expect(fs.readFileSync(compact, 'utf8')).toBe('{"a":1}');
  });

  it('creates the parent directory when missing', () => {
    const file = path.join(dir, 'nested', 'deeper', 'store.json');
    writeStore(file, { ok: true });
    expect(readStore(file, {})).toEqual({ ok: true });
  });

  it('leaves no tmp file behind on success', () => {
    const file = path.join(dir, 'store.json');
    writeStore(file, { a: 1 });
    expect(listDir()).toEqual(['store.json']);
  });

  it('consecutive writes each land whole', () => {
    const file = path.join(dir, 'store.json');
    for (let i = 0; i < 5; i++) writeStore(file, { n: i });
    expect(readStore(file, {})).toEqual({ n: 4 });
    expect(listDir()).toEqual(['store.json']);
  });

  it('torn write: an interrupted rename leaves the previous contents intact', () => {
    const file = path.join(dir, 'playlists.json');
    writeStore(file, { playlists: ['original'] });

    const realRename = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO: simulated crash between write and rename'), { code: 'EIO' });
    });

    expect(() => writeStore(file, { playlists: ['replacement'] })).toThrow('simulated crash');

    // The point of the pattern: the target still holds the OLD document, whole
    // and parseable — never a half-written one.
    expect(readStore(file, { playlists: [] })).toEqual({ playlists: ['original'] });
    expect(errors).toEqual([]);

    // The new content is sitting in the sibling tmp file, not in the target.
    spy.mockImplementation(realRename);
    expect(listDir()).toEqual(['playlists.json', 'playlists.json.tmp']);
    expect(JSON.parse(fs.readFileSync(`${file}.tmp`, 'utf8'))).toEqual({ playlists: ['replacement'] });
  });

  it('writes the tmp file as a sibling, so rename never crosses filesystems', () => {
    const file = path.join(dir, 'store.json');
    const real = fs.writeFileSync;
    const seen = [];
    vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
      seen.push(p);
      return real(p, data);
    });

    writeStore(file, { a: 1 });

    expect(seen).toHaveLength(1);
    expect(path.dirname(seen[0])).toBe(path.dirname(file));
    // The write must go to the tmp file, never straight at the target —
    // without this the test passes even if the atomic step is removed.
    expect(seen[0]).not.toBe(file);
    expect(seen[0]).toBe(`${file}.tmp`);
    expect(readStore(file, {})).toEqual({ a: 1 });
  });
});
