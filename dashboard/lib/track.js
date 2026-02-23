const fs = require('fs');
const path = require('path');

const TRACK_FILE = '/shared/current_audio.txt';
const CLEAN_TRACK_FILE = '/shared/current_track_clean.txt';
const ANALYSIS_MAP = '/music/.analysis_map';
const POLL_INTERVAL = 2000;

// Lookup track duration from analysis map (extensionless basename match)
function getTrackDuration(filename) {
  try {
    if (!filename || !fs.existsSync(ANALYSIS_MAP)) return 0;
    const target = path.basename(filename).replace(/\.[^.]+$/, '');
    const lines = fs.readFileSync(ANALYSIS_MAP, 'utf8').split('\n');
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length >= 3) {
        const lineBase = path.basename(parts[0]).replace(/\.[^.]+$/, '');
        if (lineBase === target) return parseFloat(parts[2]) || 0;
      }
    }
  } catch (e) {}
  return 0;
}

// Clean track name: remove path, extension, replace _ with space, remove junk
function cleanTrackName(filename) {
  if (!filename) return '';
  // Get basename
  let name = path.basename(filename);
  // Remove extension
  name = name.replace(/\.[^.]+$/, '');
  // Replace underscores, dots, dashes with spaces
  name = name.replace(/[_\.\-]+/g, ' ');
  // Remove common junk patterns
  name = name.replace(/\b(official|video|audio|lyrics|hq|hd|1080p|720p|4k|remastered|remaster)\b/gi, '');
  // Remove multiple spaces
  name = name.replace(/\s+/g, ' ');
  // Trim
  return name.trim();
}

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
          // Write cleaned name for scrolling overlay
          const cleanName = cleanTrackName(filename);
          try {
            fs.writeFileSync(CLEAN_TRACK_FILE, cleanName);
          } catch (e) {
            console.log('[track] ERROR writing clean file:', e.message);
          }
          const duration = getTrackDuration(filename);
          console.log('[track] UPDATE:', name, 'clean:', cleanName, 'dur:', duration.toFixed(1) + 's');
          onUpdate({
            title: name,
            filename: filename,
            duration: duration,
            startedAt: Date.now()
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
