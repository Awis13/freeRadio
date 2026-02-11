const fs = require('fs');
const path = require('path');

const TRACK_FILE = '/shared/current_audio.txt';
const POLL_INTERVAL = 2000;

function createTrackPoller(onUpdate) {
  let timer = null;
  let lastTrack = '';

  function poll() {
    try {
      if (fs.existsSync(TRACK_FILE)) {
        const filename = fs.readFileSync(TRACK_FILE, 'utf8').trim();
        console.log('[track] poll:', filename, 'last:', lastTrack, 'changed:', filename !== lastTrack);
        if (filename && filename !== lastTrack) {
          lastTrack = filename;
          const basename = path.basename(filename);
          const name = basename.replace(/\.[^.]+$/, '');
          console.log('[track] UPDATE:', name);
          onUpdate({
            title: name,
            filename: filename
          });
        }
      } else {
        console.log('[track] file not exists:', TRACK_FILE);
      }
    } catch (e) {
      console.log('[track] ERROR:', e.message);
    }
  }

  return {
    start() { poll(); timer = setInterval(poll, POLL_INTERVAL); },
    stop() { clearInterval(timer); }
  };
}

module.exports = { createTrackPoller };
