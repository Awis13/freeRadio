const fs = require('fs');

const CONTROL_FILE = '/shared/stream_control.json';

function getControlState() {
  try {
    if (fs.existsSync(CONTROL_FILE)) {
      return JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
    }
  } catch (e) {}
  return { streaming: true, timestamp: Date.now() };
}

function setControlState(streaming) {
  fs.writeFileSync(CONTROL_FILE, JSON.stringify({ streaming, timestamp: Date.now() }));
  return { streaming };
}

module.exports = { getControlState, setControlState };
