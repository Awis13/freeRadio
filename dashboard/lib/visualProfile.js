const fs = require('fs');
const path = require('path');
const express = require('express');

const PROFILES_FILE = '/shared/visual_profiles.json';
const ACTIVE_FILE = '/shared/active_visual_profile.json';

function loadProfiles() {
  try {
    if (fs.existsSync(PROFILES_FILE)) {
      return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
    }
  } catch (e) {}
  return { profiles: {} };
}

function saveProfiles(data) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(data, null, 2));
}

function getActiveProfile() {
  try {
    if (fs.existsSync(ACTIVE_FILE)) {
      return JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8'));
    }
  } catch (e) {}
  return null;
}

function activateProfile(id) {
  const data = loadProfiles();
  const profile = data.profiles[id];
  if (!profile) return null;

  const active = {
    id: profile.id,
    name: profile.name,
    videos: profile.videos,
    activatedAt: Date.now()
  };
  fs.writeFileSync(ACTIVE_FILE, JSON.stringify(active, null, 2));
  return active;
}

function deactivateProfile() {
  if (fs.existsSync(ACTIVE_FILE)) {
    fs.unlinkSync(ACTIVE_FILE);
  }
}

function createVisualProfileRouter(visualsDir) {
  const router = express.Router();

  // GET /api/visual-profiles — list all + active status
  router.get('/', (req, res) => {
    const data = loadProfiles();
    const active = getActiveProfile();
    const list = Object.values(data.profiles).map(p => ({
      ...p,
      videoCount: (p.videos || []).length,
      isActive: active && active.id === p.id
    }));
    res.json({ profiles: list, activeId: active ? active.id : null });
  });

  // POST /api/visual-profiles — create
  router.post('/', express.json(), (req, res) => {
    const { name, videos } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const id = 'vp_' + Date.now();
    const now = Date.now();
    const profile = {
      id,
      name,
      videos: Array.isArray(videos) ? videos : [],
      createdAt: now,
      updatedAt: now
    };

    const data = loadProfiles();
    data.profiles[id] = profile;
    saveProfiles(data);
    res.json(profile);
  });

  // GET /api/visual-profiles/:id
  router.get('/:id', (req, res) => {
    const data = loadProfiles();
    const profile = data.profiles[req.params.id];
    if (!profile) return res.status(404).json({ error: 'not found' });

    // Verify which videos still exist
    const existing = (profile.videos || []).filter(v =>
      fs.existsSync(path.join(visualsDir, v))
    );

    const active = getActiveProfile();
    res.json({
      ...profile,
      existingVideos: existing,
      isActive: active && active.id === profile.id
    });
  });

  // PUT /api/visual-profiles/:id
  router.put('/:id', express.json(), (req, res) => {
    const data = loadProfiles();
    const existing = data.profiles[req.params.id];
    if (!existing) return res.status(404).json({ error: 'not found' });

    if (req.body.name !== undefined) existing.name = req.body.name;
    if (req.body.videos !== undefined) existing.videos = req.body.videos;
    existing.updatedAt = Date.now();

    data.profiles[req.params.id] = existing;
    saveProfiles(data);

    // If this is the active profile, update active file too
    const active = getActiveProfile();
    if (active && active.id === req.params.id) {
      activateProfile(req.params.id);
    }

    res.json(existing);
  });

  // DELETE /api/visual-profiles/:id
  router.delete('/:id', (req, res) => {
    const data = loadProfiles();
    if (!data.profiles[req.params.id]) {
      return res.status(404).json({ error: 'not found' });
    }

    // Deactivate if active
    const active = getActiveProfile();
    if (active && active.id === req.params.id) {
      deactivateProfile();
    }

    delete data.profiles[req.params.id];
    saveProfiles(data);
    res.json({ ok: true });
  });

  // POST /api/visual-profiles/:id/activate
  router.post('/:id/activate', (req, res) => {
    const result = activateProfile(req.params.id);
    if (!result) return res.status(404).json({ error: 'not found' });
    res.json(result);
  });

  // POST /api/visual-profiles/deactivate
  router.post('/deactivate', (req, res) => {
    deactivateProfile();
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createVisualProfileRouter, getActiveProfile, activateProfile };
