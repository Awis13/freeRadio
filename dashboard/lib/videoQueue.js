const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const QUEUE_FILE = paths.shared('video_queue.txt');
const SKIP_FILE = paths.shared('video_skip');

function getQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const content = fs.readFileSync(QUEUE_FILE, 'utf8').trim();
      if (!content) return [];
      return content.split('\n').filter(Boolean);
    }
  } catch (e) {}
  return [];
}

function push(filename) {
  fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
  fs.appendFileSync(QUEUE_FILE, filename.trim() + '\n');
}

function clear() {
  try {
    fs.writeFileSync(QUEUE_FILE, '');
  } catch (e) {}
}

function skip() {
  fs.mkdirSync(path.dirname(SKIP_FILE), { recursive: true });
  fs.writeFileSync(SKIP_FILE, '');
}

module.exports = { getQueue, push, clear, skip };
