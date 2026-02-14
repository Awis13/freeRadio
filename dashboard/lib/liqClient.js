const http = require('http');

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

function getQueue() {
  return request('GET', '/queue');
}

function pushTrack(filePath) {
  return request('POST', '/queue/push', filePath);
}

function skip() {
  return request('POST', '/skip', '');
}

function clearQueue() {
  return request('POST', '/queue/clear', '');
}

function getQueueLength() {
  return request('GET', '/queue/length');
}

module.exports = { request, getQueue, pushTrack, skip, clearQueue, getQueueLength };
