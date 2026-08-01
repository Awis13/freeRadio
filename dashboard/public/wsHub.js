/**
 * wsHub.js — WebSocket transport and message dispatch for the STUDIO 23 /
 * FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C3 of the broadcast-core refactor).
 * Owns the socket handle, the reconnect backoff, the connection factory and its
 * four handlers, and the message dispatch switch. init() opens the first
 * connection, which was a module-scope connectWs() call in app.js.
 *
 * OWNED STATE: ws, wsReconnectDelay, wsReconnectTimer. Nothing else — the hub
 * deliberately holds no application state.
 *
 * DISPATCH IS INJECTED. Every case body manipulates state that belongs to
 * another slice — broadcastState (still app.js until the broadcast machine
 * moves), the now-playing readout, the restream status panel — so the hub owns
 * the socket, the parse and the switch, and each case calls a handler the host
 * supplies. The switch shape is preserved exactly, including the absence of a
 * default case: an unknown message type still falls through doing nothing.
 * Every former case body used only msg.data, so passing msg.data is a faithful
 * substitution.
 *
 * THE PER-MESSAGE TRY/CATCH IS LOAD-BEARING. onmessage wraps JSON.parse AND the
 * dispatch, and logs 'ws: parse error ' + e on failure. That catch is per
 * message, so a throwing frame never affects the next one, and the log line is
 * what the pins use to detect a frame that threw. It is reproduced verbatim.
 *
 * NOT MOVED, injected instead: the auth token (window.FRAuth, read live because
 * it is mutable), the analyzer's server-FFT gate and binary-frame sink, and
 * log. FRPlayer's getWs/reconnectWs deps and the __appWs test hook re-point to
 * this module.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/wsHub.js"> (attaches its public API to window.FRWsHub) AND
 * required by the vitest suite via module.exports (CJS). It deliberately uses
 * NO top-level `export`/`import` so a browser <script> can load it without a
 * SyntaxError.
 */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.FRWsHub = api;
  }
})(function () {
  'use strict';

  var noop = function () {};
  var deps = {
    log: noop,
    getAuthToken: function () { return ''; },
    isServerFFT: function () { return false; },
    handleFftFrame: noop,
    // One callback per message type. Defaults are inert so a pre-init frame
    // cannot throw.
    handlers: {
      init: noop, audio: noop, video: noop, icecast: noop, ffmpeg: noop,
      bpm: noop, rtmpHealth: noop, voiceStatus: noop, mixingConfig: noop,
      liveMode: noop,
    },
  };

  function log(msg) { return deps.log(msg); }
  function getAuthToken() { return deps.getAuthToken(); }
  function isServerFFT() { return deps.isServerFFT(); }
  function handleFftFrame(buf) { return deps.handleFftFrame(buf); }
  function handlers() { return deps.handlers; }

  // -------------------------------------------------------------------------
  // Module-owned state (moved from the app.js closure).
  // -------------------------------------------------------------------------
  var ws = null;
  var wsReconnectDelay = 1000;
  var wsReconnectTimer = null;

  // Facade seam over the shared-mutable `ws` socket handle (C2 of the core
  // facade-foundation PR). All reads/writes of `ws` route through these so a
  // future PR can inject the socket without touching every call site. PURE
  // indirection — getWs() returns the same value, setWs() assigns the same
  // value; zero behaviour change. wsReconnectDelay/wsReconnectTimer stay
  // internal (not facaded).
  function getWs() { return ws; }
  function setWs(v) { ws = v; }
  function connectWs() {
    // Cancel any pending reconnect to avoid stacking (iOS resume can fire multiple times)
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    // Close stale socket if still lingering
    if (getWs()) {
      try { getWs().onclose = null; getWs().close(); } catch(e) {}
      setWs(null);
    }
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = proto + '//' + location.host;
    setWs(new WebSocket(wsUrl));

    getWs().onopen = function () {
      log('ws: connected');
      wsReconnectDelay = 1000;
      // Send auth token as first message (read live from FRAuth — it is mutable).
      var token = getAuthToken();
      if (token) {
        getWs().send(JSON.stringify({type: 'auth', token: token}));
      }
      // Subscribe to server-side FFT if Safari analyzer is active
      if (isServerFFT()) {
        getWs().send(JSON.stringify({type: 'fft-subscribe'}));
      }
    };

    getWs().onclose = function () {
      log('ws: disconnected, reconnecting in ' + (wsReconnectDelay / 1000) + 's');
      wsReconnectTimer = setTimeout(connectWs, wsReconnectDelay);
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, 10000);
    };

    getWs().onerror = function () {
      log('ws: error');
    };

    getWs().binaryType = 'arraybuffer';
    getWs().onmessage = function (evt) {
      if (typeof evt.data !== 'string') {
        // Binary FFT frame from server
        handleFftFrame(new Uint8Array(evt.data));
        return;
      }
      try {
        var msg = JSON.parse(evt.data);
        handleMessage(msg);
      } catch (e) {
        log('ws: parse error ' + e);
      }
    };
  }
  function handleMessage(msg) {
    switch (msg.type) {
      case 'init':
        handlers().init(msg.data);
        break;
      case 'audio':
        handlers().audio(msg.data);
        break;
      case 'video':
        handlers().video(msg.data);
        break;
      case 'icecast':
        handlers().icecast(msg.data);
        break;
      case 'ffmpeg':
        handlers().ffmpeg(msg.data);
        break;
      case 'bpm':
        handlers().bpm(msg.data);
        break;
      case 'rtmp-health':
        handlers().rtmpHealth(msg.data);
        break;
      case 'voice-status':
        handlers().voiceStatus(msg.data);
        break;
      case 'mixing-config':
        handlers().mixingConfig(msg.data);
        break;
      case 'live-mode':
        handlers().liveMode(msg.data);
        break;
    }
  }

  /**
   * Reset the backoff and reconnect. app.js's player wiring used to inline
   * `wsReconnectDelay = 1000; connectWs();`; wsReconnectDelay is module-internal
   * now, so the pair is exposed as one call.
   */
  function reconnectNow() {
    wsReconnectDelay = 1000;
    connectWs();
  }

  function init(injected) {
    injected = injected || {};
    for (var k in deps) {
      if (Object.prototype.hasOwnProperty.call(injected, k)) {
        deps[k] = injected[k];
      }
    }
    connectWs();
  }

  return {
    init: init,
    connectWs: connectWs,
    reconnectNow: reconnectNow,
    getWs: getWs,
    setWs: setWs,
    getWsReconnectDelay: function () { return wsReconnectDelay; },
  };
});
