const http = require('http');

const LS_URL = 'http://dj:7000/metadata';
const ICECAST_FALLBACK = 'http://icecast:8000/status-json.xsl';
const POLL_INTERVAL = 2000;

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

function createLiquidoapPoller(onUpdate) {
  let timer = null;
  let useFallback = false;

  async function poll() {
    try {
      if (!useFallback) {
        const data = await fetchJson(LS_URL);
        onUpdate({
          title: data.title || '',
          filename: data.filename || ''
        });
        return;
      }
    } catch (e) {
      // Harbor not available — switch to icecast fallback
      if (!useFallback) {
        console.log('[liquidsoap] harbor unavailable, using icecast fallback');
        useFallback = true;
      }
    }

    // Fallback: get title from icecast
    try {
      const json = await fetchJson(ICECAST_FALLBACK);
      const src = json?.icestats?.source;
      const mount = Array.isArray(src) ? src[0] : src;
      onUpdate({
        title: mount?.title || '',
        filename: ''
      });
    } catch (e) {
      // both unavailable
    }
  }

  return {
    start() { poll(); timer = setInterval(poll, POLL_INTERVAL); },
    stop() { clearInterval(timer); }
  };
}

module.exports = { createLiquidoapPoller };
