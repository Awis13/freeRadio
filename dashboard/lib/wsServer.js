const { WebSocketServer } = require("ws");

const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || "";
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

    // If no token configured, auto-authenticate
    if (!DASHBOARD_TOKEN) {
      ws._authenticated = true;
      ws.send(JSON.stringify({ type: "init", data: getInitState() }));
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
          if (!DASHBOARD_TOKEN || msg.token === DASHBOARD_TOKEN) {
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

    if (!DASHBOARD_TOKEN) {
      ws._authenticated = true;
      ws.send(JSON.stringify({ type: "init", data: getInitState() }));
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
          if (!DASHBOARD_TOKEN || msg.token === DASHBOARD_TOKEN) {
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
