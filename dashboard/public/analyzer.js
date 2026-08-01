/**
 * analyzer.js — CRT analyzer (spectrum / spectrogram / vectorscope / levels),
 * the WebAudio graph behind it, and the player mute control for the
 * STUDIO 23 / FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C4 of the player/analyzer/mixer
 * refactor, the last slice). Owns the six themes, the AudioContext graph and
 * its five node getters, the Safari server-FFT path (AzServerAnalyser, the
 * pre-allocated ring buffer and handleFftFrame), the HLS delay measurement and
 * stream-decode fallback, the four draw modes, the BPM glow, and the analyzer
 * mode / on-off / theme / sync-offset controls.
 *
 * setPlayerMuted lives here rather than with the player because its whole body
 * is analyzer-graph work: it drives azGainNode on the analyzer's AudioContext.
 * The player module receives it as a dep, exactly as it did when the function
 * sat in app.js.
 *
 * OWNED STATE (moved): azCtx, azAudioCtx, azGainNode, azMain, azL, azR, azMode,
 * azAnimFrame, azInited, azPeaks, azPeakHoldL/R, azSpectroTmp, azSpectroCol,
 * azW/azH, the theme table with azThemeName/azTheme, azServerFFT, the FFT ring
 * buffer (azRing*, azRingHead/Len, azMeasuredDelay, azLastDelayCheck),
 * azStreamAbort, azFixedDelay, azSyncOffset, azStreamGen, and the analyzer DOM
 * refs.
 *
 * The five WebAudio getters (getAudioCtx/getGainNode/getMainAnalyser/getAzL/
 * getAzR) and getAzInited move with the graph they read. app.js re-sources
 * every consumer — the __appAudio test hook and the mixer's injected deps —
 * to these methods. Passing them as bare method references is safe: the UMD
 * factory runs at script load, so window.FRAnalyzer and its closures exist
 * before app.js evaluates, and each getter returns null until azInit runs,
 * exactly as the app.js closure did.
 *
 * NOT MOVED:
 *   - isSafari / isIOS. UA detection stays in app.js and isSafari is injected
 *     as a value (azInit's Safari bail-out and the sync-offset UI read it).
 *     Consolidating it is a separate cleanup, deliberately not done here.
 *   - The WebSocket. connectWs stays in app.js and calls
 *     FRAnalyzer.handleFftFrame for binary frames and FRAnalyzer.isServerFFT()
 *     before sending the fft-subscribe message.
 *   - studioBpm, broadcastState, trackStartedAt, studioPlayer and
 *     userInteracted, all read through injected getters.
 *
 * DOM refs are resolved ONCE in init(), matching app.js's module-scope caching
 * (same reasoning as mixer.js).
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/analyzer.js"> (attaches its public API to window.FRAnalyzer)
 * AND required by the vitest suite via module.exports (CJS). It deliberately
 * uses NO top-level `export`/`import` so a browser <script> can load it without
 * a SyntaxError.
 */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.FRAnalyzer = api;
  }
})(function () {
  'use strict';

  // Injected host services (set by init). Defaults keep a pre-init call inert.
  var deps = {
    log: function () {},
    authFetch: function () { return Promise.reject(new Error('FRAnalyzer not initialised')); },
    getStudioPlayer: function () { return null; },
    getUserInteracted: function () { return false; },
    getBroadcastState: function () { return null; },
    getTrackStartedAt: function () { return 0; },
    getStudioBpmEl: function () { return null; },
    getMonitorMusicGain: function () { return 1; },
    getMasterGain: function () { return 1; },
    isSafari: false,
  };

  // Helpers that resolve injected services at call time.
  function log(msg) { return deps.log(msg); }
  function authFetch(url, opts) { return deps.authFetch(url, opts); }
  function getStudioPlayer() { return deps.getStudioPlayer(); }
  function getUserInteracted() { return deps.getUserInteracted(); }
  function getBroadcastState() { return deps.getBroadcastState(); }
  function getTrackStartedAt() { return deps.getTrackStartedAt(); }
  function getStudioBpmEl() { return deps.getStudioBpmEl(); }
  function getMonitorMusicGain() { return deps.getMonitorMusicGain(); }
  function getMasterGain() { return deps.getMasterGain(); }

  // -------------------------------------------------------------------------
  // Analyzer DOM refs — assigned once by resolveDom() from init(), mirroring
  // app.js's module-scope resolution.
  // -------------------------------------------------------------------------
  var azCanvas = null;
  var azCrt = null;
  var azWrap = null;
  var azInfo = null;

  function resolveDom() {
    azCanvas = document.getElementById('analyzer-canvas');
    azCrt = document.getElementById('analyzer-crt');
    azWrap = document.getElementById('analyzer-wrap');
    azInfo = document.getElementById('analyzer-info');
  }

  var azCtx = null;
  var azAudioCtx = null;
  var azGainNode = null;
  var azMain = null;
  var azL = null;
  var azR = null;

  // Facade seam over the WebAudio graph nodes (core facade-foundation PR).
  // Reads of these az* nodes route through these getters so a future PR can
  // inject the audio graph without touching every call site. PURE indirection
  // — each getter returns the same live var; zero behaviour change. There are
  // no setters: azAudioCtx/azGainNode/azMain/azL/azR are assigned ONLY inside
  // azInit/azInitAnalysers, which keep direct access, so no external writer
  // needs a setter (unlike PR-1's setWs).
  function getAudioCtx() { return azAudioCtx; }
  function getGainNode() { return azGainNode; }
  function getMainAnalyser() { return azMain; }
  function getAzL() { return azL; }
  function getAzR() { return azR; }

  var azMode = 'spectrum';
  var azAnimFrame = null;
  var azInited = false;
  // Read-only seam over the analyzer's one-shot init latch. azInited gates five
  // call sites outside this section (the mute button, ARM, PLAY, the mixer's
  // startMic and the analyzer mode buttons all do `if (!azInited) azInit()`),
  // so the flag crosses every module boundary this slice is split along. PURE
  // indirection: returns the same live var, zero behaviour change, no setter
  // (azInit keeps direct access as the sole writer).
  function getAzInited() { return azInited; }
  var azPeaks = [];
  var azPeakHoldL = -100;
  var azPeakHoldR = -100;
  var azSpectroTmp = null;
  var azSpectroCol = null;
  var azW = 0, azH = 0;

  // --- Theme system ---
  var azThemeNames = ['phosphor', 'amber', 'neon', 'vapor', 'ice', 'fire'];
  var azThemes = {
    phosphor: {
      label: 'GRN',
      hex: '#c4ffcb',
      hoverHex: '#d8ffe0',
      primary: [196, 255, 203],
      spectrumColor: function(r) {
        if (r < 0.5) { var t = r * 2; return [20+80*t|0, 180+75*t|0, 40+215*t|0]; }
        var t = (r - 0.5) * 2; return [100+155*t|0, 255, 255];
      },
      spectroColor: function(v) {
        if (v < 15) return [5, 10, 14];
        if (v < 70) { var t = (v-15)/55; return [5+25*t|0, 15+150*t|0, 14+35*t|0]; }
        if (v < 150) { var t = (v-70)/80; return [30+70*t|0, 165+90*t|0, 49+206*t|0]; }
        var t = Math.min(1, (v-150)/105); return [100+155*t|0, 255, 255];
      },
      levelStops: [
        [0, 'rgba(196,255,203,0.8)'], [0.6, 'rgba(196,255,203,0.8)'],
        [0.8, 'rgba(255,230,160,0.85)'], [0.95, 'rgba(255,179,179,0.9)'], [1, 'rgba(255,100,100,0.95)']
      ]
    },
    amber: {
      label: 'AMB',
      hex: '#ffb43c',
      hoverHex: '#ffc870',
      primary: [255, 180, 60],
      spectrumColor: function(r) {
        if (r < 0.5) { var t = r * 2; return [80+120*t|0, 40+80*t|0, 0+10*t|0]; }
        var t = (r - 0.5) * 2; return [200+55*t|0, 120+100*t|0, 10+70*t|0];
      },
      spectroColor: function(v) {
        if (v < 15) return [8, 4, 2];
        if (v < 70) { var t = (v-15)/55; return [8+72*t|0, 4+36*t|0, 2+3*t|0]; }
        if (v < 150) { var t = (v-70)/80; return [80+120*t|0, 40+90*t|0, 5+10*t|0]; }
        var t = Math.min(1, (v-150)/105); return [200+55*t|0, 130+100*t|0, 15+85*t|0];
      },
      levelStops: [
        [0, 'rgba(255,180,60,0.8)'], [0.6, 'rgba(255,180,60,0.8)'],
        [0.8, 'rgba(255,220,100,0.85)'], [0.95, 'rgba(255,130,80,0.9)'], [1, 'rgba(255,80,50,0.95)']
      ]
    },
    neon: {
      label: 'NEON',
      hex: '#a0ffc8',
      hoverHex: '#c0ffd8',
      primary: [160, 255, 200],
      spectrumColor: function(r) {
        if (r < 0.35) { var t = r / 0.35; return [10+30*t|0, 160+95*t|0, 60+60*t|0]; }
        if (r < 0.65) { var t = (r-0.35)/0.3; return [40+140*t|0, 255-115*t|0, 120+110*t|0]; }
        var t = (r - 0.65) / 0.35; return [180+75*t|0, 140+60*t|0, 230+25*t|0];
      },
      spectroColor: function(v) {
        if (v < 15) return [4, 8, 6];
        if (v < 70) { var t = (v-15)/55; return [4+11*t|0, 8+152*t|0, 6+54*t|0]; }
        if (v < 150) { var t = (v-70)/80; return [15+145*t|0, 160-80*t|0, 60+140*t|0]; }
        var t = Math.min(1, (v-150)/105); return [160+95*t|0, 80+120*t|0, 200+55*t|0];
      },
      levelStops: [
        [0, 'rgba(100,255,170,0.8)'], [0.6, 'rgba(100,255,170,0.8)'],
        [0.8, 'rgba(200,160,255,0.85)'], [0.95, 'rgba(255,120,200,0.9)'], [1, 'rgba(255,80,160,0.95)']
      ]
    },
    vapor: {
      label: 'VPR',
      hex: '#ff6ec8',
      hoverHex: '#ff99d8',
      primary: [255, 110, 200],
      spectrumColor: function(r) {
        if (r < 0.5) { var t = r * 2; return [20+80*t|0, 140+60*t|0, 170+60*t|0]; }
        var t = (r - 0.5) * 2; return [100+155*t|0, 200-90*t|0, 230-30*t|0];
      },
      spectroColor: function(v) {
        if (v < 15) return [6, 3, 10];
        if (v < 70) { var t = (v-15)/55; return [6+24*t|0, 3+77*t|0, 10+120*t|0]; }
        if (v < 150) { var t = (v-70)/80; return [30+150*t|0, 80-20*t|0, 130+30*t|0]; }
        var t = Math.min(1, (v-150)/105); return [180+75*t|0, 60+100*t|0, 160+70*t|0];
      },
      levelStops: [
        [0, 'rgba(80,200,240,0.8)'], [0.6, 'rgba(80,200,240,0.8)'],
        [0.8, 'rgba(220,120,255,0.85)'], [0.95, 'rgba(255,90,180,0.9)'], [1, 'rgba(255,60,120,0.95)']
      ]
    },
    ice: {
      label: 'ICE',
      hex: '#8cd2ff',
      hoverHex: '#b0e0ff',
      primary: [140, 210, 255],
      spectrumColor: function(r) {
        if (r < 0.5) { var t = r * 2; return [10+50*t|0, 40+100*t|0, 120+100*t|0]; }
        var t = (r - 0.5) * 2; return [60+160*t|0, 140+105*t|0, 220+35*t|0];
      },
      spectroColor: function(v) {
        if (v < 15) return [3, 5, 12];
        if (v < 70) { var t = (v-15)/55; return [3+7*t|0, 5+45*t|0, 12+118*t|0]; }
        if (v < 150) { var t = (v-70)/80; return [10+50*t|0, 50+100*t|0, 130+100*t|0]; }
        var t = Math.min(1, (v-150)/105); return [60+160*t|0, 150+95*t|0, 230+25*t|0];
      },
      levelStops: [
        [0, 'rgba(140,210,255,0.8)'], [0.6, 'rgba(140,210,255,0.8)'],
        [0.8, 'rgba(200,235,255,0.85)'], [0.95, 'rgba(255,180,180,0.9)'], [1, 'rgba(255,100,100,0.95)']
      ]
    },
    fire: {
      label: 'FIRE',
      hex: '#ff8228',
      hoverHex: '#ffa060',
      primary: [255, 130, 40],
      spectrumColor: function(r) {
        if (r < 0.35) { var t = r / 0.35; return [80+120*t|0, 8+17*t|0, 0+5*t|0]; }
        if (r < 0.7) { var t = (r-0.35)/0.35; return [200+55*t|0, 25+105*t|0, 5+10*t|0]; }
        var t = (r - 0.7) / 0.3; return [255, 130+110*t|0, 15+65*t|0];
      },
      spectroColor: function(v) {
        if (v < 15) return [8, 2, 1];
        if (v < 70) { var t = (v-15)/55; return [8+92*t|0, 2+8*t|0, 1+1*t|0]; }
        if (v < 150) { var t = (v-70)/80; return [100+120*t|0, 10+60*t|0, 2+3*t|0]; }
        var t = Math.min(1, (v-150)/105); return [220+35*t|0, 70+140*t|0, 5+75*t|0];
      },
      levelStops: [
        [0, 'rgba(255,100,20,0.8)'], [0.6, 'rgba(255,100,20,0.8)'],
        [0.8, 'rgba(255,200,60,0.85)'], [0.95, 'rgba(255,240,180,0.9)'], [1, 'rgba(255,255,240,0.95)']
      ]
    }
  };

  var azThemeName = localStorage.getItem('ui-theme') || localStorage.getItem('az-theme') || 'phosphor';
  if (!azThemes[azThemeName]) azThemeName = 'phosphor';
  var azTheme = azThemes[azThemeName];

  function azRGBA(a) {
    var p = azTheme.primary;
    return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + a + ')';
  }

  function azSetTheme(name) {
    if (!azThemes[name]) return;
    azThemeName = name;
    azTheme = azThemes[name];
    localStorage.setItem('ui-theme', name);
    // Update CSS accent on root (whole UI)
    var p = azTheme.primary;
    var root = document.documentElement.style;
    root.setProperty('--accent', azTheme.hex);
    root.setProperty('--accent-rgb', p[0] + ', ' + p[1] + ', ' + p[2]);
    root.setProperty('--accent-hover', azTheme.hoverHex);
    root.setProperty('--green', azTheme.hex);
    // Analyzer wrapper accent
    if (azWrap) azWrap.style.setProperty('--az-accent-rgb', p[0] + ',' + p[1] + ',' + p[2]);
    var themeBtn = document.getElementById('ui-theme-btn');
    if (themeBtn) themeBtn.textContent = azTheme.label;
    // Reset spectrogram buffer on theme change
    azSpectroTmp = null;
    azSpectroCol = null;
    if (azCtx) azCtx.clearRect(0, 0, azW, azH);
    if (!azInited) azDrawIdle();
  }

  function azResize() {
    if (!azCrt) return;
    var rect = azCrt.getBoundingClientRect();
    azW = Math.floor(rect.width);
    azH = Math.floor(rect.height);
    if (azW < 1 || azH < 1) return;
    azCanvas.width = azW;
    azCanvas.height = azH;
    azSpectroTmp = null;
    azSpectroCol = null;
    azCtx = azCanvas.getContext('2d');
    if (!azInited) azDrawIdle();
  }


  // --- Server-side FFT: virtual AnalyserNode for Safari ---
  var azServerFFT = false;

  function AzServerAnalyser(binCount) {
    this.frequencyBinCount = binCount;
    this.fftSize = binCount * 2;
    this.smoothingTimeConstant = 0;
    this._freq = new Float32Array(binCount);       // current (smoothed)
    this._freqTarget = new Uint8Array(binCount);   // target from server
    this._time = new Float32Array(binCount * 2);
    this._timeTarget = new Float32Array(binCount * 2);
  }
  AzServerAnalyser.prototype.getByteFrequencyData = function(dst) {
    // Fast attack / slow decay
    var f = this._freq, t = this._freqTarget;
    for (var i = 0; i < f.length; i++) {
      var lerp = t[i] > f[i] ? 0.92 : 0.6;
      f[i] += (t[i] - f[i]) * lerp;
    }
    var len = Math.min(dst.length, f.length);
    for (var i = 0; i < len; i++) dst[i] = f[i] + 0.5 | 0;
  };
  AzServerAnalyser.prototype.getFloatTimeDomainData = function(dst) {
    var tm = this._time, tt = this._timeTarget;
    for (var i = 0; i < tm.length; i++) {
      tm[i] += (tt[i] - tm[i]) * 0.7;
    }
    var len = Math.min(dst.length, tm.length);
    for (var i = 0; i < len; i++) dst[i] = tm[i];
  };

  // --- Pre-allocated circular buffer for FFT (zero-alloc in hot path) ---
  var AZ_RING_CAP = 600;       // ~6.4 sec at 94fps
  var azRingSpec = new Array(AZ_RING_CAP);
  var azRingWL  = new Array(AZ_RING_CAP);
  var azRingWR  = new Array(AZ_RING_CAP);
  var azRingTs  = new Float64Array(AZ_RING_CAP);
  var azRingHead = 0;          // next write position
  var azRingLen  = 0;          // how many filled
  var azMeasuredDelay = null;
  var azLastDelayCheck = 0;

  // Pre-allocate all slots once
  for (var _ri = 0; _ri < AZ_RING_CAP; _ri++) {
    azRingSpec[_ri] = new Uint8Array(1024);
    azRingWL[_ri]   = new Float32Array(512);
    azRingWR[_ri]   = new Float32Array(512);
  }

  function handleFftFrame(buf) {
    if (buf[0] !== 0x01 || !azServerFFT) return;

    // Write to pre-allocated slot — ZERO allocations
    var slot = azRingHead;
    var sp = azRingSpec[slot];
    for (var i = 0; i < 1024 && (1 + i) < buf.length; i++) sp[i] = buf[1 + i];

    var wl = azRingWL[slot];
    for (var i = 0; i < 512 && (1025 + i) < buf.length; i++) {
      var v = buf[1025 + i];
      wl[i] = (v > 127 ? v - 256 : v) / 127.0;
    }

    var wr = azRingWR[slot];
    for (var i = 0; i < 512 && (1537 + i) < buf.length; i++) {
      var v = buf[1537 + i];
      wr[i] = (v > 127 ? v - 256 : v) / 127.0;
    }

    azRingTs[slot] = Date.now();
    azRingHead = (azRingHead + 1) % AZ_RING_CAP;
    if (azRingLen < AZ_RING_CAP) azRingLen++;
  }

  function azMeasureHlsDelay() {
    var now = Date.now();
    if (now - azLastDelayCheck < 2000) return;
    azLastDelayCheck = now;
    try {
      if (getStudioPlayer().seekable.length > 0 && getStudioPlayer().currentTime > 0) {
        var edge = getStudioPlayer().seekable.end(getStudioPlayer().seekable.length - 1);
        var pos = getStudioPlayer().currentTime;
        var bufDelay = edge - pos;
        if (bufDelay > 0 && bufDelay < 30) {
          var measured = bufDelay + 1.0;
          if (azMeasuredDelay === null) {
            azMeasuredDelay = measured;
            log('ANALYZER: measured HLS delay=' + measured.toFixed(1) + 's');
          } else {
            azMeasuredDelay = azMeasuredDelay * 0.85 + measured * 0.15;
          }
        }
      }
    } catch(e) {}
  }

  function azPickDelayedFrame() {
    azMeasureHlsDelay();
    var delay = (azMeasuredDelay || 4) + azSyncOffset;
    var targetTs = Date.now() - delay * 1000;

    // Search from end of circular buffer (newest → oldest)
    for (var j = 1; j <= azRingLen; j++) {
      var idx = (azRingHead - j + AZ_RING_CAP) % AZ_RING_CAP;
      if (azRingTs[idx] <= targetTs) {
        getMainAnalyser()._freqTarget.set(azRingSpec[idx]);
        getAzL()._timeTarget.set(azRingWL[idx]);
        getAzR()._timeTarget.set(azRingWR[idx]);
        return;
      }
    }
  }

  var azStreamAbort = null; // AbortController for Safari stream fallback

  function azInitAnalysers() {
    azMain = azAudioCtx.createAnalyser();
    azMain.fftSize = 2048;
    azMain.smoothingTimeConstant = 0.82;
    azL = azAudioCtx.createAnalyser();
    azL.fftSize = 512;
    azL.smoothingTimeConstant = 0.75;
    azR = azAudioCtx.createAnalyser();
    azR.fftSize = 512;
    azR.smoothingTimeConstant = 0.75;
  }

  // --- Sync delay for Safari stream decode ---
  // Measured ONCE at startup (seekable + pipeline offset).
  // User adjusts via +/-sync buttons, saved in localStorage.
  var azFixedDelay = null; // null = not yet measured
  var azSyncOffset = parseFloat(localStorage.getItem('az-sync-offset')) || 0;

  function azGetHlsDelay() {
    if (azFixedDelay !== null) return azFixedDelay + azSyncOffset;
    try {
      if (getStudioPlayer().seekable.length > 0 && getStudioPlayer().currentTime > 0) {
        var edge = getStudioPlayer().seekable.end(getStudioPlayer().seekable.length - 1);
        var pos = getStudioPlayer().currentTime;
        var bufDelay = edge - pos;
        if (bufDelay > 0 && bufDelay < 30) {
          azFixedDelay = bufDelay + 1.5;
          log('ANALYZER: delay fixed=' + azFixedDelay.toFixed(1) + 's, offset=' + azSyncOffset.toFixed(1) + 's');
          return azFixedDelay + azSyncOffset;
        }
      }
    } catch(e) {}
    return 4 + azSyncOffset; // fallback
  }

  function azAdjustSync(delta) {
    azSyncOffset = Math.round((azSyncOffset + delta) * 10) / 10;
    azSyncOffset = Math.max(-5, Math.min(5, azSyncOffset));
    localStorage.setItem('az-sync-offset', azSyncOffset);
    var total = (azFixedDelay || 4) + azSyncOffset;
    log('ANALYZER: sync offset=' + azSyncOffset.toFixed(1) + 's, total=' + total.toFixed(1) + 's');
    // Update UI
    var lbl = document.getElementById('az-sync-label');
    if (lbl) lbl.textContent = (azSyncOffset >= 0 ? '+' : '') + azSyncOffset.toFixed(1) + 's';
  }

  // Safari fallback: fetch Icecast → decodeAudioData → feed AnalyserNode.
  // Ring buffer: data stored with timestamp, played back with delay.
  // Safari fallback: fetch Icecast → decodeAudioData → feed AnalyserNode.
  // Each chunk delayed via setTimeout by hlsDelay, then start(0).
  // No contiguous scheduling — AnalyserNode doesn't need smooth splicing.
  var azStreamGen = 0; // stream generation for cancelling stale setTimeouts

  function azStartStreamDecode() {
    var gen = ++azStreamGen; // new generation — old setTimeouts won't fire
    azStreamAbort = new AbortController();
    log('ANALYZER: stream decode active (v3 setTimeout)');

    function playChunk(buf) {
      if (gen !== azStreamGen) return; // stale — stream already restarted
      var src = getAudioCtx().createBufferSource();
      src.buffer = buf;
      src.connect(getMainAnalyser());
      if (buf.numberOfChannels >= 2) {
        var sp = getAudioCtx().createChannelSplitter(2);
        src.connect(sp);
        sp.connect(getAzL(), 0);
        sp.connect(getAzR(), 1);
      } else {
        src.connect(getAzL());
        src.connect(getAzR());
      }
      src.start(0); // immediately — delay already handled in setTimeout
    }

    authFetch('/api/audio-stream', { signal: azStreamAbort.signal }).then(function(resp) {
      var reader = resp.body.getReader();
      var chunks = [];
      var total = 0;
      var DECODE_SIZE = 8000;
      var logged = false;

      function pump() {
        reader.read().then(function(result) {
          if (result.done) return;
          chunks.push(result.value);
          total += result.value.length;

          if (total >= DECODE_SIZE) {
            var merged = new Uint8Array(total);
            var off = 0;
            for (var i = 0; i < chunks.length; i++) {
              merged.set(chunks[i], off);
              off += chunks[i].length;
            }
            chunks = [];
            total = 0;

            var delayMs = azGetHlsDelay() * 1000;
            getAudioCtx().decodeAudioData(merged.buffer).then(function(buf) {
              if (gen !== azStreamGen) return;
              setTimeout(function() { playChunk(buf); }, delayMs);
              if (!logged) {
                logged = true;
                var seekInfo = 'N/A';
                try {
                  if (getStudioPlayer().seekable.length > 0 && getStudioPlayer().currentTime > 0) {
                    seekInfo = (getStudioPlayer().seekable.end(0) - getStudioPlayer().currentTime).toFixed(2) + 's';
                  }
                } catch(e) {}
                log('ANALYZER: streaming, delay=' + (delayMs/1000).toFixed(1) + 's, seekable=' + seekInfo);
              }
            }).catch(function() {});
          }
          pump();
        }).catch(function() {});
      }
      pump();
    }).catch(function(e) {
      if (e.name !== 'AbortError') log('ANALYZER: fetch error — ' + e.message);
    });
  }

  function azInit() {
    if (azInited) return;

      if (deps.isSafari) {
        // Safari: WebKit bug 180696 — createMediaElementSource doesn't work with HLS.
        // Hide analyzer completely.
        var awrap = document.getElementById('analyzer-wrap');
        if (awrap) awrap.style.display = 'none';
        log('ANALYZER: Safari — hidden (WebKit bug 180696)');
        return;
      }

    try {
      azAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (azAudioCtx.state === 'suspended') azAudioCtx.resume();

      azInitAnalysers();
      azPeaks = new Array(64).fill(0);

      // Chrome/Firefox path: createMediaElementSource works with HLS
      var source = azAudioCtx.createMediaElementSource(getStudioPlayer());
      azGainNode = azAudioCtx.createGain();
      azGainNode.gain.value = getStudioPlayer().muted ? 0 : 1;

      var splitter = azAudioCtx.createChannelSplitter(2);
      source.connect(azMain);
      source.connect(splitter);
      splitter.connect(azL, 0);
      splitter.connect(azR, 1);
      source.connect(azGainNode);
      azGainNode.connect(azAudioCtx.destination);

      azInited = true;
      azInfo.textContent = (azAudioCtx.sampleRate / 1000) + 'kHz';
      log('ANALYZER: Chrome mode — createMediaElementSource, sr=' + azAudioCtx.sampleRate);
      azLoop();
    } catch (e) {
      log('ANALYZER: init failed — ' + e.message);
      if (azAudioCtx) { azAudioCtx.close().catch(function(){}); azAudioCtx = null; }
    }
  }

  function setPlayerMuted(muted) {
    if (!muted && !getUserInteracted()) return; // never unmute without user gesture
    getStudioPlayer().muted = muted;
    if (getGainNode() && getAudioCtx()) {
      // Use the mixer's music * master gain instead of hardcoded 1 (read live —
      // the faders own those values and they now live in mixer.js)
      getGainNode().gain.setValueAtTime(muted ? 0 : getMonitorMusicGain() * getMasterGain(), getAudioCtx().currentTime);
    }
  }

  // --- Idle state ---
  function azDrawIdle() {
    if (!azCtx || azW < 1 || azH < 1) return;
    azCtx.clearRect(0, 0, azW, azH);
    azDrawGrid(azCtx, azW, azH);
    azCtx.font = '11px monospace';
    azCtx.fillStyle = azRGBA(0.2);
    azCtx.textAlign = 'center';
    azCtx.textBaseline = 'middle';
    azCtx.fillText('SIGNAL STANDBY', azW / 2, azH / 2);
    azCtx.textBaseline = 'alphabetic';
  }

  // --- Main loop ---
  function azLoop() {
    azAnimFrame = requestAnimationFrame(azLoop);
    if (!azInited || !getMainAnalyser() || !azCtx || azW < 1 || azH < 1) return;
    if (azServerFFT) azPickDelayedFrame();
    switch (azMode) {
      case 'spectrum': azDrawSpectrum(); break;
      case 'spectrogram': azDrawSpectrogram(); break;
      case 'scope': azDrawScope(); break;
      case 'levels': azDrawLevels(); break;
    }
    azUpdateGlow();
  }

  // --- Grid ---
  function azDrawGrid(ctx, w, h) {
    ctx.strokeStyle = 'rgba(36, 50, 68, 0.4)';
    ctx.lineWidth = 1;
    for (var i = 1; i < 4; i++) {
      var y = Math.floor(h * i / 4) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    for (var i = 1; i < 8; i++) {
      var x = Math.floor(w * i / 8) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
  }

  // --- SPECTRUM ---
  function azDrawSpectrum() {
    var ctx = azCtx, w = azW, h = azH;
    var bufLen = getMainAnalyser().frequencyBinCount;
    var data = new Uint8Array(bufLen);
    getMainAnalyser().getByteFrequencyData(data);

    ctx.clearRect(0, 0, w, h);
    azDrawGrid(ctx, w, h);

    var numBars = 64;
    var barW = w / numBars;
    var gap = 1;
    var sr = getAudioCtx().sampleRate;
    var logMin = Math.log10(20);
    var logMax = Math.log10(sr / 2);
    var usableH = h - 14;

    for (var i = 0; i < numBars; i++) {
      var logS = logMin + (i / numBars) * (logMax - logMin);
      var logE = logMin + ((i + 1) / numBars) * (logMax - logMin);
      var binS = Math.max(0, Math.floor(Math.pow(10, logS) / sr * bufLen * 2));
      var binE = Math.min(bufLen - 1, Math.floor(Math.pow(10, logE) / sr * bufLen * 2));

      var val = 0;
      for (var b = binS; b <= binE; b++) { if (data[b] > val) val = data[b]; }

      var barH = (val / 255) * usableH;
      var x = i * barW + gap;
      var bw = barW - gap * 2;
      if (bw < 1) bw = 1;

      var ratio = val / 255;
      var rgb = azTheme.spectrumColor(ratio);
      var r = rgb[0], g = rgb[1], bl = rgb[2];

      ctx.shadowColor = 'rgba(' + r + ',' + g + ',' + bl + ',0.35)';
      ctx.shadowBlur = 5;
      ctx.fillStyle = 'rgba(' + r + ',' + g + ',' + bl + ',0.85)';
      ctx.fillRect(x, h - 8 - barH, bw, barH);
      ctx.shadowBlur = 0;

      // Peak hold
      if (val > azPeaks[i]) azPeaks[i] = val;
      else azPeaks[i] = Math.max(0, azPeaks[i] - 1.2);

      var peakY = (azPeaks[i] / 255) * usableH;
      if (peakY > 2) {
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillRect(x, h - 8 - peakY, bw, 1.5);
      }
    }

    // Frequency labels
    var freqs = [60, 250, 1000, 4000, 16000];
    var labels = ['60', '250', '1K', '4K', '16K'];
    ctx.font = '9px monospace';
    ctx.fillStyle = 'rgba(159,182,204,0.45)';
    ctx.textAlign = 'center';
    for (var i = 0; i < freqs.length; i++) {
      var fx = ((Math.log10(freqs[i]) - logMin) / (logMax - logMin)) * w;
      ctx.fillText(labels[i], fx, h - 1);
    }

    // Band zone labels
    var zones = [
      [30, 60, 'SUB'], [80, 150, 'KICK'], [200, 400, 'BASS'],
      [800, 2000, 'MID'], [5000, 10000, 'HIGH'], [12000, 20000, 'AIR']
    ];
    ctx.font = '8px monospace';
    ctx.fillStyle = azRGBA(0.12);
    for (var i = 0; i < zones.length; i++) {
      var zx1 = ((Math.log10(zones[i][0]) - logMin) / (logMax - logMin)) * w;
      var zx2 = ((Math.log10(zones[i][1]) - logMin) / (logMax - logMin)) * w;
      ctx.fillText(zones[i][2], (zx1 + zx2) / 2, 10);
    }
  }

  // --- SPECTROGRAM ---
  function azDrawSpectrogram() {
    var ctx = azCtx, w = azW, h = azH;
    var bufLen = getMainAnalyser().frequencyBinCount;
    var data = new Uint8Array(bufLen);
    getMainAnalyser().getByteFrequencyData(data);
    var sr = getAudioCtx().sampleRate;
    var logMin = Math.log10(20);
    var logMax = Math.log10(sr / 2);

    // Scroll: copy current canvas to temp, redraw shifted
    if (!azSpectroTmp || azSpectroTmp.width !== w || azSpectroTmp.height !== h) {
      azSpectroTmp = document.createElement('canvas');
      azSpectroTmp.width = w;
      azSpectroTmp.height = h;
    }
    var tmpCtx = azSpectroTmp.getContext('2d');
    tmpCtx.clearRect(0, 0, w, h);
    tmpCtx.drawImage(azCanvas, 0, 0);
    var sBg = azTheme.spectroColor(0);
    ctx.fillStyle = 'rgb(' + sBg[0] + ',' + sBg[1] + ',' + sBg[2] + ')';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(azSpectroTmp, -1, 0);

    // New column via ImageData
    if (!azSpectroCol || azSpectroCol.height !== h) {
      azSpectroCol = ctx.createImageData(1, h);
    }
    var px = azSpectroCol.data;
    for (var y = 0; y < h; y++) {
      var logF = logMin + ((h - 1 - y) / (h - 1)) * (logMax - logMin);
      var bin = Math.floor(Math.pow(10, logF) / sr * bufLen * 2);
      if (bin >= bufLen) bin = bufLen - 1;
      var val = data[bin];
      var rgb = azSpectroRGB(val);
      var idx = y * 4;
      px[idx] = rgb[0]; px[idx+1] = rgb[1]; px[idx+2] = rgb[2]; px[idx+3] = 255;
    }
    ctx.putImageData(azSpectroCol, w - 1, 0);

    // Freq labels on left
    var freqs = [100, 500, 2000, 8000];
    var labels = ['100', '500', '2K', '8K'];
    ctx.font = '9px monospace';
    ctx.fillStyle = 'rgba(159,182,204,0.35)';
    ctx.textAlign = 'left';
    for (var i = 0; i < freqs.length; i++) {
      var fy = h - ((Math.log10(freqs[i]) - logMin) / (logMax - logMin)) * h;
      ctx.fillText(labels[i], 3, fy + 3);
    }
  }

  function azSpectroRGB(val) {
    return azTheme.spectroColor(val);
  }

  // --- SCOPE (Vectorscope) ---
  function azDrawScope() {
    var ctx = azCtx, w = azW, h = azH;
    if (!getAzL() || !getAzR()) return;

    var bufLen = getAzL().fftSize;
    var dataL = new Float32Array(bufLen);
    var dataR = new Float32Array(bufLen);
    getAzL().getFloatTimeDomainData(dataL);
    getAzR().getFloatTimeDomainData(dataR);

    // Phosphor decay
    ctx.fillStyle = 'rgba(5,10,14,0.18)';
    ctx.fillRect(0, 0, w, h);

    // Grid: circles + crosshairs
    var cx = w / 2, cy = h / 2;
    var rad = Math.min(cx, cy) - 6;
    ctx.strokeStyle = 'rgba(36,50,68,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, rad * 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - rad, cy); ctx.lineTo(cx + rad, cy);
    ctx.moveTo(cx, cy - rad); ctx.lineTo(cx, cy + rad);
    var d = rad * 0.707;
    ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d);
    ctx.moveTo(cx - d, cy + d); ctx.lineTo(cx + d, cy - d);
    ctx.stroke();

    // Labels
    ctx.font = '9px monospace';
    ctx.fillStyle = 'rgba(159,182,204,0.45)';
    ctx.textAlign = 'center';
    ctx.fillText('M', cx, cy - rad - 3);
    ctx.fillText('+S', cx + rad + 2, cy - 3);
    ctx.fillText('-S', cx - rad - 2, cy - 3);

    // Lissajous trace
    ctx.beginPath();
    ctx.strokeStyle = azRGBA(0.5);
    ctx.lineWidth = 1.2;
    var step = Math.max(1, Math.floor(bufLen / 300));
    for (var i = 0; i < bufLen; i += step) {
      var mid = (dataL[i] + dataR[i]) * 0.5;
      var side = (dataL[i] - dataR[i]) * 0.5;
      var x = cx + side * rad;
      var y = cy - mid * rad;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Bright dots at recent samples
    ctx.shadowColor = azRGBA(0.7);
    ctx.shadowBlur = 3;
    ctx.fillStyle = azRGBA(0.85);
    var recent = Math.max(0, bufLen - 48);
    for (var i = recent; i < bufLen; i += step) {
      var mid = (dataL[i] + dataR[i]) * 0.5;
      var side = (dataL[i] - dataR[i]) * 0.5;
      ctx.fillRect(cx + side * rad - 0.8, cy - mid * rad - 0.8, 1.6, 1.6);
    }
    ctx.shadowBlur = 0;
  }

  // --- LEVELS ---
  function azDrawLevels() {
    var ctx = azCtx, w = azW, h = azH;
    if (!getAzL() || !getAzR()) return;

    var bufLen = getAzL().fftSize;
    var dataL = new Float32Array(bufLen);
    var dataR = new Float32Array(bufLen);
    getAzL().getFloatTimeDomainData(dataL);
    getAzR().getFloatTimeDomainData(dataR);

    ctx.clearRect(0, 0, w, h);
    azDrawGrid(ctx, w, h);

    function calcLevels(d) {
      var sum = 0, pk = 0;
      for (var i = 0; i < d.length; i++) {
        sum += d[i] * d[i];
        var a = Math.abs(d[i]);
        if (a > pk) pk = a;
      }
      return { rms: Math.sqrt(sum / d.length), peak: pk };
    }
    function toDB(v) { return v > 0.00001 ? 20 * Math.log10(v) : -100; }

    var lv = calcLevels(dataL), rv = calcLevels(dataR);
    var rmsL = toDB(lv.rms), rmsR = toDB(rv.rms);
    var pkL = toDB(lv.peak), pkR = toDB(rv.peak);

    // Peak hold (slow decay)
    if (pkL > azPeakHoldL) azPeakHoldL = pkL;
    else azPeakHoldL = Math.max(-100, azPeakHoldL - 0.3);
    if (pkR > azPeakHoldR) azPeakHoldR = pkR;
    else azPeakHoldR = Math.max(-100, azPeakHoldR - 0.3);

    var minDb = -60, maxDb = 0;
    var mL = 36, mR = w - 48;
    var mH = Math.min(24, h / 4);
    var mYL = h * 0.3 - mH / 2;
    var mYR = h * 0.65 - mH / 2;

    function dbToX(db) { return mL + ((db - minDb) / (maxDb - minDb)) * (mR - mL); }

    // Labels
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(159,182,204,0.6)';
    ctx.textAlign = 'right';
    ctx.fillText('L', mL - 6, mYL + mH / 2 + 4);
    ctx.fillText('R', mL - 6, mYR + mH / 2 + 4);

    // Meter backgrounds
    ctx.fillStyle = 'rgba(15,22,32,0.6)';
    ctx.fillRect(mL, mYL, mR - mL, mH);
    ctx.fillRect(mL, mYR, mR - mL, mH);

    function drawMeter(y, rmsDb, peakDb, holdDb) {
      var rmsX = dbToX(Math.max(minDb, Math.min(maxDb, rmsDb)));
      var peakX = dbToX(Math.max(minDb, Math.min(maxDb, peakDb)));
      var holdX = dbToX(Math.max(minDb, Math.min(maxDb, holdDb)));

      // RMS gradient bar
      var grad = ctx.createLinearGradient(mL, 0, mR, 0);
      var ls = azTheme.levelStops;
      for (var si = 0; si < ls.length; si++) grad.addColorStop(ls[si][0], ls[si][1]);

      ctx.shadowColor = azRGBA(0.25);
      ctx.shadowBlur = 4;
      ctx.fillStyle = grad;
      if (rmsX > mL) ctx.fillRect(mL, y, rmsX - mL, mH);
      ctx.shadowBlur = 0;

      // Peak line
      if (peakX > mL + 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect(peakX - 1, y, 2, mH);
      }

      // Peak hold marker
      if (holdX > mL + 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(holdX - 1, y, 2, mH);
      }
    }

    drawMeter(mYL, rmsL, pkL, azPeakHoldL);
    drawMeter(mYR, rmsR, pkR, azPeakHoldR);

    // dB scale
    ctx.font = '8px monospace';
    ctx.fillStyle = 'rgba(159,182,204,0.4)';
    ctx.textAlign = 'center';
    var marks = [-48, -36, -24, -12, -6, 0];
    var scaleY = h * 0.5 - 1;
    for (var i = 0; i < marks.length; i++) {
      var mx = dbToX(marks[i]);
      ctx.fillText(marks[i] + '', mx, scaleY);
      ctx.fillStyle = 'rgba(36,50,68,0.3)';
      ctx.fillRect(mx, mYL - 2, 1, mH + 4);
      ctx.fillRect(mx, mYR - 2, 1, mH + 4);
      ctx.fillStyle = 'rgba(159,182,204,0.4)';
    }

    // dB readout
    ctx.font = '10px monospace';
    ctx.fillStyle = azRGBA(0.65);
    ctx.textAlign = 'left';
    ctx.fillText(rmsL > -100 ? rmsL.toFixed(1) + ' dB' : '-inf', mR + 4, mYL + mH / 2 + 4);
    ctx.fillText(rmsR > -100 ? rmsR.toFixed(1) + ' dB' : '-inf', mR + 4, mYR + mH / 2 + 4);
  }

  // --- BPM glow ---
  function azUpdateGlow() {
    var bpmText = getStudioBpmEl() ? getStudioBpmEl().textContent : '';
    var bpm = parseInt(bpmText);
    if (!bpm || bpm < 60 || bpm > 220 || !getTrackStartedAt() || getBroadcastState().streamMode === 'standby') {
      azCrt.style.boxShadow = '';
      return;
    }
    var beatMs = 60000 / bpm;
    var phase = ((Date.now() - getTrackStartedAt()) % beatMs) / beatMs;
    var pulse = Math.pow(Math.max(0, Math.cos(phase * Math.PI * 2)) * 0.5 + 0.5, 4);
    if (pulse > 0.25) {
      var s = (8 + pulse * 14).toFixed(1);
      var a = (pulse * 0.18).toFixed(3);
      var si = (pulse * 15).toFixed(1);
      var ai = (pulse * 0.025).toFixed(4);
      var gp = azTheme.primary;
      azCrt.style.boxShadow = '0 0 ' + s + 'px rgba(' + gp[0] + ',' + gp[1] + ',' + gp[2] + ',' + a + '), inset 0 0 ' + si + 'px rgba(' + gp[0] + ',' + gp[1] + ',' + gp[2] + ',' + ai + ')';
    } else {
      azCrt.style.boxShadow = '';
    }
  }

  /**
   * The `if (!azInited) azInit()` idiom every external gesture used. Kept as one
   * public method so the player, the mixer and the ARM/PLAY buttons all share it.
   */
  function ensureInited() {
    if (!azInited) azInit();
  }

  /**
   * Restart the Safari stream decode so the analyzer re-syncs with a new HLS
   * session. Was inline in app.js's restartPlayer; the player now calls this.
   */
  function resyncStreamDecode() {
    if (azStreamAbort) {
      azStreamAbort.abort();
      azStreamAbort = null;
      azStartStreamDecode();
    }
  }

  /**
   * Store injected dependencies, then run the boot side-effects in the exact
   * order they ran as module-scope statements in app.js: resolve the DOM refs,
   * bind the mode / on-off / theme controls, apply the saved theme, wire the
   * Safari sync-offset UI, then register the resize listener and size the canvas.
   */
  function init(injected) {
    injected = injected || {};
    for (var k in deps) {
      if (Object.prototype.hasOwnProperty.call(injected, k)) {
        deps[k] = injected[k];
      }
    }
    resolveDom();
    bindUi();
  }

  function bindUi() {
    // --- Mode switching ---
    if (azWrap) {
      var azModeBtns = azWrap.querySelectorAll('.az-mode');
      azModeBtns.forEach(function(btn) {
        btn.addEventListener('click', function() {
          if (!azInited) azInit();
          azMode = btn.dataset.azmode;
          azModeBtns.forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          // Reset mode-specific state
          if (azCtx) azCtx.clearRect(0, 0, azW, azH);
          azSpectroTmp = null;
          azSpectroCol = null;
          azPeakHoldL = -100;
          azPeakHoldR = -100;
        });
      });
    }

    // --- ON/OFF toggle ---
    var azToggle = document.getElementById('az-toggle');
    var azOn = true;
    if (azToggle) {
      azToggle.onclick = function() {
        azOn = !azOn;
        azToggle.textContent = azOn ? 'ON' : 'OFF';
        azToggle.classList.toggle('off', !azOn);
        azWrap.classList.toggle('collapsed', !azOn);
        if (azOn) {
          azResize();
          if (azInited && !azAnimFrame) azLoop();
        } else {
          if (azAnimFrame) { cancelAnimationFrame(azAnimFrame); azAnimFrame = null; }
          azCrt.style.boxShadow = '';
        }
      };
    }

    // --- Theme switching ---
    var azThemeBtn = document.getElementById('ui-theme-btn');
    if (azThemeBtn) {
      azThemeBtn.addEventListener('click', function() {
        var idx = azThemeNames.indexOf(azThemeName);
        var next = azThemeNames[(idx + 1) % azThemeNames.length];
        azSetTheme(next);
      });
    }

    // Apply saved theme on load
    azSetTheme(azThemeName);

    // --- Sync offset UI (Safari stream decode only) ---
    if (deps.isSafari) {
      var syncWrap = document.getElementById('az-sync');
      var syncLabel = document.getElementById('az-sync-label');
      var syncMinus = document.getElementById('az-sync-minus');
      var syncPlus = document.getElementById('az-sync-plus');
      if (syncWrap) {
        syncWrap.style.display = 'inline-flex';
        if (syncLabel) syncLabel.textContent = (azSyncOffset >= 0 ? '+' : '') + azSyncOffset.toFixed(1) + 's';
        if (syncMinus) syncMinus.addEventListener('click', function(e) {
          e.stopPropagation();
          azAdjustSync(-0.5);
        });
        if (syncPlus) syncPlus.addEventListener('click', function(e) {
          e.stopPropagation();
          azAdjustSync(0.5);
        });
      }
    }

    // --- Init canvas on load + resize ---
    window.addEventListener('resize', azResize);
    azResize();
  }

  return {
    init: init,
    // WebAudio graph getters (moved with the graph they read).
    getAudioCtx: getAudioCtx,
    getGainNode: getGainNode,
    getMainAnalyser: getMainAnalyser,
    getAzL: getAzL,
    getAzR: getAzR,
    getAzInited: getAzInited,
    // Init latch
    azInit: azInit,
    ensureInited: ensureInited,
    // Mute control (drives the analyzer gain node)
    setPlayerMuted: setPlayerMuted,
    // Safari server-FFT path — connectWs stays in app.js and calls these.
    handleFftFrame: handleFftFrame,
    isServerFFT: function () { return azServerFFT; },
    // Safari stream decode — the player calls this from restartPlayer.
    resyncStreamDecode: resyncStreamDecode,
  };
});
