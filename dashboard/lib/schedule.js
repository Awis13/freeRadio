const fs = require('fs');
const path = require('path');
const express = require('express');
const liq = require('./liqClient');
const { resolvePlaylist, getPlaylist } = require('./playlist');
const { resolveVideoPlaylist, getVideoPlaylist } = require('./videoPlaylist');
const { appendEntry } = require('./history');

const SCHEDULE_FILE = '/shared/schedule.json';
const MUSIC_DIR = '/music';
const PROCESSED_DIR = '/music/processed';

let currentSlotId = null;
let currentPlaylistId = null;
let getBpmMapFn = () => ({});
let visualsDir = '/visuals';
let broadcastFn = null;

// Конвертация имени файла в путь к обработанному .wav (как в queue.js)
function toProcessedPath(filename) {
  const base = path.basename(filename, path.extname(filename));
  return PROCESSED_DIR + '/' + base + '.wav';
}

function loadSchedule() {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    }
  } catch (e) {}
  return { weekly: {}, events: {}, settings: { timezone: 'Europe/Moscow', defaultPlaylistId: null, defaultVideoPlaylistId: null, enabled: true } };
}

function saveSchedule(data) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(data, null, 2));
}

// Получить текущее время в настроенной таймзоне
function getNowInTimezone(timezone) {
  try {
    const now = new Date();
    const str = now.toLocaleString('en-US', { timeZone: timezone, hour12: false });
    // Формат: "M/D/YYYY, HH:MM:SS"
    const parts = str.split(', ');
    const dateParts = parts[0].split('/');
    const timeParts = parts[1].split(':');
    const month = parseInt(dateParts[0]);
    const day = parseInt(dateParts[1]);
    const year = parseInt(dateParts[2]);
    const hours = parseInt(timeParts[0]) % 24; // 24:00:00 → 0
    const minutes = parseInt(timeParts[1]);
    // День недели: нужен из оригинального now, но скорректированный по таймзоне
    const tzDate = new Date(year, month - 1, day, hours, minutes);
    const weekday = (tzDate.getDay() + 6) % 7; // 0=Mon
    const timeStr = String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
    const dateStr = year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    return { weekday, timeStr, dateStr };
  } catch (e) {
    // Fallback на серверное время если таймзона невалидна
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
  if (!data.settings || data.settings.enabled === false) {
    return {
      slotId: null,
      playlistId: data.settings.defaultPlaylistId || null,
      videoPlaylistId: data.settings.defaultVideoPlaylistId || null,
      label: null,
      source: 'disabled'
    };
  }

  const tz = (data.settings && data.settings.timezone) || 'Europe/Moscow';
  const { weekday, timeStr, dateStr } = getNowInTimezone(tz);

  // One-time events first (higher priority), sorted by priority (lower = higher)
  const events = Object.values(data.events || {})
    .filter(ev => ev.date === dateStr && isTimeInRange(timeStr, ev.startTime, ev.endTime))
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

  // Weekly slots
  for (const ws of Object.values(data.weekly || {})) {
    if (ws.day === weekday && isTimeInRange(timeStr, ws.startTime, ws.endTime)) {
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
    // Будущий или сегодня но не начавшийся
    if (ev.date < dateStr) continue;
    if (ev.date === dateStr) {
      if (ev.startTime <= timeStr && isTimeInRange(timeStr, ev.startTime, ev.endTime)) continue; // уже активен
      if (ev.startTime <= timeStr) continue; // уже прошёл сегодня
    }
    // Сколько минут до старта
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

function isTimeInRange(current, start, end) {
  if (end <= start) {
    // Overnight: e.g. 22:00 - 06:00
    return current >= start || current < end;
  }
  return current >= start && current < end;
}

// Проверка перекрытия слотов
function slotsOverlap(a, b) {
  if (a.day !== b.day) return false;

  // Нормализуем overnight в минуты
  function toRange(start, end) {
    const s = parseInt(start.split(':')[0]) * 60 + parseInt(start.split(':')[1]);
    let e = parseInt(end.split(':')[0]) * 60 + parseInt(end.split(':')[1]);
    if (e <= s) e += 1440; // overnight
    return { s, e };
  }

  const ra = toRange(a.startTime, a.endTime);
  const rb = toRange(b.startTime, b.endTime);

  return ra.s < rb.e && rb.s < ra.e;
}

// Очистка прошедших one-time events
function cleanupPastEvents(data) {
  const today = new Date().toISOString().slice(0, 10);
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

  // Refill queue if running low (с дедупликацией)
  if (currentPlaylistId) {
    try {
      const queueResult = await liq.getQueueLength();
      const len = (queueResult.data && typeof queueResult.data.length === 'number') ? queueResult.data.length : 0;
      if (len < 3) {
        const tracks = resolvePlaylist(currentPlaylistId, MUSIC_DIR, getBpmMapFn());
        if (tracks.length > 0) {
          const needed = 5 - len;
          // Fisher-Yates shuffle копии, берём первые needed
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

  // Очистка прошедших событий при старте
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
    const newSlot = { day: parseInt(day), startTime, endTime };

    // Проверка перекрытия
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

    // Проверка перекрытия (исключая себя)
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

  // POST /api/schedule/cleanup — ручная очистка прошедших событий
  router.post('/cleanup', (req, res) => {
    const data = loadSchedule();
    const cleaned = cleanupPastEvents(data);
    if (cleaned > 0) saveSchedule(data);
    res.json({ cleaned });
  });

  return router;
}

module.exports = { createScheduleRouter, startExecutor, onTrackChange, getCurrentSlot };
