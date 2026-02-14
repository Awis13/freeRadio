const fs = require('fs');

const VIDEO_FILE = '/shared/stream_video.json';

// Video enhancement filter chain
const VIDEO_ENHANCEMENT_FILTER = 'eq=saturation=1.15:contrast=1.03,unsharp=3:3:0.5,deband';

function getVideoSettings() {
  try {
    if (fs.existsSync(VIDEO_FILE)) {
      const data = JSON.parse(fs.readFileSync(VIDEO_FILE, 'utf8'));
      return { enhanced: data.enhanced === true };
    }
  } catch (e) {}
  return { enhanced: false };
}

function setVideoSettings(settings) {
  const data = {
    enhanced: settings.enhanced === true,
    timestamp: Date.now()
  };
  fs.writeFileSync(VIDEO_FILE, JSON.stringify(data));
  return data;
}

function getVideoEnhancementFilter() {
  const settings = getVideoSettings();
  return settings.enhanced ? VIDEO_ENHANCEMENT_FILTER : null;
}

module.exports = { getVideoSettings, setVideoSettings, getVideoEnhancementFilter };
