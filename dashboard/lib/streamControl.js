const fs = require('fs');
const path = require('path');

const CONTROL_FILE = '/shared/stream_control.json';
const MODE_FILE = '/shared/stream_mode.json';

function normalizeBool(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return null;
}

function writeControlState(streaming, broadcast) {
  const payload = JSON.stringify({ streaming, broadcast: !!broadcast, timestamp: Date.now() });
  const tmpFile = `${CONTROL_FILE}.tmp`;
  fs.mkdirSync(path.dirname(CONTROL_FILE), { recursive: true });
  fs.writeFileSync(tmpFile, payload);
  fs.renameSync(tmpFile, CONTROL_FILE);
  return { streaming, broadcast: !!broadcast };
}

function getControlState() {
  try {
    if (fs.existsSync(CONTROL_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
      const normalized = normalizeBool(parsed.streaming);
      if (normalized !== null) {
        return { streaming: normalized, broadcast: !!parsed.broadcast, timestamp: parsed.timestamp || Date.now() };
      }
    }
  } catch (e) {
    // Ignore broken file and restore default-off state.
  }
  return writeControlState(false, false);
}

function setControlState(streaming, broadcast) {
  const current = getControlState();
  const ns = normalizeBool(streaming);
  const finalStreaming = ns !== null ? ns : current.streaming;
  const finalBroadcast = broadcast !== undefined ? !!broadcast : current.broadcast;
  // Skip write if values unchanged — avoids timestamp-only rewrites that trigger ffmpeg restart via sig change
  if (finalStreaming === current.streaming && finalBroadcast === current.broadcast) {
    return { streaming: current.streaming, broadcast: current.broadcast };
  }
  return writeControlState(finalStreaming, finalBroadcast);
}

function getModeState() {
  try {
    if (fs.existsSync(MODE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
      return {
        mode: parsed.mode === 'live' ? 'live' : 'standby',
        standbyVisual: parsed.standbyVisual || null
      };
    }
  } catch (e) {
    // Ignore broken file
  }
  return { mode: 'standby', standbyVisual: null };
}

function setModeState(mode, standbyVisual) {
  const current = getModeState();
  const payload = JSON.stringify({
    mode: mode || current.mode,
    standbyVisual: standbyVisual !== undefined ? standbyVisual : current.standbyVisual,
    timestamp: Date.now()
  });
  const tmpFile = `${MODE_FILE}.tmp`;
  fs.mkdirSync(path.dirname(MODE_FILE), { recursive: true });
  fs.writeFileSync(tmpFile, payload);
  fs.renameSync(tmpFile, MODE_FILE);
  return JSON.parse(payload);
}

module.exports = { getControlState, setControlState, getModeState, setModeState };
