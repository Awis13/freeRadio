const fs = require('fs');
const express = require('express');
const paths = require('./paths');

const HISTORY_FILE = paths.shared('play_history.jsonl');
const startedAt = Date.now();

function appendEntry(entry) {
  const line = JSON.stringify(entry) + '\n';
  try {
    fs.appendFileSync(HISTORY_FILE, line);
  } catch (e) {
    // First write — create file
    fs.writeFileSync(HISTORY_FILE, line);
  }
}

function readHistory(limit) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const content = fs.readFileSync(HISTORY_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch (e) {}
    }
    if (limit) return entries.slice(-limit);
    return entries;
  } catch (e) {
    return [];
  }
}

function getStats() {
  const entries = readHistory();
  const trackCounts = {};
  entries.forEach(e => {
    const name = (e.track || '').split('/').pop();
    if (name) {
      trackCounts[name] = (trackCounts[name] || 0) + 1;
    }
  });

  const topTracks = Object.entries(trackCounts)
    .map(([track, count]) => ({ track, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return {
    totalPlayed: entries.length,
    uniqueTracks: Object.keys(trackCounts).length,
    topTracks,
    uptimeMs: Date.now() - startedAt,
    firstEntry: entries.length > 0 ? entries[0].ts : null,
    lastEntry: entries.length > 0 ? entries[entries.length - 1].ts : null
  };
}

function createHistoryRouter() {
  const router = express.Router();

  // GET /api/history?limit=50
  router.get('/', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json(readHistory(limit));
  });

  // GET /api/history/stats
  router.get('/stats', (req, res) => {
    res.json(getStats());
  });

  // GET /api/history/analytics
  router.get("/analytics", (req, res) => {
    const stats = getStats();
    const uptimeMs = stats.uptimeMs || 0;
    const hours = Math.floor(uptimeMs / 3600000);
    const mins = Math.floor((uptimeMs % 3600000) / 60000);
    res.json({
      totalTracks: stats.totalPlayed || 0,
      uniqueTracks: stats.uniqueTracks || 0,
      peakListeners: 0,
      uptime: hours > 0 ? hours + "h " + mins + "m" : mins + "m"
    });
  });


  return router;
}

module.exports = { createHistoryRouter, appendEntry, readHistory, getStats };
