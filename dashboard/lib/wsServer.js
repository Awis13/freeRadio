const { WebSocketServer } = require("ws");
const authGate = require("./authGate");

const AUTH_TIMEOUT_MS = 5000;

/**
 * Every WebSocketServer whose authenticated clients should receive broadcasts.
 *
 * This replaces a single _broadcastFn that each setup function overwrote:
 * setupWs installed a one-server closure and setupTlsWs replaced it with a
 * two-server one. The result therefore depended on the order the two were
 * called in — attaching the plain server after the TLS one silently dropped
 * the TLS clients from every broadcast — and it is the only reason setupTlsWs
 * needed the plain wss handed back to it as an argument.
 */
const broadcastTargets = [];

/**
 * Installs the first-message auth protocol on a WebSocketServer.
 *
 * Both listeners run exactly this, and did before: the two copies were
 * identical apart from the receiver's name and two comments.
 */
function attachConnectionHandler(wss, getInitState) {
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

// Setup primary WebSocket server (first-message auth)
function setupWs(server, getInitState) {
  const wss = new WebSocketServer({ server });
  attachConnectionHandler(wss, getInitState);
  broadcastTargets.push(wss);
  return wss;
}

/**
 * Setup the TLS WebSocket server.
 *
 * The same operation: the HTTPS listener is another server whose sockets need
 * the same handler and the same place in the fan-out. It keeps its own name
 * because that is what server.js's HTTPS block calls, and because
 * `setupWs(tlsServer)` at the call site would read like a mistake.
 */
function setupTlsWs(tlsServer, getInitState) {
  return setupWs(tlsServer, getInitState);
}

// Broadcast to all connected & authenticated WebSocket clients, on every
// attached server.
function broadcast(type, data) {
  if (broadcastTargets.length === 0) return;
  const msg = JSON.stringify({ type, data });
  for (const wss of broadcastTargets) {
    wss.clients.forEach((c) => {
      if (c.readyState === 1 && c._authenticated) c.send(msg);
    });
  }
}

module.exports = { setupWs, setupTlsWs, broadcast };
