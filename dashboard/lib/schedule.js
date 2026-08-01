const fs = require('fs');
const path = require('path');
const express = require('express');
const liq = require('./liqClient');
const { resolvePlaylist, getPlaylist } = require('./playlist');
const { resolveVideoPlaylist, getVideoPlaylist } = require('./videoPlaylist');
const { appendEntry } = require('./history');
const paths = require('./paths');
const { readStore, writeStore } = require('./jsonStore');

const SCHEDULE_FILE = paths.shared('schedule.json');
const MUSIC_DIR = paths.MUSIC_DIR;
const PROCESSED_DIR = paths.PROCESSED_DIR;

let currentSlotId = null;
let currentPlaylistId = null;
let getBpmMapFn = () => ({});
let visualsDir = paths.VISUALS_DIR;
let broadcastFn = null;

// Convert filename to processed .wav path (same as queue.js)
function toProcessedPath(filename) {
  const base = path.basename(filename, path.extname(filename));
  return PROCESSED_DIR + '/' + base + '.wav';
}

function loadSchedule() {
  return readStore(SCHEDULE_FILE, { weekly: {}, events: {}, settings: { timezone: 'Europe/Moscow', defaultPlaylistId: null, defaultVideoPlaylistId: null, enabled: true } });
}

function saveSchedule(data) {
  writeStore(SCHEDULE_FILE, data);
}

// Get current time in configured timezone (via Intl.DateTimeFormat)
function getNowInTimezone(timezone) {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
    const parts = {};
    for (const p of fmt.formatToParts(now)) {
      parts[p.type] = p.value;
    }
    const year = parseInt(parts.year);
    const month = parseInt(parts.month);
    const day = parseInt(parts.day);
    // formatToParts returns '24' for midnight — adjust date
    let hours = parseInt(parts.hour);
    const minutes = parseInt(parts.minute);
    let correctedDay = day, correctedMonth = month, correctedYear = year;
    if (hours === 24) {
      // Midnight: date in parts is previous day, need next
      const next = new Date(year, month - 1, day + 1);
      correctedYear = next.getFullYear();
      correctedMonth = next.getMonth() + 1;
      correctedDay = next.getDate();
      hours = 0;
    }
    const tzDate = new Date(correctedYear, correctedMonth - 1, correctedDay, hours, minutes);
    const weekday = (tzDate.getDay() + 6) % 7; // 0=Mon
    const timeStr = String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
    const dateStr = correctedYear + '-' + String(correctedMonth).padStart(2, '0') + '-' + String(correctedDay).padStart(2, '0');
    return { weekday, timeStr, dateStr };
  } catch (e) {
    // Fallback to server time if timezone is invalid
    const now = new Date();
    return {
      weekday: (now.getDay() + 6) % 7,
      timeStr: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
      dateStr: now.toISOString().slice(0, 10)
    };
  }
}

function getCurrentSlot() {
  const data = loadSchedule();
  const settings = data.settings || {};
  if (!data.settings || settings.enabled === false) {
    return {
      slotId: null,
      playlistId: settings.defaultPlaylistId || null,
      videoPlaylistId: settings.defaultVideoPlaylistId || null,
      label: null,
      source: 'disabled'
    };
  }

  const tz = (data.settings && data.settings.timezone) || 'Europe/Moscow';
  const { weekday, timeStr, dateStr } = getNowInTimezone(tz);

  // One-time events first (higher priority), sorted by priority (lower = higher)
  // For overnight events (end <= start) also check yesterday's date
  const yesterday = prevDate(dateStr);
  const events = Object.values(data.events || {})
    .filter(ev => {
      if (ev.date === dateStr && isTimeInRange(timeStr, ev.startTime, ev.endTime)) return true;
      // Overnight event started yesterday: end <= start, current time < end
      if (ev.endTime <= ev.startTime && ev.date === yesterday && timeStr < ev.endTime) return true;
      return false;
    })
    .sort((a, b) => (a.priority || 10) - (b.priority || 10));

  if (events.length > 0) {
    const ev = events[0];
    return {
      slotId: ev.id,
      playlistId: ev.playlistId,
      videoPlaylistId: ev.videoPlaylistId || null,
      label: ev.label || 'Event',
      source: 'event'
    };
  }

  // Weekly slots (with overnight support: slot day=1 22:00-06:00 active at day=2 03:00)
  for (const ws of Object.values(data.weekly || {})) {
    const isOvernight = ws.endTime <= ws.startTime;
    const matchSameDay = ws.day === weekday && isTimeInRange(timeStr, ws.startTime, ws.endTime);
    const matchNextDay = isOvernight && (ws.day + 1) % 7 === weekday && timeStr < ws.endTime;
    if (matchSameDay || matchNextDay) {
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
    videoPlaylistId: data.settings.defaultVideoPlaylistId || null,
    label: null,
    source: 'default'
  };
}

function getNextSlot() {
  const data = loadSchedule();
  const tz = (data.settings && data.settings.timezone) || 'Europe/Moscow';
  const { weekday, timeStr, dateStr } = getNowInTimezone(tz);
  const currentMinutes = parseInt(timeStr.split(':')[0]) * 60 + parseInt(timeStr.split(':')[1]);

  let nearest = null;
  let nearestMinutes = Infinity;

  // Check weekly slots
  for (const ws of Object.values(data.weekly || {})) {
    const startParts = ws.startTime.split(':');
    const startMins = parseInt(startParts[0]) * 60 + parseInt(startParts[1]);
    let dayDiff = ws.day - weekday;
    if (dayDiff < 0) dayDiff += 7;
    let totalMins = dayDiff * 1440 + startMins - currentMinutes;
    if (totalMins <= 0) totalMins += 7 * 1440;

    if (totalMins < nearestMinutes) {
      nearestMinutes = totalMins;
      nearest = { type: 'weekly', slot: ws };
    }
  }

  // Check one-time events (future ones)
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  for (const ev of Object.values(data.events || {})) {
    // Future or today but not started yet
    if (ev.date < dateStr) continue;
    if (ev.date === dateStr) {
      if (ev.startTime <= timeStr && isTimeInRange(timeStr, ev.startTime, ev.endTime)) continue; // already active
      if (ev.startTime <= timeStr) continue; // already passed today
    }
    // Minutes until start
    const evDate = new Date(ev.date + 'T' + ev.startTime + ':00');
    const nowApprox = new Date(dateStr + 'T' + timeStr + ':00');
    const diffMs = evDate - nowApprox;
    const totalMins = Math.max(1, Math.floor(diffMs / 60000));

    if (totalMins < nearestMinutes) {
      nearestMinutes = totalMins;
      nearest = { type: 'event', slot: ev };
    }
  }

  if (!nearest) return null;

  if (nearest.type === 'weekly') {
    return {
      label: (nearest.slot.label || 'Slot') + ' @ ' + DAYS[nearest.slot.day] + ' ' + nearest.slot.startTime,
      slotId: nearest.slot.id
    };
  } else {
    return {
      label: (nearest.slot.label || 'Event') + ' @ ' + nearest.slot.date + ' ' + nearest.slot.startTime,
      slotId: nearest.slot.id
    };
  }
}

// Previous date (YYYY-MM-DD) — for overnight event matching
function prevDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function isTimeInRange(current, start, end) {
  if (end <= start) {
    // Overnight: e.g. 22:00 - 06:00
    return current >= start || current < end;
  }
  return current >= start && current < end;
}

// Check slot overlap (with overnight cross-day support)
function slotsOverlap(a, b) {
  function toMinutes(t) {
    const p = t.split(':');
    return parseInt(p[0]) * 60 + parseInt(p[1]);
  }
  function isOvernight(slot) {
    return toMinutes(slot.endTime) <= toMinutes(slot.startTime);
  }
  function rangesOverlap(s1, e1, s2, e2) {
    return s1 < e2 && s2 < e1;
  }

  const as = toMinutes(a.startTime), ae = toMinutes(a.endTime);
  const bs = toMinutes(b.startTime), be = toMinutes(b.endTime);

  // Same day: both slots start on this day
  if (a.day === b.day) {
    const aEnd = isOvernight(a) ? ae + 1440 : ae;
    const bEnd = isOvernight(b) ? be + 1440 : be;
    if (rangesOverlap(as, aEnd, bs, bEnd)) return true;
  }

  // A overnight and B on next day (morning part of A overlaps B)
  if (isOvernight(a) && (a.day + 1) % 7 === b.day) {
    const bEnd = isOvernight(b) ? be + 1440 : be;
    if (rangesOverlap(0, ae, bs, bEnd)) return true;
  }

  // B overnight and A on next day (morning part of B overlaps A)
  if (isOvernight(b) && (b.day + 1) % 7 === a.day) {
    const aEnd = isOvernight(a) ? ae + 1440 : ae;
    if (rangesOverlap(as, aEnd, 0, be)) return true;
  }

  return false;
}

// Clean up past one-time events (timezone-aware)
function cleanupPastEvents(data) {
  const tz = (data.settings && data.settings.timezone) || 'Europe/Moscow';
  const today = getNowInTimezone(tz).dateStr;
  let cleaned = 0;
  for (const [id, ev] of Object.entries(data.events || {})) {
    if (ev.date < today) {
      delete data.events[id];
      cleaned++;
    }
  }
  return cleaned;
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

    // WebSocket notification
    if (broadcastFn) {
      broadcastFn('schedule-slot', {
        slotId,
        playlistId,
        videoPlaylistId: slot.videoPlaylistId,
        label: slot.label,
        source: slot.source
      });
    }

    if (playlistId) {
      // Switch playlist
      try {
        await liq.clearQueue();
        await liq.skip();
        const tracks = resolvePlaylist(playlistId, MUSIC_DIR, getBpmMapFn());
        const batch = tracks.slice(0, 5);
        for (const track of batch) {
          try { await liq.pushTrack(toProcessedPath(track)); } catch (e) {}
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
          const ACTIVE_FILE = paths.shared('active_visual_profile.json');
          writeStore(ACTIVE_FILE, {
            id: videoPlaylistId,
            name: 'schedule-' + slotId,
            videos: resolved,
            activatedAt: Date.now()
          });
          console.log(`[schedule] Activated video playlist ${videoPlaylistId} (${resolved.length} videos)`);
        }
      } catch (e) {
        console.error('[schedule] Failed to switch video playlist:', e.message);
      }
    } else {
      // Deactivate video playlist — streamer falls back to all processed visuals
      const ACTIVE_FILE = paths.shared('active_visual_profile.json');
      try {
        if (fs.existsSync(ACTIVE_FILE)) {
          fs.unlinkSync(ACTIVE_FILE);
          console.log("[schedule] Deactivated video playlist (slot has none)");
        }
      } catch (e) {}
    }
  }

  // Refill queue if running low (with deduplication)
  if (currentPlaylistId) {
    try {
      const queueResult = await liq.getQueueLength();
      const len = (queueResult.data && typeof queueResult.data.length === 'number') ? queueResult.data.length : 0;
      if (len < 3) {
        const tracks = resolvePlaylist(currentPlaylistId, MUSIC_DIR, getBpmMapFn());
        if (tracks.length > 0) {
          const needed = 5 - len;
          // Fisher-Yates shuffle a copy, take first needed
          const shuffled = tracks.slice();
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = shuffled[i];
            shuffled[i] = shuffled[j];
            shuffled[j] = tmp;
          }
          for (let i = 0; i < needed && i < shuffled.length; i++) {
            try { await liq.pushTrack(toProcessedPath(shuffled[i])); } catch (e) {}
          }
        }
      }
    } catch (e) {
      // Queue length endpoint might not exist yet
    }
  }
}

function startExecutor(getBpmMap, vDir, broadcast) {
  getBpmMapFn = getBpmMap;
  if (vDir) visualsDir = vDir;
  if (broadcast) broadcastFn = broadcast;
  console.log('[schedule] Executor started (interval: 30s)');

  // Clean up past events on start
  const data = loadSchedule();
  const cleaned = cleanupPastEvents(data);
  if (cleaned > 0) {
    saveSchedule(data);
    console.log(`[schedule] Cleaned up ${cleaned} past events`);
  }

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

  // PUT /api/schedule — update settings (whitelist)
  router.put('/', express.json(), (req, res) => {
    const data = loadSchedule();
    if (req.body.settings) {
      const ALLOWED_SETTINGS = ['timezone', 'defaultPlaylistId', 'defaultVideoPlaylistId', 'enabled'];
      for (const key of ALLOWED_SETTINGS) {
        if (req.body.settings[key] !== undefined) data.settings[key] = req.body.settings[key];
      }
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
    const newSlot = { day: parseInt(day), startTime, endTime };

    // Check overlap
    const overlapping = Object.values(data.weekly || {}).filter(ws => slotsOverlap(ws, newSlot));
    if (overlapping.length > 0) {
      return res.status(409).json({
        error: 'overlaps with existing slot',
        conflictWith: overlapping.map(ws => ({ id: ws.id, label: ws.label, startTime: ws.startTime, endTime: ws.endTime }))
      });
    }

    const id = 'ws_' + Date.now();
    data.weekly[id] = { id, ...newSlot, playlistId: playlistId || null, videoPlaylistId: videoPlaylistId || null, label: label || '' };
    saveSchedule(data);
    res.json(data.weekly[id]);
  });

  // PUT /api/schedule/weekly/:id — update weekly slot
  router.put('/weekly/:id', express.json(), (req, res) => {
    const data = loadSchedule();
    const ws = data.weekly[req.params.id];
    if (!ws) return res.status(404).json({ error: 'not found' });

    const ALLOWED_FIELDS = ["day", "startTime", "endTime", "playlistId", "videoPlaylistId", "label"];
    for (const key of ALLOWED_FIELDS) {
      if (req.body[key] !== undefined) ws[key] = req.body[key];
    }
    if (ws.day !== undefined) ws.day = parseInt(ws.day);

    // Check overlap (excluding self)
    const overlapping = Object.values(data.weekly)
      .filter(other => other.id !== ws.id && slotsOverlap(other, ws));
    if (overlapping.length > 0) {
      return res.status(409).json({
        error: 'overlaps with existing slot',
        conflictWith: overlapping.map(s => ({ id: s.id, label: s.label, startTime: s.startTime, endTime: s.endTime }))
      });
    }

    saveSchedule(data);
    res.json(ws);
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

  // POST /api/schedule/cleanup — manual cleanup of past events
  router.post('/cleanup', (req, res) => {
    const data = loadSchedule();
    const cleaned = cleanupPastEvents(data);
    if (cleaned > 0) saveSchedule(data);
    res.json({ cleaned });
  });

  return router;
}

module.exports = { createScheduleRouter, startExecutor, onTrackChange, getCurrentSlot };

// Export internal functions for unit tests
module.exports._test = {
  isTimeInRange, slotsOverlap, getNowInTimezone, getCurrentSlot,
  getNextSlot, cleanupPastEvents, prevDate, loadSchedule, saveSchedule,
  executeScheduleTick, startExecutor
};
