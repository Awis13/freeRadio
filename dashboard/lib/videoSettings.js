const paths = require('./paths');
const { readStore, writeStore } = require('./jsonStore');

const VIDEO_FILE = paths.shared('stream_video.json');

// Video enhancement filter chain
const VIDEO_ENHANCEMENT_FILTER = 'eq=saturation=1.15:contrast=1.03,unsharp=3:3:0.5,deband';

function getVideoSettings() {
  // readStore never throws — no catch needed around it.
  const data = readStore(VIDEO_FILE, null);
  if (data) {
    return { enhanced: data.enhanced === true };
  }
  return { enhanced: false };
}

function setVideoSettings(settings) {
  const data = {
    enhanced: settings.enhanced === true,
    timestamp: Date.now()
  };
  writeStore(VIDEO_FILE, data, { indent: 0 });
  return data;
}

function getVideoEnhancementFilter() {
  const settings = getVideoSettings();
  return settings.enhanced ? VIDEO_ENHANCEMENT_FILTER : null;
}

module.exports = { getVideoSettings, setVideoSettings, getVideoEnhancementFilter };
