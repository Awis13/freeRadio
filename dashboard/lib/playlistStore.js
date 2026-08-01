const fs = require('fs');
const path = require('path');
const express = require('express');
// Called through the module object rather than destructured, so the meta
// source stays swappable for tests without changing behaviour.
const trackMetaStore = require('./trackMeta');
const { readStore, writeStore } = require('./jsonStore');

/**
 * The store + router shared by the audio and video playlist domains.
 *
 * lib/playlist.js and lib/videoPlaylist.js are line-for-line clones apart from
 * a handful of details, and the clones have already drifted apart in ways the
 * bug register tracks. This factory holds the shared behaviour once and takes
 * ONLY the genuine differences as parameters:
 *
 *   file          where the store lives
 *   idPrefix      'pl_' or 'vpl_'
 *   trackDir      base dir -> dir the tracks actually live in. Audio uses the
 *                 directory it is handed; video uses <dir>/.processed.
 *   extensions    which files a smart playlist may pick up
 *   skipPrefixes  name prefixes a smart scan ignores (video skips _standby_)
 *   smartRules    which rule filters apply — audio honours bpm and genre,
 *                 video honours neither, and turning them on for video would
 *                 silently change what its existing smart playlists resolve to
 *
 * Behaviour that differs per domain but is not shared at all — the audio
 * m3u/pls import, the video queue/profile routes, the video ACTIVE_FILE
 * cleanup on delete — is supplied by the caller through `extraRoutes` and
 * `beforeDelete` rather than being flagged in here.
 *
 * NOTE ON FIDELITY: this factory reproduces BOTH current contracts exactly,
 * including the quirks. It does not fix the list-vs-detail trackCount gap that
 * both domains share (GET / counts with basename() only, GET /:id additionally
 * requires safe === t, so a traversal-shaped entry is counted but not
 * resolved). Aligning that is a deliberate behaviour change, not something to
 * smuggle in under a refactor.
 */
function createPlaylistStore({
  file,
  idPrefix,
  extensions,
  trackDir = (dir) => dir,
  skipPrefixes = [],
  smartRules = {},
}) {
  const useBpm = smartRules.bpm === true;
  const useGenre = smartRules.genre === true;

  function load() {
    return readStore(file, { playlists: {} });
  }

  function save(data) {
    writeStore(file, data);
  }

  function get(id) {
    const data = load();
    return data.playlists[id] || null;
  }

  /**
   * Files a smart playlist resolves to. `bpmMap` is only consulted when the
   * domain enables the bpm rule.
   */
  function resolveSmart(rules, baseDir, bpmMap = {}) {
    const meta = trackMetaStore.loadMeta();
    const dir = trackDir(baseDir);

    let files;
    try {
      files = fs.readdirSync(dir).filter(f =>
        !f.startsWith('.') &&
        !skipPrefixes.some(prefix => f.startsWith(prefix)) &&
        extensions.test(f));
    } catch (e) {
      return [];
    }

    return files.filter(name => {
      if (useBpm && (rules.bpmMin || rules.bpmMax)) {
        const bpm = bpmMap[name];
        if (!bpm) return false;
        if (rules.bpmMin && bpm < rules.bpmMin) return false;
        if (rules.bpmMax && bpm > rules.bpmMax) return false;
      }

      if (rules.namePattern) {
        try {
          const re = new RegExp(rules.namePattern, 'i');
          if (!re.test(name)) return false;
        } catch (e) {
          // Invalid regex, skip filter
        }
      }

      if (rules.tags && rules.tags.length > 0) {
        const trackMeta = meta.tracks[name] || { tags: [] };
        const trackTags = trackMeta.tags || [];
        if (rules.tagMode === 'all') {
          if (!rules.tags.every(t => trackTags.includes(t))) return false;
        } else {
          // 'any' mode (default)
          if (!rules.tags.some(t => trackTags.includes(t))) return false;
        }
      }

      if (useGenre && rules.genre) {
        const trackMeta = meta.tracks[name] || {};
        if ((trackMeta.genre || '').toLowerCase() !== rules.genre.toLowerCase()) return false;
      }

      return true;
    });
  }

  /** Manual playlists keep their order; missing files and traversal drop out. */
  function resolve(playlistId, baseDir, bpmMap = {}) {
    const playlist = get(playlistId);
    if (!playlist) return [];

    if (playlist.type === 'manual') {
      const dir = trackDir(baseDir);
      return (playlist.tracks || []).filter(t => {
        const safe = path.basename(t);
        return safe && safe === t && fs.existsSync(path.join(dir, safe));
      });
    }

    if (playlist.type === 'smart') {
      return resolveSmart(playlist.rules || {}, baseDir, bpmMap);
    }

    return [];
  }

  /**
   * The CRUD router both domains share.
   *
   * @param {string} baseDir            music or visuals directory
   * @param {Object} [opts]
   * @param {Function} [opts.getBpmMap] () => bpmMap, audio only
   * @param {Function} [opts.beforeDelete] (id, data) => void, before a delete lands
   * @param {Function} [opts.extraRoutes] (router, ctx) => void, domain-only routes
   */
  function createRouter(baseDir, { getBpmMap = () => ({}), beforeDelete, extraRoutes } = {}) {
    const router = express.Router();

    // GET / — list all
    router.get('/', (req, res) => {
      const data = load();
      const dir = trackDir(baseDir);
      const list = Object.values(data.playlists).map(pl => {
        const trackCount = pl.type === 'smart'
          ? resolveSmart(pl.rules || {}, baseDir, getBpmMap()).length
          : (pl.tracks || []).filter(t => fs.existsSync(path.join(dir, path.basename(t)))).length;
        return { ...pl, trackCount };
      });
      res.json(list);
    });

    // POST / — create
    router.post('/', express.json(), (req, res) => {
      const { name, type, tracks, rules } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });

      const id = idPrefix + Date.now();
      const now = Date.now();
      const playlist = {
        id,
        name,
        type: type || 'manual',
        createdAt: now,
        updatedAt: now
      };

      if (playlist.type === 'manual') {
        playlist.tracks = Array.isArray(tracks) ? tracks.map(t => path.basename(t)).filter(Boolean) : [];
      } else if (playlist.type === 'smart') {
        playlist.rules = rules || {};
      }

      const data = load();
      data.playlists[id] = playlist;
      save(data);

      res.json(playlist);
    });

    // GET /:id — details with resolved tracks
    router.get('/:id', (req, res) => {
      const playlist = get(req.params.id);
      if (!playlist) return res.status(404).json({ error: 'not found' });

      const resolved = resolve(req.params.id, baseDir, getBpmMap());
      res.json({ ...playlist, resolvedTracks: resolved, trackCount: resolved.length });
    });

    // PUT /:id — update
    router.put('/:id', express.json(), (req, res) => {
      const data = load();
      const existing = data.playlists[req.params.id];
      if (!existing) return res.status(404).json({ error: 'not found' });

      const { name, tracks, rules } = req.body;
      if (name !== undefined) existing.name = name;
      if (existing.type === 'manual' && tracks !== undefined) {
        existing.tracks = tracks.map(t => path.basename(t)).filter(Boolean);
      }
      if (existing.type === 'smart' && rules !== undefined) {
        existing.rules = rules;
      }
      existing.updatedAt = Date.now();

      data.playlists[req.params.id] = existing;
      save(data);
      res.json(existing);
    });

    // DELETE /:id
    router.delete('/:id', (req, res) => {
      const data = load();
      if (!data.playlists[req.params.id]) {
        return res.status(404).json({ error: 'not found' });
      }

      if (beforeDelete) beforeDelete(req.params.id, data);

      delete data.playlists[req.params.id];
      save(data);
      res.json({ ok: true });
    });

    // POST /:id/reorder — reorder tracks { from, to }
    router.post('/:id/reorder', express.json(), (req, res) => {
      const data = load();
      const pl = data.playlists[req.params.id];
      if (!pl) return res.status(404).json({ error: 'not found' });
      if (pl.type !== 'manual') return res.status(400).json({ error: 'only manual playlists' });

      const { from, to } = req.body;
      if (typeof from !== 'number' || typeof to !== 'number') {
        return res.status(400).json({ error: 'from and to must be numbers' });
      }

      const tracks = pl.tracks || [];
      if (from < 0 || from >= tracks.length || to < 0 || to >= tracks.length) {
        return res.status(400).json({ error: 'index out of range' });
      }

      const [item] = tracks.splice(from, 1);
      tracks.splice(to, 0, item);
      pl.tracks = tracks;
      pl.updatedAt = Date.now();

      save(data);
      res.json(pl);
    });

    if (extraRoutes) {
      extraRoutes(router, { load, save, get, resolve, resolveSmart, baseDir, trackDir });
    }

    return router;
  }

  return { load, save, get, resolve, resolveSmart, createRouter };
}

module.exports = { createPlaylistStore };
