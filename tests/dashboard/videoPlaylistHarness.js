/**
 * tests/dashboard/videoPlaylistHarness.js
 *
 * Shared in-memory fs harness for the video-playlist router characterization
 * tests (videoPlaylistRouter.test.js). Mirrors playlistHarness.js but is a
 * sibling rather than an extension because the video router's dependency surface
 * is wider: besides the playlists store it touches QUEUE_FILE, ACTIVE_FILE, the
 * track-metadata file (smart resolution via loadMeta), a `.processed`
 * subdirectory of visualsDir, and the lazily-required visualMode singleton.
 *
 * The REAL router is mounted via supertest. videoPlaylist.js is CommonJS pulled
 * through Node's native require chain, so it shares this process's `fs` and the
 * `visualMode` singleton — vi.spyOn(fs, ...) and vi.spyOn(visualMode, ...)
 * intercept the calls made inside the handlers (including the lazy
 * require('./visualMode') at request time).
 *
 * Real-fs delegation (default ON): express.json()'s body-parser lazily
 * require()s modules at request time, which calls fs.readFileSync/existsSync to
 * load their source. A blanket mock would crash that module loading, so any path
 * the harness does not own is forwarded to the real fs.
 */

import { vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// Same singleton the handler's lazy require('./visualMode') resolves to.
const visualMode = require('../../dashboard/lib/visualMode.js');
const { createVideoPlaylistRouter } = require('../../dashboard/lib/videoPlaylist.js');

export const PLAYLIST_FILE = '/shared/video_playlists.json';
export const QUEUE_FILE = '/shared/video_queue.txt';
export const ACTIVE_FILE = '/shared/active_visual_profile.json';
export const META_FILE = '/shared/track_metadata.json';
export const VISUALS_DIR = '/visuals';

/**
 * Installs the fs stubs over an in-memory file map plus a `.processed` listing,
 * and spies on visualMode.setVisualMode. Call inside beforeEach.
 *
 * Control surfaces:
 *   - state.files: in-memory file map (PLAYLIST_FILE, QUEUE_FILE, ACTIVE_FILE, ...)
 *   - state.processedFiles: filenames the `.processed` dir lists / contains
 *   - state.trackMeta: object returned for the metadata file (smart tag rules)
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.delegateToRealFs=true] - forward unowned paths to real fs.
 */
export function installVideoPlaylistFsHarness({ delegateToRealFs = true } = {}) {
  const realReadFileSync = fs.readFileSync;
  const realExistsSync = fs.existsSync;
  const realReaddirSync = fs.readdirSync;

  const state = {
    files: {},
    processedFiles: [],
    trackMeta: { tracks: {} },
  };

  vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
    if (typeof p === 'string') {
      if (p === PLAYLIST_FILE) return PLAYLIST_FILE in state.files;
      if (p === META_FILE) return true;
      if (p in state.files) return true;
      if (p.includes('.processed')) {
        return state.processedFiles.includes(path.basename(p));
      }
    }
    return delegateToRealFs ? realExistsSync(p) : false;
  });

  vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
    if (typeof p === 'string') {
      if (p === META_FILE) return JSON.stringify(state.trackMeta);
      if (p in state.files) return state.files[p];
      if (p === PLAYLIST_FILE) throw new Error('ENOENT');
    }
    if (delegateToRealFs) return realReadFileSync(p, ...rest);
    throw new Error('ENOENT');
  });

  vi.spyOn(fs, 'readdirSync').mockImplementation((dir, ...rest) => {
    if (typeof dir === 'string' && dir.includes('.processed')) {
      return state.processedFiles;
    }
    return delegateToRealFs ? realReaddirSync(dir, ...rest) : [];
  });

  vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
    state.files[p] = data;
  });
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    state.files[to] = state.files[from];
    delete state.files[from];
  });
  vi.spyOn(fs, 'unlinkSync').mockImplementation((p) => {
    delete state.files[p];
  });
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});

  // Spy (not stub) so its mode argument can be asserted while keeping it inert.
  const setVisualModeSpy = vi
    .spyOn(visualMode, 'setVisualMode')
    .mockImplementation((mode) => ({ mode }));

  function makeApp() {
    const app = express();
    // Mirrors server.js: body parsing is app-level there, so the router does
    // not carry its own express.json().
    app.use(express.json());
    app.use('/api/video-playlists', createVideoPlaylistRouter(VISUALS_DIR));
    return app;
  }

  // Seed the in-memory PLAYLIST_FILE directly (bypasses POST so GET/PUT/etc.
  // can be pinned against arbitrary stored shapes, smart playlists included).
  function seed(playlists) {
    state.files[PLAYLIST_FILE] = JSON.stringify({ playlists });
  }

  function setProcessedFiles(list) {
    state.processedFiles = list;
  }

  function setTrackMeta(meta) {
    state.trackMeta = meta;
  }

  function savedPlaylists() {
    return JSON.parse(state.files[PLAYLIST_FILE]).playlists;
  }

  return {
    get files() { return state.files; },
    get processedFiles() { return state.processedFiles; },
    setProcessedFiles,
    setTrackMeta,
    makeApp,
    seed,
    savedPlaylists,
    setVisualModeSpy,
  };
}
