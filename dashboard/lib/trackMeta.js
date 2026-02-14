const fs = require('fs');
const path = require('path');
const express = require('express');

const META_FILE = '/shared/track_metadata.json';

function loadMeta() {
  try {
    if (fs.existsSync(META_FILE)) {
      return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    }
  } catch (e) {}
  return { tracks: {} };
}

function saveMeta(data) {
  fs.writeFileSync(META_FILE, JSON.stringify(data, null, 2));
}

function getTrackMeta(filename) {
  const data = loadMeta();
  return data.tracks[filename] || { tags: [], genre: '', custom: {} };
}

function setTrackMeta(filename, meta) {
  const data = loadMeta();
  const existing = data.tracks[filename] || { tags: [], genre: '', custom: {} };
  data.tracks[filename] = {
    tags: meta.tags !== undefined ? meta.tags : existing.tags,
    genre: meta.genre !== undefined ? meta.genre : existing.genre,
    custom: meta.custom !== undefined ? { ...existing.custom, ...meta.custom } : existing.custom
  };
  saveMeta(data);
  return data.tracks[filename];
}

function bulkTag(filenames, tags, action) {
  const data = loadMeta();
  filenames.forEach(filename => {
    if (!data.tracks[filename]) {
      data.tracks[filename] = { tags: [], genre: '', custom: {} };
    }
    if (action === 'remove') {
      data.tracks[filename].tags = data.tracks[filename].tags.filter(t => !tags.includes(t));
    } else {
      const existing = new Set(data.tracks[filename].tags);
      tags.forEach(t => existing.add(t));
      data.tracks[filename].tags = Array.from(existing);
    }
  });
  saveMeta(data);
  return { updated: filenames.length };
}

function getAllTags() {
  const data = loadMeta();
  const tagSet = new Set();
  Object.values(data.tracks).forEach(t => {
    (t.tags || []).forEach(tag => tagSet.add(tag));
  });
  return Array.from(tagSet).sort();
}

function createTrackRouter(musicDir, getBpmMap) {
  const router = express.Router();

  // GET /api/tracks — all tracks with metadata (bpm + tags)
  router.get('/', (req, res) => {
    try {
      const files = fs.readdirSync(musicDir)
        .filter(f => !f.startsWith('.') && /\.(wav|mp3|flac|ogg|aac|m4a)$/i.test(f))
        .sort();

      const meta = loadMeta();
      const bpm = getBpmMap();

      const tracks = files.map(name => {
        const stat = fs.statSync(path.join(musicDir, name));
        const trackMeta = meta.tracks[name] || { tags: [], genre: '', custom: {} };
        return {
          name,
          size: stat.size,
          modified: stat.mtime,
          bpm: bpm[name] || null,
          tags: trackMeta.tags,
          genre: trackMeta.genre,
          custom: trackMeta.custom
        };
      });

      res.json(tracks);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/tracks/tags — all unique tags
  router.get('/tags', (req, res) => {
    res.json(getAllTags());
  });

  // PUT /api/tracks/:filename/meta — update track metadata
  router.put('/:filename/meta', express.json(), (req, res) => {
    const { filename } = req.params;
    const filePath = path.join(musicDir, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'track not found' });
    }
    const updated = setTrackMeta(filename, req.body);
    res.json(updated);
  });

  // POST /api/tracks/bulk-tag — mass tagging
  router.post('/bulk-tag', express.json(), (req, res) => {
    const { filenames, tags, action } = req.body;
    if (!Array.isArray(filenames) || !Array.isArray(tags)) {
      return res.status(400).json({ error: 'filenames and tags must be arrays' });
    }
    const result = bulkTag(filenames, tags, action || 'add');
    res.json(result);
  });

  return router;
}

module.exports = { createTrackRouter, getTrackMeta, setTrackMeta, loadMeta, getAllTags };
