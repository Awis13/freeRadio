/**
 * tests/dashboard/overlayHarness.js
 *
 * Module-specific harness for overlay.js router characterization tests.
 *
 * Why a sibling harness (not playlistHarness): overlay.js owns its own set of
 * paths (OVERLAY_CONFIG, FILTER_STRING_FILE, ASSETS_DIR, the compiled json) and
 * its upload endpoint uses multer DISK storage with dest=/shared/overlay_assets.
 *
 * REAL multer (not mocked): vi.mock('multer') does NOT intercept the require()
 * inside overlay.js in this setup, and the rest of the repo (playlistImport)
 * drives real multer too. The only obstacle is multer DiskStorage's real disk
 * I/O against /shared/overlay_assets, which cannot exist in this sandbox:
 *   - construction: multer({dest}) calls mkdirp.sync(dest) which uses
 *     fs.mkdirSync/fs.statSync — both spied here, so it is inert.
 *   - upload: _handleFile pipes the request stream into
 *     fs.createWriteStream(finalPath) — spied here to return a fake Writable that
 *     drains the stream and emits 'finish' so multer reports a successful save
 *     with a deterministic byte count, without touching the real filesystem.
 * The handler then runs its sanitize / traversal-guard / renameSync logic AS-IS.
 *
 * fs strategy: overlay.js is CommonJS pulled through Node's native require chain
 * (inlined by vitest config), so vi.spyOn(fs, ...) intercepts every fs call the
 * handlers (and multer) make. Owned paths are backed by an in-memory map + an
 * assets listing; unowned paths are delegated to the real fs so express
 * internals load fine.
 */

import { vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Writable } from 'stream';
import express from 'express';

import { createOverlayRouter } from '../../dashboard/lib/overlay.js';

export const OVERLAY_CONFIG = '/shared/overlays.json';
export const FILTER_STRING_FILE = '/shared/overlay_filter_string.txt';
export const COMPILED_FILE = '/shared/overlay_compiled.json';
export const ASSETS_DIR = '/shared/overlay_assets';

/**
 * Installs fs spies over an in-memory map + assets-dir listing. Call in beforeEach
 * AFTER vi.restoreAllMocks(). Returns live state + helpers.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.assetsDirExists=true] - whether ASSETS_DIR existsSync.
 * @param {boolean} [opts.delegateToRealFs=true] - forward unowned paths to real fs.
 */
export function installOverlayFsHarness({ assetsDirExists = true, delegateToRealFs = true } = {}) {
  const realReadFileSync = fs.readFileSync;
  const realExistsSync = fs.existsSync;
  const realReaddirSync = fs.readdirSync;
  const realStatSync = fs.statSync;

  const state = {
    files: {},
    // assets: name -> size
    assets: {},
    assetsDirExists,
    mkdirCalls: [],
    unlinked: [],
    renamed: [],
    uploadPaths: [],
  };

  vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
    if (typeof p === 'string') {
      if (p === ASSETS_DIR) return state.assetsDirExists;
      if (p in state.files) return true;
      // A file inside the assets dir exists iff listed in state.assets.
      if (p.startsWith(ASSETS_DIR + path.sep)) {
        return path.basename(p) in state.assets;
      }
    }
    return delegateToRealFs ? realExistsSync(p) : false;
  });

  vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
    if (typeof p === 'string' && p in state.files) return state.files[p];
    if (delegateToRealFs) return realReadFileSync(p, ...rest);
    throw new Error('ENOENT');
  });

  vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
    state.files[p] = data;
  });

  vi.spyOn(fs, 'mkdirSync').mockImplementation((p, opts) => {
    state.mkdirCalls.push({ p, opts });
    state.assetsDirExists = true;
  });

  vi.spyOn(fs, 'readdirSync').mockImplementation((dir, ...rest) => {
    if (dir === ASSETS_DIR) return Object.keys(state.assets);
    return delegateToRealFs ? realReaddirSync(dir, ...rest) : [];
  });

  vi.spyOn(fs, 'statSync').mockImplementation((p, ...rest) => {
    if (typeof p === 'string' && p.startsWith(ASSETS_DIR)) {
      const name = path.basename(p);
      if (name in state.assets) return { size: state.assets[name] };
      throw new Error('ENOENT');
    }
    return delegateToRealFs ? realStatSync(p, ...rest) : { size: 0 };
  });

  vi.spyOn(fs, 'unlinkSync').mockImplementation((p) => {
    state.unlinked.push(p);
    if (typeof p === 'string' && p.startsWith(ASSETS_DIR + path.sep)) {
      delete state.assets[path.basename(p)];
    }
    delete state.files[p];
  });

  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    state.renamed.push({ from, to });
    if (typeof to === 'string' && to.startsWith(ASSETS_DIR + path.sep)) {
      state.assets[path.basename(to)] = 0;
    }
  });

  // multer DiskStorage pipes the upload into fs.createWriteStream(finalPath).
  // Return a fake Writable that drains the stream and reports bytesWritten so
  // multer resolves the upload to req.file without real disk I/O.
  vi.spyOn(fs, 'createWriteStream').mockImplementation((p) => {
    const w = new Writable({
      write(chunk, _enc, cb) { w.bytesWritten += chunk.length; cb(); },
    });
    w.bytesWritten = 0;
    state.uploadPaths.push(p);
    return w;
  });

  function makeApp() {
    const app = express();
    app.use('/api/overlays', createOverlayRouter());
    return app;
  }

  function setAssets(map) {
    state.assets = { ...map };
  }

  return {
    get files() { return state.files; },
    get assets() { return state.assets; },
    get mkdirCalls() { return state.mkdirCalls; },
    get unlinked() { return state.unlinked; },
    get renamed() { return state.renamed; },
    get uploadPaths() { return state.uploadPaths; },
    setAssets,
    makeApp,
  };
}
