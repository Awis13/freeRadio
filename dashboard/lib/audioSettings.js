const paths = require('./paths');
const { readStore, writeStore } = require('./jsonStore');

const AUDIO_FILE = paths.shared('stream_audio.json');

const AUDIO_ENHANCEMENT_FILTER = 'loudnorm=I=-14:TP=-1.5:LRA=11,mcompand=0.005,0.1 6.3--0.003,0.05 6.3--0.002,0.05 6.3,highpass=f=40,lowpass=f=18000';

function getAudioSettings() {
  // readStore never throws — no catch needed around it.
  const data = readStore(AUDIO_FILE, null);
  if (data) {
    return { enhanced: data.enhanced === true };
  }
  return { enhanced: false };
}

function setAudioSettings(settings) {
  const data = {
    enhanced: settings.enhanced === true,
    timestamp: Date.now()
  };
  writeStore(AUDIO_FILE, data, { indent: 0 });
  return data;
}

function getAudioFilter() {
  const settings = getAudioSettings();
  return settings.enhanced ? AUDIO_ENHANCEMENT_FILTER : null;
}

module.exports = { getAudioSettings, setAudioSettings, getAudioFilter };
