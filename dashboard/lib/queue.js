const http = require('http');
const express = require('express');

const DJ_HOST = 'dj';
const DJ_PORT = 7000;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: DJ_HOST,
      port: DJ_PORT,
      path,
      method,
      timeout: 5000,
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

function createQueueRouter() {
  const router = express.Router();

  // GET /api/queue — list queued tracks
  router.get('/', async (req, res) => {
    try {
      const result = await request('GET', '/queue');
      res.json(result.data);
    } catch (e) {
      res.status(502).json({ error: 'liquidsoap unavailable' });
    }
  });

  // POST /api/queue/push — add track to queue
  router.post('/push', express.text({ type: '*/*' }), async (req, res) => {
    try {
      const filename = (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)).trim();
      if (!filename) return res.status(400).json({ error: 'no filename' });
      // Send raw path to liquidsoap
      const filePath = '/music/' + filename;
      const result = await request('POST', '/queue/push', filePath);
      res.json(result.data);
    } catch (e) {
      res.status(502).json({ error: 'liquidsoap unavailable' });
    }
  });

  // POST /api/queue/skip — skip current track
  router.post('/skip', async (req, res) => {
    try {
      const result = await request('POST', '/skip', '');
      res.json(result.data);
    } catch (e) {
      res.status(502).json({ error: 'liquidsoap unavailable' });
    }
  });

  return router;
}

module.exports = createQueueRouter;
