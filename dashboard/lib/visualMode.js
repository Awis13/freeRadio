const fs = require('fs');
const path = require('path');

const VISUAL_MODE_FILE = '/shared/visual_mode.json';
const VALID_MODES = ['radio', 'visual-radio', 'video-playlist'];

function getVisualMode() {
  try {
    if (fs.existsSync(VISUAL_MODE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(VISUAL_MODE_FILE, 'utf8'));
      return {
        mode: VALID_MODES.includes(parsed.mode) ? parsed.mode : 'visual-radio',
        radioVisual: parsed.radioVisual || null
      };
    }
  } catch (e) {
    // Ignore broken file
  }
  return { mode: 'visual-radio', radioVisual: null };
}

function setVisualMode(mode, radioVisual) {
  const current = getVisualMode();
  const payload = JSON.stringify({
    mode: VALID_MODES.includes(mode) ? mode : current.mode,
    radioVisual: radioVisual !== undefined ? radioVisual : current.radioVisual,
    timestamp: Date.now()
  });
  const tmpFile = `${VISUAL_MODE_FILE}.tmp`;
  fs.mkdirSync(path.dirname(VISUAL_MODE_FILE), { recursive: true });
  fs.writeFileSync(tmpFile, payload);
  fs.renameSync(tmpFile, VISUAL_MODE_FILE);
  return JSON.parse(payload);
}

module.exports = { getVisualMode, setVisualMode };
