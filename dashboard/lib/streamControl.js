const fs = require('fs');
const path = require('path');

const CONTROL_FILE = '/shared/stream_control.json';

function normalizeStreaming(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return null;
}

function writeControlState(streaming) {
  const payload = JSON.stringify({ streaming, timestamp: Date.now() });
  const tmpFile = `${CONTROL_FILE}.tmp`;
  fs.mkdirSync(path.dirname(CONTROL_FILE), { recursive: true });
  fs.writeFileSync(tmpFile, payload);
  fs.renameSync(tmpFile, CONTROL_FILE);
  return { streaming };
}

function getControlState() {
  try {
    if (fs.existsSync(CONTROL_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
      const normalized = normalizeStreaming(parsed.streaming);
      if (normalized !== null) {
        return { streaming: normalized, timestamp: parsed.timestamp || Date.now() };
      }
    }
  } catch (e) {
    // Ignore broken file and restore default-off state.
  }
  return writeControlState(false);
}

function setControlState(streaming) {
  const normalized = normalizeStreaming(streaming);
  if (normalized === null) {
    return getControlState();
  }
  return writeControlState(normalized);
}

module.exports = { getControlState, setControlState };
