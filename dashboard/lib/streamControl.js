const fs = require('fs');
const path = require('path');

const CONTROL_FILE = '/shared/stream_control.json';

function normalizeStreaming(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
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
      return { streaming: normalizeStreaming(parsed.streaming), timestamp: parsed.timestamp || Date.now() };
    }
  } catch (e) {
    // If file is broken/partial, fail closed.
  }
  return writeControlState(false);
}

function setControlState(streaming) {
  return writeControlState(normalizeStreaming(streaming));
}

module.exports = { getControlState, setControlState };
