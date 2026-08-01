const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const VIDEO_FILE = paths.shared('current_video.txt');
const POLL_INTERVAL = 2000;

function createVideoPoller(onUpdate) {
  let timer = null;
  let lastVideo = '';

  function poll() {
    try {
      if (fs.existsSync(VIDEO_FILE)) {
        const filename = fs.readFileSync(VIDEO_FILE, 'utf8').trim();
        if (filename && filename !== lastVideo) {
          lastVideo = filename;
          // Extract basename without extension
          const basename = path.basename(filename);
          const name = basename.replace(/\.[^.]+$/, '');
          onUpdate({
            title: name,
            filename: filename
          });
        }
      }
    } catch (e) {
      // file not ready yet
    }
  }

  return {
    start() { poll(); timer = setInterval(poll, POLL_INTERVAL); },
    stop() { clearInterval(timer); }
  };
}

module.exports = { createVideoPoller };
