const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');

const LIVE_MODE_FILE = paths.shared('live_mode.json');

const VALID_SOURCES = ['obs', 'browser-mic'];
const VALID_FALLBACKS = ['visual-radio', 'video-playlist'];

function getDefaults() {
  return {
    source: 'obs',
    afkFallback: 'visual-radio',
    obsStatus: 'offline',
    ingestKey: generateIngestKey(),
    timestamp: Date.now()
  };
}

function getLiveMode() {
  try {
    if (fs.existsSync(LIVE_MODE_FILE)) {
      const data = JSON.parse(fs.readFileSync(LIVE_MODE_FILE, 'utf8'));
      return {
        source: VALID_SOURCES.includes(data.source) ? data.source : 'obs',
        afkFallback: VALID_FALLBACKS.includes(data.afkFallback) ? data.afkFallback : 'visual-radio',
        obsStatus: data.obsStatus || 'offline',
        ingestKey: data.ingestKey || generateIngestKey(),
        timestamp: data.timestamp || Date.now()
      };
    }
  } catch (e) {
    // Ignore broken file
  }
  // First run: persist defaults so the key stays stable
  const defaults = getDefaults();
  atomicWrite(defaults);
  return defaults;
}

function setLiveMode(updates) {
  const current = getLiveMode();
  const payload = {
    source: VALID_SOURCES.includes(updates.source) ? updates.source : current.source,
    afkFallback: VALID_FALLBACKS.includes(updates.afkFallback) ? updates.afkFallback : current.afkFallback,
    obsStatus: current.obsStatus,
    ingestKey: current.ingestKey,
    timestamp: Date.now()
  };
  atomicWrite(payload);
  return payload;
}

function setObsStatus(status) {
  const current = getLiveMode();
  current.obsStatus = status;
  current.timestamp = Date.now();
  atomicWrite(current);
  return current;
}

function generateIngestKey() {
  return crypto.randomUUID();
}

function regenerateIngestKey() {
  const current = getLiveMode();
  current.ingestKey = generateIngestKey();
  current.timestamp = Date.now();
  atomicWrite(current);
  return current;
}

function atomicWrite(data) {
  const tmpFile = `${LIVE_MODE_FILE}.tmp`;
  fs.mkdirSync(path.dirname(LIVE_MODE_FILE), { recursive: true });
  fs.writeFileSync(tmpFile, JSON.stringify(data));
  fs.renameSync(tmpFile, LIVE_MODE_FILE);
}

module.exports = { getLiveMode, setLiveMode, setObsStatus, regenerateIngestKey };
