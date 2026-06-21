/**
 * tests/dashboard/syncWatcher.test.js
 *
 * Characterization of dashboard/lib/syncWatcher.js (P1-4).
 *
 * Strategy: syncWatcher is CJS with module-private state (_hashes,
 * _knownUploaded, _timers) and private poll functions reachable only via
 * the setTimeout chains scheduled by start(). So each test:
 *   1. fresh-requires syncWatcher (cache-deleted) to reset state;
 *   2. controls the s3 layer by spying on the exported functions of the
 *      SAME cached CJS s3 module syncWatcher requires (s3 itself is
 *      loaded with S3 env unset, so its private client can never build —
 *      a missed spy degrades to a no-op, never a network call). init()
 *      and start() read s3.S3_ENABLED as a PROPERTY at call time, so the
 *      tests flip it directly on the exports object;
 *   3. mocks the fs surface syncWatcher touches (existsSync/readFileSync/
 *      statSync/readdirSync/writeFileSync/mkdirSync) over an in-memory
 *      map — a local extension of the helpers.js mockFsMap idea, because
 *      syncWatcher needs statSync (throwIfNoEntry) and readdirSync too;
 *   4. drives the poll chains with vi.useFakeTimers +
 *      advanceTimersByTimeAsync (configs/processed: 30s, metadata: 60s).
 *
 * Pinned here (current behavior, callers depend on it):
 *   - S3 disabled: init() returns before any s3 call; start() schedules
 *     zero timers;
 *   - init() snapshots config/metadata hashes and uploads NOTHING — the
 *     first poll tick after a clean init must not mass-re-upload (THE
 *     tripwire for breaking the snapshot);
 *   - change detection: content change -> exactly one uploadBuffer on
 *     the next configs tick, then silence; metadata maps follow the same
 *     contract on the slower 60s tick; overlay assets are NOT hash-
 *     snapshotted by init, so they re-upload once per process start
 *     (current behavior, pinned deliberately), dotfiles skipped;
 *   - HASH-AFTER-SUCCESS: upload failure leaves the stored hash stale,
 *     so the SAME file is retried next tick until success (THE retry
 *     pin); same contract for the stat-based play_history.jsonl path
 *     (which uses stream s3.upload, not uploadBuffer);
 *   - pollProcessed: _knownUploaded seeded from s3.list at init dedupes
 *     uploads; new local files uploaded once then deduped; failed upload
 *     NOT marked known -> retried; SKIP_PATTERN names (.transcoding_*,
 *     _standby_*, *.s3tmp) never uploaded and never downloaded; download
 *     phase fetches only locally-missing remote files and marks them
 *     known after success;
 *   - schedulePoll: setTimeout CHAIN, next tick armed only after the
 *     poll fn settles -> a poll outliving its interval never overlaps
 *     itself;
 *   - stop(): clears all timers, nothing fires afterwards;
 *   - restoreConfigs(): downloads configs that are missing OR empty
 *     locally, restores missing overlay assets and metadata, syncs raw
 *     dirs; NoSuchKey/404 download failures are swallowed silently.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';

const nodeRequire = createRequire(import.meta.url);
const SW_SPEC = '../../dashboard/lib/syncWatcher';
const S3_SPEC = '../../dashboard/lib/s3';

const ENV_KEYS = [
  'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_REGION',
  'TENANT_ID', 'S3_ENABLED', 'MUSIC_DIR', 'VISUALS_DIR'
];
const ORIGINAL_ENV = {};
for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];

function restoreOriginalEnv() {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function dropModuleCaches() {
  delete nodeRequire.cache[nodeRequire.resolve(SW_SPEC)];
  delete nodeRequire.cache[nodeRequire.resolve(S3_SPEC)];
}

// The 17 config files syncWatcher backs up, mirrored from the module.
const CONFIG_FILES = [
  'playlists.json', 'schedule.json', 'track_metadata.json', 'play_history.jsonl',
  'visual_profiles.json', 'active_visual_profile.json', 'overlays.json',
  'stream_keys.enc', 'stream_quality.json', 'stream_audio.json', 'stream_video.json',
  'stream_control.json', 'restream_settings.json', 'live_mode.json', 'visual_mode.json',
  'channel_strip.json', 'video_playlists.json'
];

/** Seed map with every config + metadata file present and non-empty. */
function allFilesPresent() {
  const files = {};
  for (const name of CONFIG_FILES) files['/shared/' + name] = 'content-of-' + name;
  files['/music/.analysis_map'] = 'analysis-data';
  files['/music/.bpm_map'] = 'bpm-data';
  return files;
}

/**
 * In-memory fs mock over the surface syncWatcher touches. Local
 * extension of helpers.js mockFsMap: adds statSync (honouring
 * throwIfNoEntry) and readdirSync (immediate children, ENOENT when the
 * model has no entries under the dir). Mutate `files`/`stats` in tests.
 */
function mockFs(initialFiles = {}) {
  const files = { ...initialFiles };
  const stats = {}; // path -> { size, mtimeMs } override (stat-based files)
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });

  vi.spyOn(fs, 'existsSync').mockImplementation(p => p in files);
  vi.spyOn(fs, 'readFileSync').mockImplementation(p => {
    if (p in files) return Buffer.from(files[p]);
    throw enoent(p);
  });
  vi.spyOn(fs, 'statSync').mockImplementation((p, opts) => {
    if (!(p in files)) {
      if (opts && opts.throwIfNoEntry === false) return undefined;
      throw enoent(p);
    }
    const ov = stats[p] || {};
    return {
      size: ov.size !== undefined ? ov.size : Buffer.byteLength(files[p]),
      mtimeMs: ov.mtimeMs !== undefined ? ov.mtimeMs : 1000
    };
  });
  vi.spyOn(fs, 'readdirSync').mockImplementation(dir => {
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    const names = new Set();
    for (const p of Object.keys(files)) {
      if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0]);
    }
    if (!names.size) throw enoent(dir);
    return [...names];
  });
  vi.spyOn(fs, 'writeFileSync').mockImplementation((p, d) => { files[p] = d; });
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});

  return { files, stats };
}

/**
 * Fresh s3 module in hard-disabled mode (env cleared before require, so
 * the private client can never build), with the exported S3_ENABLED flag
 * flipped as requested and every function syncWatcher calls stubbed.
 */
function loadS3(enabled = true) {
  for (const k of ENV_KEYS) delete process.env[k];
  delete nodeRequire.cache[nodeRequire.resolve(S3_SPEC)];
  const s3 = nodeRequire(S3_SPEC);
  s3.S3_ENABLED = enabled; // init()/start() read this property at call time
  const noSuchKey = Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
  const stubs = {
    list: vi.spyOn(s3, 'list').mockResolvedValue([]),
    download: vi.spyOn(s3, 'download').mockRejectedValue(noSuchKey),
    upload: vi.spyOn(s3, 'upload').mockResolvedValue(undefined),
    uploadBuffer: vi.spyOn(s3, 'uploadBuffer').mockResolvedValue(undefined),
    syncDir: vi.spyOn(s3, 'syncDir').mockResolvedValue(0)
  };
  return { s3, stubs };
}

/** Fresh syncWatcher require (resets module-private state). */
function freshWatcher() {
  delete nodeRequire.cache[nodeRequire.resolve(SW_SPEC)];
  return nodeRequire(SW_SPEC);
}

/** Drain pending microtasks without advancing fake time. */
async function flushMicrotasks(rounds = 10) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

let sw; // current watcher, stopped in afterEach so no timer chain leaks

describe('dashboard/lib/syncWatcher.js', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sw = null;
  });

  afterEach(() => {
    if (sw) sw.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    dropModuleCaches();
    restoreOriginalEnv();
  });

  afterAll(() => {
    dropModuleCaches();
    restoreOriginalEnv();
  });

  // ─── Disabled mode ───────────────────────────────────────────

  it('S3 disabled: init makes no s3 calls, start schedules nothing', async () => {
    const { stubs } = loadS3(false);
    sw = freshWatcher(); // require BEFORE the fs mock: the CJS loader reads files via fs
    mockFs(allFilesPresent());
    vi.useFakeTimers();

    await sw.init();
    sw.start();

    for (const stub of Object.values(stubs)) expect(stub).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  // ─── Init snapshot (THE mass-re-upload tripwire) ─────────────

  it('init snapshots hashes: first poll ticks upload NOTHING when files are unchanged', async () => {
    const { stubs } = loadS3();
    sw = freshWatcher();
    mockFs(allFilesPresent());
    vi.useFakeTimers();

    await sw.init();
    // init itself uploads nothing.
    expect(stubs.upload).not.toHaveBeenCalled();
    expect(stubs.uploadBuffer).not.toHaveBeenCalled();
    // All files present and non-empty -> restore downloads nothing.
    expect(stubs.download).not.toHaveBeenCalled();

    sw.start();
    // Covers configs (30s), processed (30s) and metadata (60s) ticks.
    await vi.advanceTimersByTimeAsync(60000);

    expect(stubs.upload).not.toHaveBeenCalled();
    expect(stubs.uploadBuffer).not.toHaveBeenCalled();
  });

  // ─── Config change detection ─────────────────────────────────

  it('config content change uploads exactly once, then goes quiet', async () => {
    const { stubs } = loadS3();
    sw = freshWatcher();
    const { files } = mockFs(allFilesPresent());
    vi.useFakeTimers();
    await sw.init();
    sw.start();

    files['/shared/playlists.json'] = 'changed-playlists';
    await vi.advanceTimersByTimeAsync(30000);

    const calls = stubs.uploadBuffer.mock.calls.filter(([, key]) => key === 'config/playlists.json');
    expect(calls).toHaveLength(1);
    expect(calls[0][0].toString()).toBe('changed-playlists');

    await vi.advanceTimersByTimeAsync(60000);
    expect(
      stubs.uploadBuffer.mock.calls.filter(([, key]) => key === 'config/playlists.json')
    ).toHaveLength(1);
    // No collateral uploads of unchanged files either.
    expect(stubs.uploadBuffer).toHaveBeenCalledTimes(1);
    expect(stubs.upload).not.toHaveBeenCalled();
  });

  it('metadata change uploads on the 60s metadata tick, not the 30s one', async () => {
    const { stubs } = loadS3();
    sw = freshWatcher();
    const { files } = mockFs(allFilesPresent());
    vi.useFakeTimers();
    await sw.init();
    sw.start();

    files['/music/.analysis_map'] = 'new-analysis';

    // 30s: configs/processed tick only — metadata poll has not run yet.
    await vi.advanceTimersByTimeAsync(30000);
    expect(stubs.uploadBuffer).not.toHaveBeenCalled();

    // 60s: metadata tick uploads the changed map exactly once.
    await vi.advanceTimersByTimeAsync(30000);
    const calls = stubs.uploadBuffer.mock.calls.filter(([, key]) => key === 'music/.analysis_map');
    expect(calls).toHaveLength(1);
    expect(calls[0][0].toString()).toBe('new-analysis');

    // 120s: hash updated -> quiet.
    await vi.advanceTimersByTimeAsync(60000);
    expect(stubs.uploadBuffer).toHaveBeenCalledTimes(1);
  });

  it('overlay assets: NOT snapshotted by init -> re-uploaded once on the first configs tick; dotfiles skipped', async () => {
    const { stubs } = loadS3();
    sw = freshWatcher();
    const files = allFilesPresent();
    files['/shared/overlay_assets/logo.png'] = 'png-bytes';
    files['/shared/overlay_assets/.hidden'] = 'dotfile';
    mockFs(files);
    vi.useFakeTimers();
    await sw.init();
    sw.start();

    // Current behavior: init snapshots config/metadata hashes but NOT
    // overlay assets, so each process start re-uploads them once.
    await vi.advanceTimersByTimeAsync(30000);
    expect(stubs.uploadBuffer.mock.calls.map(([, key]) => key)).toEqual([
      'config/overlay_assets/logo.png'
    ]);
    expect(stubs.uploadBuffer.mock.calls[0][0].toString()).toBe('png-bytes');

    // Hash recorded after the successful upload -> next ticks are quiet.
    await vi.advanceTimersByTimeAsync(60000);
    expect(stubs.uploadBuffer).toHaveBeenCalledTimes(1);
  });

  // ─── Hash-after-success (THE retry pin) ──────────────────────

  it('upload failure leaves hash stale: same config retried next tick until success', async () => {
    const { stubs } = loadS3();
    sw = freshWatcher();
    const { files } = mockFs(allFilesPresent());
    vi.useFakeTimers();
    await sw.init();
    sw.start();

    stubs.uploadBuffer
      .mockRejectedValueOnce(new Error('s3 down'))
      .mockResolvedValue(undefined);
    files['/shared/playlists.json'] = 'v2';

    // Tick 1: attempt fails -> hash NOT updated.
    await vi.advanceTimersByTimeAsync(30000);
    expect(stubs.uploadBuffer).toHaveBeenCalledTimes(1);

    // Tick 2: SAME file retried, succeeds -> hash updated.
    await vi.advanceTimersByTimeAsync(30000);
    expect(stubs.uploadBuffer).toHaveBeenCalledTimes(2);
    expect(stubs.uploadBuffer.mock.calls[1][1]).toBe('config/playlists.json');
    expect(stubs.uploadBuffer.mock.calls[1][0].toString()).toBe('v2');

    // Tick 3: nothing left to do.
    await vi.advanceTimersByTimeAsync(30000);
    expect(stubs.uploadBuffer).toHaveBeenCalledTimes(2);
  });

  it('stat-based play_history.jsonl: sig change streams via s3.upload, retried on failure', async () => {
    const { stubs } = loadS3();
    sw = freshWatcher();
    const { stats } = mockFs(allFilesPresent());
    stats['/shared/play_history.jsonl'] = { size: 100, mtimeMs: 1 };
    vi.useFakeTimers();
    await sw.init();
    sw.start();

    stubs.upload
      .mockRejectedValueOnce(new Error('s3 down'))
      .mockResolvedValue(undefined);
    stats['/shared/play_history.jsonl'] = { size: 150, mtimeMs: 2 };

    // Tick 1: stat sig changed -> stream upload attempted, fails.
    await vi.advanceTimersByTimeAsync(30000);
    expect(stubs.upload).toHaveBeenCalledTimes(1);
    expect(stubs.upload).toHaveBeenCalledWith('/shared/play_history.jsonl', 'config/play_history.jsonl');
    // Stat-based files never go through uploadBuffer.
    expect(stubs.uploadBuffer).not.toHaveBeenCalled();

    // Tick 2: retried (sig still stale), succeeds.
    await vi.advanceTimersByTimeAsync(30000);
    expect(stubs.upload).toHaveBeenCalledTimes(2);

    // Tick 3: quiet.
    await vi.advanceTimersByTimeAsync(30000);
    expect(stubs.upload).toHaveBeenCalledTimes(2);
  });

  // ─── pollProcessed: dedupe + SKIP_PATTERN ────────────────────

  it('processed upload: _knownUploaded from init dedupes, new file uploaded once, SKIP names never uploaded', async () => {
    const { stubs } = loadS3();
    const files = allFilesPresent();
    files['/music/processed/existing.wav'] = 'wav-existing';
    files['/music/processed/new.wav'] = 'wav-new';
    files['/visuals/.processed/.transcoding_x.mp4'] = 'tmp';
    files['/visuals/.processed/_standby_y.mp4'] = 'tmp';
    files['/visuals/.processed/z.mp4.s3tmp'] = 'tmp';
    sw = freshWatcher();
    mockFs(files);
    stubs.list.mockImplementation(async (prefix) =>
      prefix === 'music/processed/' ? [{ key: 'music/processed/existing.wav', size: 1, modified: null }] : []
    );
    vi.useFakeTimers();
    await sw.init();
    sw.start();

    await vi.advanceTimersByTimeAsync(30000);
    // Only the unknown legit file goes up; existing.wav deduped via init listing.
    expect(stubs.upload.mock.calls).toEqual([
      ['/music/processed/new.wav', 'music/processed/new.wav']
    ]);

    // Next tick: now known -> no re-upload; SKIP names still never uploaded.
    await vi.advanceTimersByTimeAsync(30000);
    expect(stubs.upload).toHaveBeenCalledTimes(1);
  });

  it('processed upload failure: key NOT marked known, retried next tick, then deduped', async () => {
    const { stubs } = loadS3();
    const files = allFilesPresent();
    files['/music/processed/new.wav'] = 'wav-new';
    sw = freshWatcher();
    mockFs(files);
    vi.useFakeTimers();
    await sw.init();
    sw.start();

    stubs.upload
      .mockRejectedValueOnce(new Error('s3 down'))
      .mockResolvedValue(undefined);

    await vi.advanceTimersByTimeAsync(30000);
    expect(stubs.upload).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30000);
    expect(stubs.upload).toHaveBeenCalledTimes(2);
    expect(stubs.upload.mock.calls[1]).toEqual(['/music/processed/new.wav', 'music/processed/new.wav']);

    await vi.advanceTimersByTimeAsync(30000);
    expect(stubs.upload).toHaveBeenCalledTimes(2);
  });

  it('processed download: fetches only locally-missing remote files, skips SKIP_PATTERN keys, marks known', async () => {
    const { stubs } = loadS3();
    const files = allFilesPresent();
    files['/music/processed/existing.wav'] = 'wav-existing';
    sw = freshWatcher();
    const { files: liveFiles } = mockFs(files);
    stubs.list.mockImplementation(async (prefix) =>
      prefix === 'music/processed/'
        ? [
            { key: 'music/processed/remote_new.wav', size: 1, modified: null },
            { key: 'music/processed/.transcoding_r.wav', size: 1, modified: null },
            { key: 'music/processed/existing.wav', size: 1, modified: null }
          ]
        : []
    );
    // Successful download materialises the file locally.
    stubs.download.mockImplementation(async (key, localPath) => {
      liveFiles[localPath] = 'downloaded';
    });
    vi.useFakeTimers();
    await sw.init();
    sw.start();

    await vi.advanceTimersByTimeAsync(30000);
    // Only the missing legit file is downloaded; SKIP and present files are not.
    expect(stubs.download.mock.calls).toEqual([
      ['music/processed/remote_new.wav', '/music/processed/remote_new.wav']
    ]);

    // Next tick: file now exists locally -> no re-download; and because the
    // key was marked known, the upload phase does not push it back either.
    await vi.advanceTimersByTimeAsync(30000);
    expect(stubs.download).toHaveBeenCalledTimes(1);
    expect(stubs.upload).not.toHaveBeenCalled();
  });

  // ─── schedulePoll non-overlap ────────────────────────────────

  it('a poll outliving its interval never overlaps itself (chain, not setInterval)', async () => {
    const { stubs } = loadS3();
    sw = freshWatcher();
    mockFs({}); // nothing local -> configs/metadata polls are no-ops
    let releaseList;
    const hang = new Promise(resolve => { releaseList = resolve; });
    stubs.list
      .mockImplementationOnce(() => hang) // first pollProcessed list call hangs
      .mockResolvedValue([]);
    vi.useFakeTimers();
    sw.start(); // start() without init() is enough to drive the chains

    // First processed tick at 30s starts and blocks on the hanging list.
    await vi.advanceTimersByTimeAsync(30000);
    expect(stubs.list).toHaveBeenCalledTimes(1);

    // Three more interval lengths pass: a setInterval-style scheduler would
    // have fired pollProcessed 3 more times. The chain arms the next tick
    // only after the poll fn settles, so the count must stay at 1.
    await vi.advanceTimersByTimeAsync(90000);
    expect(stubs.list).toHaveBeenCalledTimes(1);

    // Unblock: the stuck tick completes (lists the second dir too)...
    releaseList([]);
    await flushMicrotasks();
    expect(stubs.list).toHaveBeenCalledTimes(2);

    // ...and only then is the next tick armed, one interval later.
    await vi.advanceTimersByTimeAsync(30000);
    expect(stubs.list).toHaveBeenCalledTimes(4);
  });

  // ─── stop ────────────────────────────────────────────────────

  it('stop() clears the chains: nothing fires afterwards', async () => {
    const { stubs } = loadS3();
    sw = freshWatcher();
    const { files } = mockFs(allFilesPresent());
    vi.useFakeTimers();
    await sw.init();
    sw.start();

    files['/shared/playlists.json'] = 'v2';
    await vi.advanceTimersByTimeAsync(30000);
    expect(stubs.uploadBuffer).toHaveBeenCalledTimes(1);

    sw.stop();
    expect(vi.getTimerCount()).toBe(0);

    files['/shared/playlists.json'] = 'v3';
    await vi.advanceTimersByTimeAsync(300000);
    expect(stubs.uploadBuffer).toHaveBeenCalledTimes(1);
  });

  // ─── restoreConfigs ──────────────────────────────────────────

  it('restores missing and empty configs, overlay assets and metadata; syncs raw dirs', async () => {
    const { stubs } = loadS3();
    const files = allFilesPresent();
    delete files['/shared/playlists.json'];            // missing -> restore
    files['/shared/schedule.json'] = '';               // present but empty -> restore
    delete files['/music/.bpm_map'];                   // missing metadata -> restore
    sw = freshWatcher();
    const { files: liveFiles } = mockFs(files);
    stubs.list.mockImplementation(async (prefix) =>
      prefix === 'config/overlay_assets/'
        ? [{ key: 'config/overlay_assets/logo.png', size: 1, modified: null }]
        : []
    );
    stubs.download.mockImplementation(async (key, localPath) => {
      liveFiles[localPath] = 'restored';
    });

    await sw.restoreConfigs();

    expect(stubs.download.mock.calls).toEqual([
      ['config/playlists.json', '/shared/playlists.json'],
      ['config/schedule.json', '/shared/schedule.json'],
      ['config/overlay_assets/logo.png', '/shared/overlay_assets/logo.png'],
      ['music/.bpm_map', '/music/.bpm_map']
    ]);
    expect(stubs.syncDir.mock.calls).toEqual([
      ['music/raw/', '/music'],
      ['visuals/incoming/', '/visuals']
    ]);
  });

  it('restore download 404s (NoSuchKey / $metadata 404) are swallowed silently', async () => {
    const { stubs } = loadS3();
    const files = allFilesPresent();
    delete files['/shared/playlists.json'];
    delete files['/shared/schedule.json'];
    sw = freshWatcher();
    mockFs(files);
    const meta404 = new Error('not found');
    meta404.$metadata = { httpStatusCode: 404 };
    stubs.download
      .mockRejectedValueOnce(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
      .mockRejectedValueOnce(meta404);

    await expect(sw.restoreConfigs()).resolves.toBeUndefined();
    expect(stubs.download).toHaveBeenCalledTimes(2);
    // Both shapes are recognised as 404 -> not even logged as errors.
    const restoreErrors = console.error.mock.calls.filter(([msg]) =>
      String(msg).includes('restore config')
    );
    expect(restoreErrors).toEqual([]);
  });

  it('restore non-404 download error is logged but does not throw', async () => {
    const { stubs } = loadS3();
    const files = allFilesPresent();
    delete files['/shared/playlists.json'];
    sw = freshWatcher();
    mockFs(files);
    stubs.download.mockRejectedValue(Object.assign(new Error('boom'), { name: 'InternalError' }));

    await expect(sw.restoreConfigs()).resolves.toBeUndefined();
    const restoreErrors = console.error.mock.calls.filter(([msg]) =>
      String(msg).includes('restore config playlists.json')
    );
    expect(restoreErrors).toHaveLength(1);
  });
});
