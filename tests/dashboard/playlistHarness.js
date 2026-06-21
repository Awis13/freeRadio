/**
 * tests/dashboard/playlistHarness.js
 *
 * Shared in-memory fs harness for the playlist router characterization tests
 * (playlistImport.test.js and playlistRouter.test.js). Both files mount the REAL
 * express router via supertest and back PLAYLIST_FILE + the musicDir
 * existence/listing with in-memory maps, so the stub setup is identical.
 *
 * Real-fs delegation (default ON): express.json()'s body-parser lazily require()s
 * modules at request time, which calls fs.readFileSync/existsSync to load their
 * source. A blanket mock would crash that module loading, so any path the harness
 * does not own is forwarded to the real fs. This is strictly safer and harmless
 * for the import file too, so it is the default; pass { delegateToRealFs: false }
 * to opt out.
 */

import { vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import express from 'express';

import { createPlaylistRouter } from '../../dashboard/lib/playlist.js';

export const PLAYLIST_FILE = '/shared/playlists.json';
export const MUSIC_DIR = '/music';

/**
 * Installs the fs stubs over an in-memory file map and a musicDir listing.
 * Call inside beforeEach. Returns the live state plus helper functions bound to
 * it (makeApp/seed/savedPlaylists). Mutate `state.files` / `state.musicFiles`
 * directly in tests to control what the router sees.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.delegateToRealFs=true] - forward unowned paths to real fs.
 * @returns {{
 *   files: Object, musicFiles: string[],
 *   setMusicFiles: (list: string[]) => void,
 *   makeApp: (getBpmMap?: () => Object) => import('express').Express,
 *   seed: (playlists: Object) => void,
 *   savedPlaylists: () => Object
 * }}
 */
export function installPlaylistFsHarness({ delegateToRealFs = true } = {}) {
  // Capture the real implementations BEFORE spying on them.
  const realReadFileSync = fs.readFileSync;
  const realExistsSync = fs.existsSync;
  const realReaddirSync = fs.readdirSync;

  const state = {
    files: {},
    musicFiles: [],
  };

  vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
    if (typeof p === 'string') {
      if (p in state.files) return true;
      const base = path.basename(p);
      if (p.startsWith(MUSIC_DIR)) return state.musicFiles.includes(base);
      if (p === PLAYLIST_FILE) return false;
    }
    return delegateToRealFs ? realExistsSync(p) : false;
  });
  vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
    if (typeof p === 'string' && p in state.files) return state.files[p];
    if (p === PLAYLIST_FILE) throw new Error('ENOENT');
    if (delegateToRealFs) return realReadFileSync(p, ...rest);
    throw new Error('ENOENT');
  });
  vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
    state.files[p] = data;
  });
  vi.spyOn(fs, 'readdirSync').mockImplementation((dir, ...rest) => {
    if (dir === MUSIC_DIR) return state.musicFiles;
    return delegateToRealFs ? realReaddirSync(dir, ...rest) : [];
  });

  // Build an app with the real router. getBpmMap is invoked for smart-playlist
  // resolution; default to an empty BPM map.
  function makeApp(getBpmMap = () => ({})) {
    const app = express();
    app.use('/api/playlists', createPlaylistRouter(MUSIC_DIR, getBpmMap));
    return app;
  }

  // Seed the in-memory PLAYLIST_FILE directly (bypasses POST so GET/PUT /:id can
  // be pinned against arbitrary stored shapes, including smart playlists).
  function seed(playlists) {
    state.files[PLAYLIST_FILE] = JSON.stringify({ playlists });
  }

  // Read back the persisted playlists (whatever the last savePlaylists wrote).
  function savedPlaylists() {
    return JSON.parse(state.files[PLAYLIST_FILE]).playlists;
  }

  function setMusicFiles(list) {
    state.musicFiles = list;
  }

  return {
    get files() { return state.files; },
    get musicFiles() { return state.musicFiles; },
    setMusicFiles,
    makeApp,
    seed,
    savedPlaylists,
  };
}
