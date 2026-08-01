/**
 * tests/dashboard/paths.test.js
 *
 * Pins dashboard/lib/paths.js — the env-driven path config C2 substitutes into
 * ~25 files.
 *
 * Two things matter here and are tested separately:
 *   1. DEFAULTS reproduce the literals those files hardcode today, so the
 *      substitution cannot move anything on its own. The expected values are
 *      written out as literal strings on purpose — deriving them from the
 *      module would assert nothing.
 *   2. ENV OVERRIDES are honoured where they exist. PROCESSED_DIR and
 *      ANALYSIS_MAP deliberately have none — they follow MUSIC_DIR, because
 *      only some of their consumers ever read a separate override.
 *
 * paths.js reads env once at require time, like liqClient.js and syncWatcher.js,
 * so each case sets env and re-requires with the cache evicted.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const PATHS_SPEC = '../../dashboard/lib/paths';

const ENV_KEYS = [
  'SHARED_DIR', 'MUSIC_DIR', 'PROCESSED_DIR', 'VISUALS_DIR', 'HLS_DIR',
  'HLS_JS_PATH', 'ANALYSIS_MAP', 'DJ_HOST', 'DJ_PORT',
];
const ORIGINAL_ENV = {};
for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];

/** Fresh require of paths.js with exactly the given env baked in. */
function freshPaths(env = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  delete nodeRequire.cache[nodeRequire.resolve(PATHS_SPEC)];
  return nodeRequire(PATHS_SPEC);
}

afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete nodeRequire.cache[nodeRequire.resolve(PATHS_SPEC)];
});

describe('dashboard/lib/paths.js', () => {
  describe('defaults (must equal the literals the code hardcodes today)', () => {
    it('directories', () => {
      const p = freshPaths();
      expect(p.SHARED_DIR).toBe('/shared');
      expect(p.MUSIC_DIR).toBe('/music');
      expect(p.PROCESSED_DIR).toBe('/music/processed');
      expect(p.VISUALS_DIR).toBe('/visuals');
      expect(p.HLS_DIR).toBe('/hls');
    });

    it('files', () => {
      const p = freshPaths();
      // server.js:145 res.sendFile(...) and track.js:6 respectively.
      expect(p.HLS_JS_PATH).toBe('/app/hls.min.js');
      expect(p.ANALYSIS_MAP).toBe('/music/.analysis_map');
    });

    it('liquidsoap host and port', () => {
      const p = freshPaths();
      // Same defaults liqClient.js already uses; boot.js hardcodes these.
      expect(p.DJ_HOST).toBe('dj');
      expect(p.DJ_PORT).toBe(7000);
    });

    it('joiners produce the paths the call sites spell out today', () => {
      const p = freshPaths();
      expect(p.shared('tier.json')).toBe('/shared/tier.json');
      expect(p.shared('overlay_assets')).toBe('/shared/overlay_assets');
      expect(p.shared('voice')).toBe('/shared/voice');
      expect(p.music('.analysis_map')).toBe('/music/.analysis_map');
      expect(p.processed('track.wav')).toBe('/music/processed/track.wav');
      expect(p.visuals('clip.mp4')).toBe('/visuals/clip.mp4');
    });

    it('joiners accept multiple segments', () => {
      const p = freshPaths();
      expect(p.shared('voice', 'ptt_1.webm')).toBe('/shared/voice/ptt_1.webm');
      expect(p.music('processed', 'a.wav')).toBe('/music/processed/a.wav');
    });
  });

  describe('env overrides', () => {
    it('each directory follows its own env var', () => {
      const p = freshPaths({
        SHARED_DIR: '/srv/state', MUSIC_DIR: '/srv/audio',
        VISUALS_DIR: '/srv/video', HLS_DIR: '/srv/hls',
      });
      expect(p.SHARED_DIR).toBe('/srv/state');
      expect(p.MUSIC_DIR).toBe('/srv/audio');
      expect(p.VISUALS_DIR).toBe('/srv/video');
      expect(p.HLS_DIR).toBe('/srv/hls');
      expect(p.shared('tier.json')).toBe('/srv/state/tier.json');
      expect(p.visuals('clip.mp4')).toBe('/srv/video/clip.mp4');
    });

    it('PROCESSED_DIR and ANALYSIS_MAP follow MUSIC_DIR when not set explicitly', () => {
      const p = freshPaths({ MUSIC_DIR: '/srv/audio' });
      expect(p.PROCESSED_DIR).toBe('/srv/audio/processed');
      expect(p.ANALYSIS_MAP).toBe('/srv/audio/.analysis_map');
      expect(p.processed('track.wav')).toBe('/srv/audio/processed/track.wav');
    });

    it('PROCESSED_DIR and ANALYSIS_MAP have no override of their own', () => {
      // Deliberately not configurable: only some consumers read the overrides,
      // so setting one split the library rather than moving it.
      const p = freshPaths({ MUSIC_DIR: '/srv/audio', PROCESSED_DIR: '/fast/ssd/wav', ANALYSIS_MAP: '/state/map.json' });
      expect(p.PROCESSED_DIR).toBe('/srv/audio/processed');
      expect(p.ANALYSIS_MAP).toBe('/srv/audio/.analysis_map');
    });

    it('file paths and the dj service follow their env vars', () => {
      const p = freshPaths({
        HLS_JS_PATH: '/vendor/hls.js',
        DJ_HOST: 'liquidsoap.internal', DJ_PORT: '7100',
      });
      expect(p.HLS_JS_PATH).toBe('/vendor/hls.js');
      expect(p.DJ_HOST).toBe('liquidsoap.internal');
      expect(p.DJ_PORT).toBe(7100);
    });

    it('DJ_PORT is a number, not the raw string', () => {
      const p = freshPaths({ DJ_PORT: '7100' });
      expect(p.DJ_PORT).toBe(7100);
      expect(typeof p.DJ_PORT).toBe('number');
    });
  });
});
