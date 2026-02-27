const { WebSocketServer } = require('ws');

let _broadcastFn = null;

// Setup primary WebSocket server
function setupWs(server, verifyClient, getInitState) {
  const wss = new WebSocketServer({ server, verifyClient });

  _broadcastFn = function(type, data) {
    const msg = JSON.stringify({ type, data });
    wss.clients.forEach((c) => { if (c.readyState === 1) c.send(msg); });
  };

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'init', data: getInitState() }));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        // if (msg.type === 'fft-subscribe') fftAnalyzer.subscribe(ws);
        // else if (msg.type === 'fft-unsubscribe') fftAnalyzer.unsubscribe(ws);
      } catch(e) {}
    });
    // ws.on('close', () => { fftAnalyzer.unsubscribe(ws); });
  });

  return wss;
}

// Setup TLS WebSocket server (patches broadcast to send to both)
function setupTlsWs(tlsServer, verifyClient, getInitState, wss) {
  const wssTls = new WebSocketServer({ server: tlsServer, verifyClient });

  wssTls.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'init', data: getInitState() }));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        // if (msg.type === 'fft-subscribe') fftAnalyzer.subscribe(ws);
        // else if (msg.type === 'fft-unsubscribe') fftAnalyzer.unsubscribe(ws);
      } catch(e) {}
    });
    // ws.on('close', () => { fftAnalyzer.unsubscribe(ws); });
  });

  // Patch broadcast to send to both WS servers
  _broadcastFn = function(type, data) {
    const msg = JSON.stringify({ type, data });
    wss.clients.forEach((c) => { if (c.readyState === 1) c.send(msg); });
    wssTls.clients.forEach((c) => { if (c.readyState === 1) c.send(msg); });
  };

  return wssTls;
}

// Broadcast to all connected WebSocket clients.
// Always delegates to current implementation (patched by setupTlsWs when TLS is active).
function broadcast(type, data) {
  if (_broadcastFn) _broadcastFn(type, data);
}

module.exports = { setupWs, setupTlsWs, broadcast };
