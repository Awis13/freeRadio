const fs = require('fs');
const path = require('path');

const VISUAL_MODE_FILE = '/shared/visual_mode.json';
const VALID_MODES = ['live', 'visual-radio', 'video-playlist'];

function getVisualMode() {
  try {
    if (fs.existsSync(VISUAL_MODE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(VISUAL_MODE_FILE, 'utf8'));
      // Migration: treat legacy 'radio' as 'live'
      let mode = parsed.mode;
      if (mode === 'radio') mode = 'live';
      return {
        mode: VALID_MODES.includes(mode) ? mode : 'visual-radio'
      };
    }
  } catch (e) {
    // Ignore broken file
  }
  return { mode: 'visual-radio' };
}

function setVisualMode(mode) {
  // Migration: treat legacy 'radio' as 'live'
  if (mode === 'radio') mode = 'live';
  const current = getVisualMode();
  const payload = JSON.stringify({
    mode: VALID_MODES.includes(mode) ? mode : current.mode,
    timestamp: Date.now()
  });
  const tmpFile = `${VISUAL_MODE_FILE}.tmp`;
  fs.mkdirSync(path.dirname(VISUAL_MODE_FILE), { recursive: true });
  fs.writeFileSync(tmpFile, payload);
  fs.renameSync(tmpFile, VISUAL_MODE_FILE);
  return JSON.parse(payload);
}

module.exports = { getVisualMode, setVisualMode };
