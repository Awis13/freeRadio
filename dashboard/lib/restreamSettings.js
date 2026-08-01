const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const SETTINGS_FILE = paths.shared('restream_settings.json');

function normalizeAutoStart(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function writeSettings(settings) {
  const payload = JSON.stringify({
    autoStart: normalizeAutoStart(settings.autoStart),
    updatedAt: Date.now()
  });
  const tmpFile = `${SETTINGS_FILE}.tmp`;
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(tmpFile, payload);
  fs.renameSync(tmpFile, SETTINGS_FILE);
}

function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return { autoStart: normalizeAutoStart(parsed.autoStart) };
    }
  } catch (e) {
    // Ignore broken file and fall back to safe default.
  }
  return { autoStart: false };
}

function setAutoStart(autoStart) {
  const settings = { autoStart: normalizeAutoStart(autoStart) };
  writeSettings(settings);
  return settings;
}

module.exports = { getSettings, setAutoStart };
