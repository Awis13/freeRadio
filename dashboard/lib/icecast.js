const http = require('http');

const ICECAST_URL = 'http://icecast:8000/status-json.xsl';
const POLL_INTERVAL = 5000;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function createIcecastPoller(onUpdate) {
  let timer = null;

  async function poll() {
    try {
      const json = await fetchJson(ICECAST_URL);
      const src = json?.icestats?.source;
      // source can be an object (single mount) or array
      const mount = Array.isArray(src) ? src[0] : src;
      if (mount) {
        onUpdate({
          listeners: mount.listeners || 0,
          bitrate: mount.audio_bitrate || mount.bitrate || 0,
          serverStart: json?.icestats?.server_start || '',
          title: mount.title || mount.server_name || '',
          genre: mount.genre || '',
          server_name: mount.server_name || ''
        });
      }
    } catch (e) {
      // icecast not ready yet
    }
  }

  return {
    start() { poll(); timer = setInterval(poll, POLL_INTERVAL); },
    stop() { clearInterval(timer); }
  };
}

module.exports = { createIcecastPoller };
