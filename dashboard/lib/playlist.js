const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { loadMeta } = require('./trackMeta');

const PLAYLIST_FILE = '/shared/playlists.json';

function loadPlaylists() {
  try {
    if (fs.existsSync(PLAYLIST_FILE)) {
      return JSON.parse(fs.readFileSync(PLAYLIST_FILE, 'utf8'));
    }
  } catch (e) {}
  return { playlists: {} };
}

function savePlaylists(data) {
  fs.writeFileSync(PLAYLIST_FILE, JSON.stringify(data, null, 2));
}

function getPlaylist(id) {
  const data = loadPlaylists();
  return data.playlists[id] || null;
}

function resolvePlaylist(playlistId, musicDir, bpmMap) {
  const playlist = getPlaylist(playlistId);
  if (!playlist) return [];

  if (playlist.type === 'manual') {
    // Filter out tracks that no longer exist
    return (playlist.tracks || []).filter(t => {
      const safe = path.basename(t);
      return safe && safe === t && fs.existsSync(path.join(musicDir, safe));
    });
  }

  if (playlist.type === 'smart') {
    return resolveSmartPlaylist(playlist.rules || {}, musicDir, bpmMap);
  }

  return [];
}

function resolveSmartPlaylist(rules, musicDir, bpmMap) {
  const meta = loadMeta();
  let files;
  try {
    files = fs.readdirSync(musicDir)
      .filter(f => !f.startsWith('.') && /\.(wav|mp3|flac|ogg|aac|m4a)$/i.test(f));
  } catch (e) {
    return [];
  }

  return files.filter(name => {
    // BPM filter
    if (rules.bpmMin || rules.bpmMax) {
      const bpm = bpmMap[name];
      if (!bpm) return false;
      if (rules.bpmMin && bpm < rules.bpmMin) return false;
      if (rules.bpmMax && bpm > rules.bpmMax) return false;
    }

    // Filename pattern
    if (rules.namePattern) {
      try {
        const re = new RegExp(rules.namePattern, 'i');
        if (!re.test(name)) return false;
      } catch (e) {
        // Invalid regex, skip filter
      }
    }

    // Tag filter
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

    // Genre filter
    if (rules.genre) {
      const trackMeta = meta.tracks[name] || {};
      if ((trackMeta.genre || '').toLowerCase() !== rules.genre.toLowerCase()) return false;
    }

    return true;
  });
}

function parseM3U(content) {
  const lines = content.split(/\r?\n/);
  const tracks = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Extract just the filename
    const basename = trimmed.split('/').pop().split('\\').pop();
    if (basename && /\.(wav|mp3|flac|ogg|aac|m4a)$/i.test(basename)) {
      tracks.push(basename);
    }
  }
  return tracks;
}

function createPlaylistRouter(musicDir, getBpmMap) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

  // GET /api/playlists — list all
  router.get('/', (req, res) => {
    const data = loadPlaylists();
    const list = Object.values(data.playlists).map(pl => {
      const trackCount = pl.type === 'smart'
        ? resolveSmartPlaylist(pl.rules || {}, musicDir, getBpmMap()).length
        : (pl.tracks || []).filter(t => fs.existsSync(path.join(musicDir, path.basename(t)))).length;
      return { ...pl, trackCount };
    });
    res.json(list);
  });

  // POST /api/playlists — create
  router.post('/', express.json(), (req, res) => {
    const { name, type, tracks, rules } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const id = 'pl_' + Date.now();
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

    const data = loadPlaylists();
    data.playlists[id] = playlist;
    savePlaylists(data);

    res.json(playlist);
  });

  // GET /api/playlists/:id — details with resolved tracks
  router.get('/:id', (req, res) => {
    const playlist = getPlaylist(req.params.id);
    if (!playlist) return res.status(404).json({ error: 'not found' });

    const resolved = resolvePlaylist(req.params.id, musicDir, getBpmMap());
    res.json({ ...playlist, resolvedTracks: resolved, trackCount: resolved.length });
  });

  // PUT /api/playlists/:id — update
  router.put('/:id', express.json(), (req, res) => {
    const data = loadPlaylists();
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
    savePlaylists(data);
    res.json(existing);
  });

  // DELETE /api/playlists/:id
  router.delete('/:id', (req, res) => {
    const data = loadPlaylists();
    if (!data.playlists[req.params.id]) {
      return res.status(404).json({ error: 'not found' });
    }
    delete data.playlists[req.params.id];
    savePlaylists(data);
    res.json({ ok: true });
  });

  // POST /api/playlists/:id/reorder — reorder tracks { from, to }
  router.post('/:id/reorder', express.json(), (req, res) => {
    const data = loadPlaylists();
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

    savePlaylists(data);
    res.json(pl);
  });

  // POST /api/playlists/import — import m3u/pls
  router.post('/import', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no file' });

    const content = req.file.buffer.toString('utf8');
    const name = req.body.name || req.file.originalname.replace(/\.[^.]+$/, '') || 'Imported';

    let tracks;
    if (req.file.originalname.endsWith('.pls')) {
      // PLS format
      tracks = content.split(/\r?\n/)
        .filter(l => l.startsWith('File'))
        .map(l => l.split('=').slice(1).join('=').trim())
        .map(p => p.split('/').pop().split('\\').pop())
        .filter(f => /\.(wav|mp3|flac|ogg|aac|m4a)$/i.test(f));
    } else {
      tracks = parseM3U(content);
    }

    // Filter to only tracks that exist
    const existingTracks = tracks.filter(t => {
      const safe = path.basename(t);
      return safe && safe === t && fs.existsSync(path.join(musicDir, safe));
    });

    const id = 'pl_' + Date.now();
    const now = Date.now();
    const playlist = {
      id,
      name,
      type: 'manual',
      tracks: existingTracks,
      createdAt: now,
      updatedAt: now
    };

    const data = loadPlaylists();
    data.playlists[id] = playlist;
    savePlaylists(data);

    res.json({ ...playlist, importedCount: existingTracks.length, totalParsed: tracks.length });
  });

  return router;
}

module.exports = { createPlaylistRouter, resolvePlaylist, getPlaylist, loadPlaylists };
