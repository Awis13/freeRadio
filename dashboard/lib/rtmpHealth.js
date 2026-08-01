const fs = require('fs');
const paths = require('./paths');

const POLL_INTERVAL = 2000;
const STATUS_FILE = paths.shared('rtmp_status.json');

function createRtmpHealthPoller(onUpdate) {
  let timer = null;

  function poll() {
    try {
      const text = fs.readFileSync(STATUS_FILE, 'utf8');
      const data = JSON.parse(text);
      onUpdate(data);
    } catch (e) {
      // file not ready yet
    }
  }

  return {
    start() { poll(); timer = setInterval(poll, POLL_INTERVAL); },
    stop() { clearInterval(timer); }
  };
}

module.exports = { createRtmpHealthPoller };
