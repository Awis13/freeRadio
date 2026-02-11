const fs = require('fs');

const POLL_INTERVAL = 20000;

function parseBpmMap(text) {
  const map = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const sep = line.indexOf('|');
    if (sep > 0) {
      const filepath = line.slice(0, sep).trim();
      const bpm = parseFloat(line.slice(sep + 1).trim());
      if (filepath && !isNaN(bpm)) {
        // Use just the filename as key
        const name = filepath.split('/').pop();
        map[name] = bpm;
      }
    }
  }
  return map;
}

function createBpmMapPoller(bpmMapPath, onUpdate) {
  let timer = null;

  function poll() {
    try {
      const text = fs.readFileSync(bpmMapPath, 'utf8');
      onUpdate(parseBpmMap(text));
    } catch (e) {
      // file not ready yet
    }
  }

  return {
    start() { poll(); timer = setInterval(poll, POLL_INTERVAL); },
    stop() { clearInterval(timer); }
  };
}

module.exports = { createBpmMapPoller };
