const fs = require('fs');

const POLL_INTERVAL = 3000;

function parseProgress(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return {
    frame: result.frame || '',
    fps: result.fps || '',
    bitrate: result.total_size ? '' : (result.bitrate || ''),
    time: result.out_time || '',
    speed: result.speed || ''
  };
}

function createFfmpegPoller(progressFile, onUpdate) {
  let timer = null;

  function poll() {
    if (!progressFile) return;
    try {
      const text = fs.readFileSync(progressFile, 'utf8');
      onUpdate(parseProgress(text));
    } catch (e) {
      // file not ready yet
    }
  }

  return {
    start() { poll(); timer = setInterval(poll, POLL_INTERVAL); },
    stop() { clearInterval(timer); }
  };
}

module.exports = { createFfmpegPoller };
