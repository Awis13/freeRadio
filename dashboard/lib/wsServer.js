const { WebSocketServer } = require("ws");
const authGate = require("./authGate");

const AUTH_TIMEOUT_MS = 5000;

let _broadcastFn = null;

// Setup primary WebSocket server (first-message auth)
function setupWs(server, _verifyClient, getInitState) {
  const wss = new WebSocketServer({ server });

  _broadcastFn = function (type, data) {
    const msg = JSON.stringify({ type, data });
    wss.clients.forEach((c) => {
      if (c.readyState === 1 && c._authenticated) c.send(msg);
    });
  };

  wss.on("connection", (ws) => {
    ws._authenticated = false;

    // Auth explicitly disabled — accept the socket as authenticated.
    if (authGate.isOpen()) {
      ws._authenticated = true;
      ws.send(JSON.stringify({ type: "init", data: getInitState() }));
    } else if (authGate.isClosed()) {
      // No token and no opt-out: refuse rather than hand out the state feed.
      ws.close(4401, "Auth is not configured");
      return;
    } else {
      // 5-second auth timeout
      ws._authTimer = setTimeout(() => {
        if (!ws._authenticated) {
          ws.close(4401, "Auth timeout");
        }
      }, AUTH_TIMEOUT_MS);
    }

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "auth") {
          if (authGate.accepts(msg.token)) {
            ws._authenticated = true;
            if (ws._authTimer) {
              clearTimeout(ws._authTimer);
              ws._authTimer = null;
            }
            ws.send(JSON.stringify({ type: "init", data: getInitState() }));
          } else {
            ws.close(4401, "Invalid token");
          }
          return;
        }
        if (!ws._authenticated) {
          ws.close(4401, "Not authenticated");
          return;
        }
        // Handle other message types here if needed
      } catch (e) {}
    });

    ws.on("close", () => {
      if (ws._authTimer) {
        clearTimeout(ws._authTimer);
        ws._authTimer = null;
      }
    });
  });

  return wss;
}

// Setup TLS WebSocket server (patches broadcast to send to both)
function setupTlsWs(tlsServer, _verifyClient, getInitState, wss) {
  const wssTls = new WebSocketServer({ server: tlsServer });

  wssTls.on("connection", (ws) => {
    ws._authenticated = false;

    // Auth explicitly disabled — accept the socket as authenticated.
    if (authGate.isOpen()) {
      ws._authenticated = true;
      ws.send(JSON.stringify({ type: "init", data: getInitState() }));
    } else if (authGate.isClosed()) {
      // No token and no opt-out: refuse rather than hand out the state feed.
      ws.close(4401, "Auth is not configured");
      return;
    } else {
      ws._authTimer = setTimeout(() => {
        if (!ws._authenticated) {
          ws.close(4401, "Auth timeout");
        }
      }, AUTH_TIMEOUT_MS);
    }

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "auth") {
          if (authGate.accepts(msg.token)) {
            ws._authenticated = true;
            if (ws._authTimer) {
              clearTimeout(ws._authTimer);
              ws._authTimer = null;
            }
            ws.send(JSON.stringify({ type: "init", data: getInitState() }));
          } else {
            ws.close(4401, "Invalid token");
          }
          return;
        }
        if (!ws._authenticated) {
          ws.close(4401, "Not authenticated");
          return;
        }
      } catch (e) {}
    });

    ws.on("close", () => {
      if (ws._authTimer) {
        clearTimeout(ws._authTimer);
        ws._authTimer = null;
      }
    });
  });

  // Patch broadcast to send to both WS servers (only authenticated clients)
  _broadcastFn = function (type, data) {
    const msg = JSON.stringify({ type, data });
    wss.clients.forEach((c) => {
      if (c.readyState === 1 && c._authenticated) c.send(msg);
    });
    wssTls.clients.forEach((c) => {
      if (c.readyState === 1 && c._authenticated) c.send(msg);
    });
  };

  return wssTls;
}

// Broadcast to all connected & authenticated WebSocket clients.
function broadcast(type, data) {
  if (_broadcastFn) _broadcastFn(type, data);
}

module.exports = { setupWs, setupTlsWs, broadcast };
