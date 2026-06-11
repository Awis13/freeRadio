/**
 * tests/dashboard/videoPlaylist.test.js
 *
 * Unit tests for dashboard/lib/videoPlaylist.js — video playlists module.
 * Tests pure functions: resolveSmartVideoPlaylist, resolveVideoPlaylist,
 * CRUD data operations, and edge cases.
 *
 * NOTE: trackMeta.js loadMeta() reads /shared/track_metadata.json — we mock
 * fs.readFileSync to return metadata for that path (no vi.mock for trackMeta,
 * as CJS require and ESM import bind different references).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

import {
  resolveSmartVideoPlaylist,
  resolveVideoPlaylist,
  getVideoPlaylist,
  loadVideoPlaylists,
  saveVideoPlaylists
} from '../../dashboard/lib/videoPlaylist';

// Track spies for cleanup
let spies = [];

function cleanupSpies() {
  spies.forEach(s => s.mockRestore());
  spies = [];
}

const PLAYLIST_FILE = '/shared/video_playlists.json';
const META_FILE = '/shared/track_metadata.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mock processed dir listing + existsSync for those files.
 * Also handles META_FILE and PLAYLIST_FILE reads.
 */
function setupMocks({ processedFiles, playlists, trackMeta }) {
  const playlistData = playlists || { playlists: {} };
  const metaData = trackMeta || { tracks: {} };

  spies.push(vi.spyOn(fs, 'readdirSync').mockImplementation((dir) => {
    if (String(dir).includes('.processed')) return processedFiles || [];
    throw new Error('ENOENT: ' + dir);
  }));

  spies.push(vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
    const s = String(p);
    if (s === PLAYLIST_FILE) return true;
    if (s === META_FILE) return true;
    const basename = path.basename(s);
    if (s.includes('.processed') && (processedFiles || []).includes(basename)) return true;
    return false;
  }));

  spies.push(vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
    const s = String(p);
    if (s === PLAYLIST_FILE) return JSON.stringify(playlistData);
    if (s === META_FILE) return JSON.stringify(metaData);
    throw new Error('ENOENT: ' + s);
  }));

  spies.push(vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {}));
}

// ---------------------------------------------------------------------------
// resolveSmartVideoPlaylist
// ---------------------------------------------------------------------------
describe('resolveSmartVideoPlaylist', () => {
  beforeEach(() => { cleanupSpies(); });

  it('returns all videos when rules are empty', () => {
    setupMocks({ processedFiles: ['a.mp4', 'b.mp4', 'c.mov'] });
    const result = resolveSmartVideoPlaylist({}, '/visuals');
    expect(result).toEqual(['a.mp4', 'b.mp4', 'c.mov']);
  });

  it('filters by namePattern regex', () => {
    setupMocks({ processedFiles: ['clip_cyber.mp4', 'clip_abstract.mp4', 'nature.mp4'] });
    const result = resolveSmartVideoPlaylist({ namePattern: 'cyber' }, '/visuals');
    expect(result).toEqual(['clip_cyber.mp4']);
  });

  it('namePattern is case-insensitive', () => {
    setupMocks({ processedFiles: ['CYBER_001.mp4', 'cyber_002.mp4', 'nature.mp4'] });
    const result = resolveSmartVideoPlaylist({ namePattern: 'cyber' }, '/visuals');
    expect(result).toEqual(['CYBER_001.mp4', 'cyber_002.mp4']);
  });

  it('handles regex OR pattern', () => {
    setupMocks({ processedFiles: ['clip_cyber.mp4', 'clip_abstract.mp4', 'nature.mp4'] });
    const result = resolveSmartVideoPlaylist({ namePattern: 'cyber|abstract' }, '/visuals');
    expect(result).toEqual(['clip_cyber.mp4', 'clip_abstract.mp4']);
  });

  it('ignores invalid regex and returns all files', () => {
    setupMocks({ processedFiles: ['a.mp4', 'b.mp4'] });
    const result = resolveSmartVideoPlaylist({ namePattern: '[invalid' }, '/visuals');
    expect(result).toEqual(['a.mp4', 'b.mp4']);
  });

  it('filters by tags in "any" mode', () => {
    setupMocks({
      processedFiles: ['a.mp4', 'b.mp4', 'c.mp4'],
      trackMeta: {
        tracks: {
          'a.mp4': { tags: ['dark', 'cyberpunk'], genre: '', custom: {} },
          'b.mp4': { tags: ['abstract'], genre: '', custom: {} },
          'c.mp4': { tags: [], genre: '', custom: {} }
        }
      }
    });
    const result = resolveSmartVideoPlaylist({ tags: ['cyberpunk'], tagMode: 'any' }, '/visuals');
    expect(result).toEqual(['a.mp4']);
  });

  it('filters by tags in "all" mode', () => {
    setupMocks({
      processedFiles: ['a.mp4', 'b.mp4', 'c.mp4'],
      trackMeta: {
        tracks: {
          'a.mp4': { tags: ['dark', 'cyberpunk'], genre: '', custom: {} },
          'b.mp4': { tags: ['dark'], genre: '', custom: {} },
          'c.mp4': { tags: ['cyberpunk'], genre: '', custom: {} }
        }
      }
    });
    const result = resolveSmartVideoPlaylist({ tags: ['dark', 'cyberpunk'], tagMode: 'all' }, '/visuals');
    expect(result).toEqual(['a.mp4']);
  });

  it('combines namePattern and tags filters', () => {
    setupMocks({
      processedFiles: ['clip_cyber.mp4', 'clip_abstract.mp4', 'nature.mp4'],
      trackMeta: {
        tracks: {
          'clip_cyber.mp4': { tags: ['dark'], genre: '', custom: {} },
          'clip_abstract.mp4': { tags: ['dark'], genre: '', custom: {} },
          'nature.mp4': { tags: ['dark'], genre: '', custom: {} }
        }
      }
    });
    const result = resolveSmartVideoPlaylist(
      { namePattern: 'clip', tags: ['dark'], tagMode: 'any' },
      '/visuals'
    );
    expect(result).toEqual(['clip_cyber.mp4', 'clip_abstract.mp4']);
  });

  it('returns empty array when directory does not exist', () => {
    spies.push(vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('ENOENT'); }));
    spies.push(vi.spyOn(fs, 'existsSync').mockReturnValue(false));
    spies.push(vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT'); }));
    const result = resolveSmartVideoPlaylist({}, '/visuals');
    expect(result).toEqual([]);
  });

  it('excludes dotfiles', () => {
    setupMocks({ processedFiles: ['.hidden.mp4', 'visible.mp4'] });
    const result = resolveSmartVideoPlaylist({}, '/visuals');
    expect(result).toEqual(['visible.mp4']);
  });

  it('excludes _standby_ files', () => {
    setupMocks({ processedFiles: ['_standby_black.mp4', 'normal.mp4'] });
    const result = resolveSmartVideoPlaylist({}, '/visuals');
    expect(result).toEqual(['normal.mp4']);
  });

  it('only includes video extensions (mp4, mov, mkv)', () => {
    setupMocks({ processedFiles: ['a.mp4', 'b.mov', 'c.mkv', 'd.txt', 'e.mp3', 'f.jpg'] });
    const result = resolveSmartVideoPlaylist({}, '/visuals');
    expect(result).toEqual(['a.mp4', 'b.mov', 'c.mkv']);
  });

  it('handles files with no metadata entry', () => {
    setupMocks({ processedFiles: ['a.mp4', 'b.mp4'], trackMeta: { tracks: {} } });
    const result = resolveSmartVideoPlaylist({ tags: ['dark'], tagMode: 'any' }, '/visuals');
    expect(result).toEqual([]);
  });

  it('handles empty tags array in rules (no filtering)', () => {
    setupMocks({ processedFiles: ['a.mp4', 'b.mp4'] });
    const result = resolveSmartVideoPlaylist({ tags: [] }, '/visuals');
    expect(result).toEqual(['a.mp4', 'b.mp4']);
  });

  it('uses "any" as default tagMode when not specified', () => {
    setupMocks({
      processedFiles: ['a.mp4', 'b.mp4'],
      trackMeta: {
        tracks: {
          'a.mp4': { tags: ['dark'], genre: '', custom: {} },
          'b.mp4': { tags: ['bright'], genre: '', custom: {} }
        }
      }
    });
    const result = resolveSmartVideoPlaylist({ tags: ['dark'] }, '/visuals');
    expect(result).toEqual(['a.mp4']);
  });
});

// ---------------------------------------------------------------------------
// loadVideoPlaylists / saveVideoPlaylists
// ---------------------------------------------------------------------------
describe('loadVideoPlaylists', () => {
  beforeEach(() => { cleanupSpies(); });

  it('returns empty structure when file does not exist', () => {
    spies.push(vi.spyOn(fs, 'existsSync').mockReturnValue(false));
    const result = loadVideoPlaylists();
    expect(result).toEqual({ playlists: {} });
  });

  it('returns parsed data when file exists', () => {
    const data = { playlists: { vpl_1: { id: 'vpl_1', name: 'Test' } } };
    spies.push(vi.spyOn(fs, 'existsSync').mockReturnValue(true));
    spies.push(vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(data)));
    const result = loadVideoPlaylists();
    expect(result).toEqual(data);
  });

  it('returns empty structure on corrupt JSON', () => {
    spies.push(vi.spyOn(fs, 'existsSync').mockReturnValue(true));
    spies.push(vi.spyOn(fs, 'readFileSync').mockReturnValue('not json{{{'));
    const result = loadVideoPlaylists();
    expect(result).toEqual({ playlists: {} });
  });
});

describe('saveVideoPlaylists', () => {
  beforeEach(() => { cleanupSpies(); });

  it('writes JSON to file', () => {
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    spies.push(spy);
    const data = { playlists: { vpl_1: { id: 'vpl_1', name: 'Test' } } };
    saveVideoPlaylists(data);
    expect(spy).toHaveBeenCalledWith(
      PLAYLIST_FILE,
      JSON.stringify(data, null, 2)
    );
  });
});

// ---------------------------------------------------------------------------
// getVideoPlaylist
// ---------------------------------------------------------------------------
describe('getVideoPlaylist', () => {
  beforeEach(() => { cleanupSpies(); });

  it('returns playlist by id', () => {
    const data = {
      playlists: {
        vpl_1: { id: 'vpl_1', name: 'Cyber', type: 'manual', tracks: ['a.mp4'] }
      }
    };
    setupMocks({ processedFiles: ['a.mp4'], playlists: data });
    const result = getVideoPlaylist('vpl_1');
    expect(result).toEqual(data.playlists.vpl_1);
  });

  it('returns null for non-existent id', () => {
    setupMocks({ processedFiles: [], playlists: { playlists: {} } });
    const result = getVideoPlaylist('vpl_nonexistent');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveVideoPlaylist
// ---------------------------------------------------------------------------
describe('resolveVideoPlaylist', () => {
  beforeEach(() => { cleanupSpies(); });

  it('returns empty array for non-existent playlist', () => {
    setupMocks({ processedFiles: [], playlists: { playlists: {} } });
    const result = resolveVideoPlaylist('vpl_nonexistent', '/visuals');
    expect(result).toEqual([]);
  });

  it('resolves manual playlist filtering missing files', () => {
    const available = ['a.mp4', 'b.mp4'];
    setupMocks({
      processedFiles: available,
      playlists: {
        playlists: {
          vpl_1: {
            id: 'vpl_1', name: 'Test', type: 'manual',
            tracks: ['a.mp4', 'missing.mp4', 'b.mp4']
          }
        }
      }
    });
    const result = resolveVideoPlaylist('vpl_1', '/visuals');
    expect(result).toEqual(['a.mp4', 'b.mp4']);
  });

  it('preserves order in manual playlist', () => {
    const available = ['a.mp4', 'b.mp4', 'c.mp4'];
    setupMocks({
      processedFiles: available,
      playlists: {
        playlists: {
          vpl_1: {
            id: 'vpl_1', name: 'Test', type: 'manual',
            tracks: ['c.mp4', 'a.mp4', 'b.mp4']
          }
        }
      }
    });
    const result = resolveVideoPlaylist('vpl_1', '/visuals');
    expect(result).toEqual(['c.mp4', 'a.mp4', 'b.mp4']);
  });

  it('resolves smart playlist using rules', () => {
    setupMocks({
      processedFiles: ['clip_cyber.mp4', 'clip_abstract.mp4', 'nature.mp4'],
      playlists: {
        playlists: {
          vpl_1: {
            id: 'vpl_1', name: 'Cyber', type: 'smart',
            rules: { namePattern: 'cyber' }
          }
        }
      }
    });
    const result = resolveVideoPlaylist('vpl_1', '/visuals');
    expect(result).toEqual(['clip_cyber.mp4']);
  });

  it('returns empty array for manual playlist with empty tracks', () => {
    setupMocks({
      processedFiles: ['a.mp4'],
      playlists: {
        playlists: {
          vpl_1: { id: 'vpl_1', name: 'Empty', type: 'manual', tracks: [] }
        }
      }
    });
    const result = resolveVideoPlaylist('vpl_1', '/visuals');
    expect(result).toEqual([]);
  });

  it('returns empty array for unknown playlist type', () => {
    setupMocks({
      processedFiles: ['a.mp4'],
      playlists: {
        playlists: {
          vpl_1: { id: 'vpl_1', name: 'X', type: 'unknown' }
        }
      }
    });
    const result = resolveVideoPlaylist('vpl_1', '/visuals');
    expect(result).toEqual([]);
  });

  it('handles manual playlist with undefined tracks field', () => {
    setupMocks({
      processedFiles: ['a.mp4'],
      playlists: {
        playlists: {
          vpl_1: { id: 'vpl_1', name: 'NoTracks', type: 'manual' }
        }
      }
    });
    const result = resolveVideoPlaylist('vpl_1', '/visuals');
    expect(result).toEqual([]);
  });

  it('handles smart playlist with undefined rules field', () => {
    setupMocks({
      processedFiles: ['a.mp4', 'b.mp4'],
      playlists: {
        playlists: {
          vpl_1: { id: 'vpl_1', name: 'NoRules', type: 'smart' }
        }
      }
    });
    const result = resolveVideoPlaylist('vpl_1', '/visuals');
    expect(result).toEqual(['a.mp4', 'b.mp4']);
  });
});
