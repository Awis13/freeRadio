const http = require('http');
const paths = require('./paths');

// Host/port come from paths.js so the dj service is defined in one place (boot.js
// used to hardcode it). The timeout stays local — it is a client tuning knob,
// not part of the path/host config.
const DJ_HOST = paths.DJ_HOST;
const DJ_PORT = paths.DJ_PORT;
const REQUEST_TIMEOUT_MS = parseInt(process.env.DJ_TIMEOUT_MS || '5000', 10);

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: DJ_HOST,
      port: DJ_PORT,
      path,
      method,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {}
    };
    if (body) {
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, data: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function getQueue() {
  return request('GET', '/queue');
}

function pushTrack(filePath) {
  return request('POST', '/queue/push', filePath);
}

function skip() {
  return request('POST', '/skip', '');
}

function clearQueue() {
  return request('POST', '/queue/clear', '');
}

function getQueueLength() {
  return request('GET', '/queue/length');
}

function pushVoice(filePath) {
  return request('POST', '/voice/push', filePath);
}

function getVoiceConfig() {
  return request('GET', '/voice/config');
}

function setVoiceConfig(config) {
  return request('POST', '/voice/config', JSON.stringify(config));
}

function getMixingConfig() {
  return request('GET', '/mixing/config');
}

function setMixingConfig(config) {
  return request('POST', '/mixing/config', JSON.stringify(config));
}

function startPlayback() {
  return request('POST', '/playback/start', '');
}

function stopPlayback() {
  return request('POST', '/playback/stop', '');
}

function resumePlayback() {
  return request('POST', '/playback/resume', '');
}

function cueTrack(filePath) {
  return request('POST', '/playback/cue', filePath);
}

// ---- Channel Strip ----

function getStripConfig() {
  return request('GET', '/strip/config');
}

function setStripConfig(params) {
  return request('POST', '/strip/config', JSON.stringify(params));
}

function getStripMetering() {
  return request('GET', '/strip/metering');
}

module.exports = {
  request,
  getQueue, pushTrack, skip, clearQueue, getQueueLength,
  pushVoice, getVoiceConfig, setVoiceConfig,
  getMixingConfig, setMixingConfig,
  startPlayback, stopPlayback, resumePlayback, cueTrack,
  getStripConfig, setStripConfig, getStripMetering
};
