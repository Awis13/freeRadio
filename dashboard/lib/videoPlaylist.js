const fs = require('fs');
const path = require('path');
const express = require('express');
const { loadMeta } = require('./trackMeta');

const PLAYLIST_FILE = '/shared/video_playlists.json';
const ACTIVE_FILE = '/shared/active_visual_profile.json';
const VIDEO_EXTENSIONS = /\.(mp4|mov|mkv)$/i;

function loadVideoPlaylists() {
  try {
    if (fs.existsSync(PLAYLIST_FILE)) {
      return JSON.parse(fs.readFileSync(PLAYLIST_FILE, 'utf8'));
    }
  } catch (e) {}
  return { playlists: {} };
}

function saveVideoPlaylists(data) {
  fs.writeFileSync(PLAYLIST_FILE, JSON.stringify(data, null, 2));
}

function getVideoPlaylist(id) {
  const data = loadVideoPlaylists();
  return data.playlists[id] || null;
}

function resolveVideoPlaylist(playlistId, visualsDir) {
  const playlist = getVideoPlaylist(playlistId);
  if (!playlist) return [];

  const processedDir = path.join(visualsDir, '.processed');

  if (playlist.type === 'manual') {
    // Сохраняем порядок, фильтруем несуществующие
    return (playlist.tracks || []).filter(t => {
      return fs.existsSync(path.join(processedDir, t));
    });
  }

  if (playlist.type === 'smart') {
    return resolveSmartVideoPlaylist(playlist.rules || {}, visualsDir);
  }

  return [];
}

function resolveSmartVideoPlaylist(rules, visualsDir) {
  const meta = loadMeta();
  const processedDir = path.join(visualsDir, '.processed');

  let files;
  try {
    files = fs.readdirSync(processedDir)
      .filter(f => !f.startsWith('.') && !f.startsWith('_standby_') && VIDEO_EXTENSIONS.test(f));
  } catch (e) {
    return [];
  }

  return files.filter(name => {
    // Фильтр по имени файла (regex)
    if (rules.namePattern) {
      try {
        const re = new RegExp(rules.namePattern, 'i');
        if (!re.test(name)) return false;
      } catch (e) {
        // Невалидный regex — пропускаем фильтр
      }
    }

    // Фильтр по тегам
    if (rules.tags && rules.tags.length > 0) {
      const trackMeta = meta.tracks[name] || { tags: [] };
      const trackTags = trackMeta.tags || [];
      if (rules.tagMode === 'all') {
        if (!rules.tags.every(t => trackTags.includes(t))) return false;
      } else {
        // 'any' mode (по умолчанию)
        if (!rules.tags.some(t => trackTags.includes(t))) return false;
      }
    }

    return true;
  });
}

function createVideoPlaylistRouter(visualsDir) {
  const router = express.Router();

  // GET /api/video-playlists — список всех
  router.get('/', (req, res) => {
    const data = loadVideoPlaylists();
    const list = Object.values(data.playlists).map(pl => {
      const trackCount = pl.type === 'smart'
        ? resolveSmartVideoPlaylist(pl.rules || {}, visualsDir).length
        : (pl.tracks || []).length;
      return { ...pl, trackCount };
    });
    res.json(list);
  });

  // POST /api/video-playlists — создать
  router.post('/', express.json(), (req, res) => {
    const { name, type, tracks, rules } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const id = 'vpl_' + Date.now();
    const now = Date.now();
    const playlist = {
      id,
      name,
      type: type || 'manual',
      createdAt: now,
      updatedAt: now
    };

    if (playlist.type === 'manual') {
      playlist.tracks = Array.isArray(tracks) ? tracks : [];
    } else if (playlist.type === 'smart') {
      playlist.rules = rules || {};
    }

    const data = loadVideoPlaylists();
    data.playlists[id] = playlist;
    saveVideoPlaylists(data);

    res.json(playlist);
  });

  // GET /api/video-playlists/:id — детали с resolved треками
  router.get('/:id', (req, res) => {
    const playlist = getVideoPlaylist(req.params.id);
    if (!playlist) return res.status(404).json({ error: 'not found' });

    const resolved = resolveVideoPlaylist(req.params.id, visualsDir);
    res.json({ ...playlist, resolvedTracks: resolved, trackCount: resolved.length });
  });

  // PUT /api/video-playlists/:id — обновить
  router.put('/:id', express.json(), (req, res) => {
    const data = loadVideoPlaylists();
    const existing = data.playlists[req.params.id];
    if (!existing) return res.status(404).json({ error: 'not found' });

    const { name, tracks, rules } = req.body;
    if (name !== undefined) existing.name = name;
    if (existing.type === 'manual' && tracks !== undefined) {
      existing.tracks = tracks;
    }
    if (existing.type === 'smart' && rules !== undefined) {
      existing.rules = rules;
    }
    existing.updatedAt = Date.now();

    data.playlists[req.params.id] = existing;
    saveVideoPlaylists(data);
    res.json(existing);
  });

  // DELETE /api/video-playlists/:id
  router.delete('/:id', (req, res) => {
    const data = loadVideoPlaylists();
    if (!data.playlists[req.params.id]) {
      return res.status(404).json({ error: 'not found' });
    }
    delete data.playlists[req.params.id];
    saveVideoPlaylists(data);
    res.json({ ok: true });
  });

  // POST /api/video-playlists/:id/reorder — перестановка треков { from, to }
  router.post('/:id/reorder', express.json(), (req, res) => {
    const data = loadVideoPlaylists();
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

    saveVideoPlaylists(data);
    res.json(pl);
  });

  // POST /api/video-playlists/:id/load-queue — загрузить в очередь видео
  router.post('/:id/load-queue', (req, res) => {
    const playlist = getVideoPlaylist(req.params.id);
    if (!playlist) return res.status(404).json({ error: 'not found' });

    const resolved = resolveVideoPlaylist(req.params.id, visualsDir);
    if (resolved.length === 0) {
      return res.status(400).json({ error: 'playlist resolves to 0 videos' });
    }

    const videoQueue = require('./videoQueue');
    const visualMode = require('./visualMode');

    videoQueue.clear();
    for (const file of resolved) {
      videoQueue.push(file);
    }
    visualMode.setVisualMode('video-playlist');

    res.json({ ok: true, loaded: resolved.length, videos: resolved });
  });

  // POST /api/video-playlists/:id/activate-profile — установить как shuffle профиль
  router.post('/:id/activate-profile', (req, res) => {
    const playlist = getVideoPlaylist(req.params.id);
    if (!playlist) return res.status(404).json({ error: 'not found' });

    const resolved = resolveVideoPlaylist(req.params.id, visualsDir);
    if (resolved.length === 0) {
      return res.status(400).json({ error: 'playlist resolves to 0 videos' });
    }

    const payload = {
      id: playlist.id,
      name: playlist.name,
      videos: resolved,
      activatedAt: Date.now()
    };
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify(payload, null, 2));

    res.json({ ok: true, activated: resolved.length, videos: resolved });
  });

  return router;
}

module.exports = {
  createVideoPlaylistRouter,
  resolveVideoPlaylist,
  resolveSmartVideoPlaylist,
  getVideoPlaylist,
  loadVideoPlaylists,
  saveVideoPlaylists
};
