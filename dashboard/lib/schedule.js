const fs = require('fs');
const express = require('express');
const liq = require('./liqClient');
const { resolvePlaylist, getPlaylist } = require('./playlist');
const { resolveVideoPlaylist, getVideoPlaylist } = require('./videoPlaylist');
const { appendEntry } = require('./history');

const SCHEDULE_FILE = '/shared/schedule.json';
const MUSIC_DIR = '/music';

let currentSlotId = null;
let currentPlaylistId = null;
let getBpmMapFn = () => ({});
let visualsDir = '/visuals';

function loadSchedule() {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    }
  } catch (e) {}
  return { weekly: {}, events: {}, settings: { timezone: 'Europe/Moscow', defaultPlaylistId: null, enabled: true } };
}

function saveSchedule(data) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(data, null, 2));
}

function getCurrentSlot() {
  const data = loadSchedule();
  if (!data.settings || data.settings.enabled === false) {
    return { slotId: null, playlistId: data.settings.defaultPlaylistId || null, label: null, source: 'disabled' };
  }

  const now = new Date();
  const currentDay = (now.getDay() + 6) % 7; // 0=Mon
  const currentTime = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const todayStr = now.toISOString().slice(0, 10);

  // Check one-time events first (higher priority)
  for (const ev of Object.values(data.events || {})) {
    if (ev.date === todayStr && isTimeInRange(currentTime, ev.startTime, ev.endTime)) {
      return {
        slotId: ev.id,
        playlistId: ev.playlistId,
        videoPlaylistId: ev.videoPlaylistId || null,
        label: ev.label || 'Event',
        source: 'event'
      };
    }
  }

  // Check weekly slots
  for (const ws of Object.values(data.weekly || {})) {
    if (ws.day === currentDay && isTimeInRange(currentTime, ws.startTime, ws.endTime)) {
      return {
        slotId: ws.id,
        playlistId: ws.playlistId,
        videoPlaylistId: ws.videoPlaylistId || null,
        label: ws.label || 'Weekly slot',
        source: 'weekly'
      };
    }
  }

  // Default
  return {
    slotId: null,
    playlistId: data.settings.defaultPlaylistId || null,
    videoPlaylistId: null,
    label: null,
    source: 'default'
  };
}

function getNextSlot() {
  const data = loadSchedule();
  const now = new Date();
  const currentDay = (now.getDay() + 6) % 7;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  let nearest = null;
  let nearestMinutes = Infinity;

  for (const ws of Object.values(data.weekly || {})) {
    const startParts = ws.startTime.split(':');
    const startMins = parseInt(startParts[0]) * 60 + parseInt(startParts[1]);
    let dayDiff = ws.day - currentDay;
    if (dayDiff < 0) dayDiff += 7;
    let totalMins = dayDiff * 1440 + startMins - currentMinutes;
    if (totalMins <= 0) totalMins += 7 * 1440;

    if (totalMins < nearestMinutes) {
      nearestMinutes = totalMins;
      nearest = ws;
    }
  }

  if (!nearest) return null;

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return {
    label: (nearest.label || 'Slot') + ' @ ' + DAYS[nearest.day] + ' ' + nearest.startTime,
    slotId: nearest.id
  };
}

function isTimeInRange(current, start, end) {
  if (end <= start) {
    // Overnight: e.g. 22:00 - 06:00
    return current >= start || current < end;
  }
  return current >= start && current < end;
}

// Schedule executor daemon
async function executeScheduleTick() {
  const slot = getCurrentSlot();
  const slotId = slot.slotId || 'default';
  const playlistId = slot.playlistId;

  // Slot changed?
  if (slotId !== currentSlotId) {
    console.log(`[schedule] Slot changed: ${currentSlotId} -> ${slotId} (playlist: ${playlistId})`);
    currentSlotId = slotId;
    currentPlaylistId = playlistId;

    if (playlistId) {
      // Switch playlist
      try {
        await liq.clearQueue();
        await liq.skip();
        const tracks = resolvePlaylist(playlistId, MUSIC_DIR, getBpmMapFn());
        const batch = tracks.slice(0, 5);
        for (const track of batch) {
          try { await liq.pushTrack('/music/' + track); } catch (e) {}
        }
        console.log(`[schedule] Loaded ${batch.length} tracks from playlist ${playlistId}`);
      } catch (e) {
        console.error('[schedule] Failed to switch playlist:', e.message);
      }
    }

    // Switch video playlist
    const videoPlaylistId = slot.videoPlaylistId;
    if (videoPlaylistId) {
      try {
        const resolved = resolveVideoPlaylist(videoPlaylistId, visualsDir);
        if (resolved.length > 0) {
          const ACTIVE_FILE = '/shared/active_visual_profile.json';
          const payload = JSON.stringify({
            id: videoPlaylistId,
            name: 'schedule-' + slotId,
            videos: resolved,
            activatedAt: Date.now()
          }, null, 2);
          fs.writeFileSync(ACTIVE_FILE, payload);
          console.log(`[schedule] Activated video playlist ${videoPlaylistId} (${resolved.length} videos)`);
        }
      } catch (e) {
        console.error('[schedule] Failed to switch video playlist:', e.message);
      }
    } else {
      // Deactivate video playlist — streamer falls back to all processed visuals
      const ACTIVE_FILE = "/shared/active_visual_profile.json";
      try {
        if (fs.existsSync(ACTIVE_FILE)) {
          fs.unlinkSync(ACTIVE_FILE);
          console.log("[schedule] Deactivated video playlist (slot has none)");
        }
      } catch (e) {}
    }
  }

  // Refill queue if running low
  if (currentPlaylistId) {
    try {
      const queueResult = await liq.getQueueLength();
      const len = (queueResult.data && typeof queueResult.data.length === 'number') ? queueResult.data.length : 0;
      if (len < 3) {
        const tracks = resolvePlaylist(currentPlaylistId, MUSIC_DIR, getBpmMapFn());
        if (tracks.length > 0) {
          // Pick random tracks to refill
          const needed = 5 - len;
          for (let i = 0; i < needed && i < tracks.length; i++) {
            const idx = Math.floor(Math.random() * tracks.length);
            try { await liq.pushTrack('/music/' + tracks[idx]); } catch (e) {}
          }
        }
      }
    } catch (e) {
      // Queue length endpoint might not exist yet
    }
  }
}

function startExecutor(getBpmMap, vDir) {
  getBpmMapFn = getBpmMap;
  if (vDir) visualsDir = vDir;
  console.log('[schedule] Executor started (interval: 30s)');
  // Run immediately, then every 30s
  executeScheduleTick();
  setInterval(executeScheduleTick, 30000);
}

// Track history hook — call from track poller
function onTrackChange(filename) {
  const slot = getCurrentSlot();
  const bpm = getBpmMapFn()[(filename || '').split('/').pop()] || null;
  appendEntry({
    ts: Date.now(),
    track: filename,
    bpm: bpm,
    playlistId: currentPlaylistId || null,
    slotId: currentSlotId || null
  });
}

function createScheduleRouter() {
  const router = express.Router();

  // GET /api/schedule — full schedule
  router.get('/', (req, res) => {
    res.json(loadSchedule());
  });

  // PUT /api/schedule — update settings
  router.put('/', express.json(), (req, res) => {
    const data = loadSchedule();
    if (req.body.settings) {
      data.settings = { ...data.settings, ...req.body.settings };
    }
    saveSchedule(data);
    res.json(data);
  });

  // GET /api/schedule/current — current active slot
  router.get('/current', (req, res) => {
    const slot = getCurrentSlot();
    const next = getNextSlot();
    let playlistName = null;
    if (slot.playlistId) {
      const pl = getPlaylist(slot.playlistId);
      if (pl) playlistName = pl.name;
    }
    let videoPlaylistName = null;
    if (slot.videoPlaylistId) {
      const vpl = getVideoPlaylist(slot.videoPlaylistId);
      if (vpl) videoPlaylistName = vpl.name;
    }
    res.json({
      ...slot,
      playlistName,
      videoPlaylistName,
      nextLabel: next ? next.label : null
    });
  });

  // POST /api/schedule/weekly — add weekly slot
  router.post('/weekly', express.json(), (req, res) => {
    const { day, startTime, endTime, playlistId, videoPlaylistId, label } = req.body;
    if (day === undefined || !startTime || !endTime) {
      return res.status(400).json({ error: 'day, startTime, endTime required' });
    }
    const data = loadSchedule();
    const id = 'ws_' + Date.now();
    data.weekly[id] = { id, day: parseInt(day), startTime, endTime, playlistId: playlistId || null, videoPlaylistId: videoPlaylistId || null, label: label || '' };
    saveSchedule(data);
    res.json(data.weekly[id]);
  });

  // DELETE /api/schedule/weekly/:id
  router.delete('/weekly/:id', (req, res) => {
    const data = loadSchedule();
    delete data.weekly[req.params.id];
    saveSchedule(data);
    res.json({ ok: true });
  });

  // POST /api/schedule/events — add one-time event
  router.post('/events', express.json(), (req, res) => {
    const { date, startTime, endTime, playlistId, videoPlaylistId, label, priority } = req.body;
    if (!date || !startTime || !endTime) {
      return res.status(400).json({ error: 'date, startTime, endTime required' });
    }
    const data = loadSchedule();
    const id = 'ev_' + Date.now();
    data.events[id] = { id, date, startTime, endTime, playlistId: playlistId || null, videoPlaylistId: videoPlaylistId || null, label: label || '', priority: priority || 10 };
    saveSchedule(data);
    res.json(data.events[id]);
  });

  // PUT /api/schedule/events/:id
  router.put('/events/:id', express.json(), (req, res) => {
    const data = loadSchedule();
    const ev = data.events[req.params.id];
    if (!ev) return res.status(404).json({ error: 'not found' });
    const ALLOWED_FIELDS = ["date", "startTime", "endTime", "playlistId", "videoPlaylistId", "label", "priority"];
    for (const key of ALLOWED_FIELDS) {
      if (req.body[key] !== undefined) ev[key] = req.body[key];
    }
    saveSchedule(data);
    res.json(ev);
  });

  // DELETE /api/schedule/events/:id
  router.delete('/events/:id', (req, res) => {
    const data = loadSchedule();
    delete data.events[req.params.id];
    saveSchedule(data);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createScheduleRouter, startExecutor, onTrackChange, getCurrentSlot };
