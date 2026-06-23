/**
 * analytics.js — Analytics UI for the STUDIO 23 / FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js analytics refactor).
 * Renders the listener-count line chart, the top-tracks bar chart, and loads the
 * history-stats panel (total / unique / peak / uptime).
 *
 * This module owns NO state of its own — analytics is stateless. It reads the
 * shared, read-only listener state (`listenerHistory`, `peakListeners`) LIVE via
 * the injected getters, because that state is fed by the WebSocket updateIcecast
 * handler in app.js and must never be cached. The only service it needs is
 * authFetch (for GET /api/history/stats). DOM and canvas (document.getElementById,
 * getContext, getComputedStyle) are accessed directly as browser globals.
 *
 * Dependency injection: `init(deps)` receives { authFetch, getListenerHistory,
 * getPeakListeners }. The getters are read AT CALL TIME, never cached.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/analytics.js"> (attaches its public API to window.FRAnalytics)
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
    window.FRAnalytics = api;
  }
})(function () {
  'use strict';

  // Injected host service + live shared-state getters (set by init). Analytics
  // owns no state of its own; listenerHistory/peakListeners are read live from
  // app.js (where the WS updateIcecast handler writes them).
  var deps = {
    authFetch: function () { return Promise.reject(new Error('FRAnalytics not initialised')); },
    getListenerHistory: function () { return []; },
    getPeakListeners: function () { return 0; },
  };

  function authFetch(url, opts) { return deps.authFetch(url, opts); }
  function getListenerHistory() { return deps.getListenerHistory(); }
  function getPeakListeners() { return deps.getPeakListeners(); }

  // -------------------------------------------------------------------------
  // Analytics UI (behaviour-identical to the former app.js functions).
  // -------------------------------------------------------------------------
  function loadAnalytics() {
    drawListenerChart();
    loadHistoryStats();
  }

  function drawListenerChart() {
    var canvas = document.getElementById('listeners-chart');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var w = canvas.width = canvas.parentElement.offsetWidth - 24;
    var h = canvas.height = 200;

    ctx.clearRect(0, 0, w, h);

    var listenerHistory = getListenerHistory();
    if (listenerHistory.length < 2) {
      ctx.fillStyle = '#9fb6cc';
      ctx.font = '13px monospace';
      ctx.fillText('Collecting data...', w / 2 - 60, h / 2);
      return;
    }

    var maxCount = Math.max.apply(null, listenerHistory.map(function(p) { return p.count; })) || 1;
    var padding = 40;
    var graphW = w - padding * 2;
    var graphH = h - padding * 2;

    ctx.strokeStyle = '#1c2631';
    ctx.lineWidth = 1;
    for (var i = 0; i <= 4; i++) {
      var gy = padding + graphH * (1 - i / 4);
      ctx.beginPath();
      ctx.moveTo(padding, gy);
      ctx.lineTo(w - padding, gy);
      ctx.stroke();
      ctx.fillStyle = '#9fb6cc';
      ctx.font = '10px monospace';
      ctx.fillText(Math.round(maxCount * i / 4), 2, gy + 4);
    }

    var accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c4ffcb';
    var accentRgb = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '196, 255, 203';
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    listenerHistory.forEach(function(p, idx) {
      var x = padding + (idx / (listenerHistory.length - 1)) * graphW;
      var y = padding + graphH * (1 - p.count / maxCount);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.lineTo(padding + graphW, padding + graphH);
    ctx.lineTo(padding, padding + graphH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(' + accentRgb + ', 0.1)';
    ctx.fill();
  }

  function loadHistoryStats() {
    authFetch('/api/history/stats')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        document.getElementById('analytics-total-tracks').textContent = data.totalPlayed || 0;
        document.getElementById('analytics-unique-tracks').textContent = data.uniqueTracks || 0;
        document.getElementById('analytics-peak-listeners').textContent = getPeakListeners();
        drawTopTracksChart(data.topTracks || []);
        if (data.uptimeMs) {
          var hrs = Math.floor(data.uptimeMs / 3600000);
          var mins = Math.floor((data.uptimeMs % 3600000) / 60000);
          document.getElementById('analytics-uptime-value').textContent = hrs + 'h ' + mins + 'm';
        }
      })
      .catch(function() {
        document.getElementById('analytics-total-tracks').textContent = '0';
        document.getElementById('analytics-unique-tracks').textContent = '0';
        document.getElementById('analytics-peak-listeners').textContent = getPeakListeners();
      });
  }

  function drawTopTracksChart(tracks) {
    var canvas = document.getElementById('tracks-chart');
    if (!canvas || !tracks.length) return;
    var ctx = canvas.getContext('2d');
    var w = canvas.width = canvas.parentElement.offsetWidth - 24;
    var h = canvas.height = Math.max(200, tracks.length * 30 + 40);

    ctx.clearRect(0, 0, w, h);

    var top10 = tracks.slice(0, 10);
    var maxPlays = top10[0] ? top10[0].count : 1;
    var barH = 22;
    var gap = 6;
    var labelW = 200;

    top10.forEach(function(t, idx) {
      var y = 20 + idx * (barH + gap);
      var barW = (w - labelW - 60) * (t.count / maxPlays);

      ctx.fillStyle = '#243244';
      ctx.fillRect(labelW, y, w - labelW - 60, barH);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c4ffcb';
      ctx.fillRect(labelW, y, barW, barH);

      ctx.fillStyle = '#d7e1ea';
      ctx.font = '11px monospace';
      var name = t.track.length > 28 ? t.track.substr(0, 28) + '...' : t.track;
      ctx.fillText(name, 4, y + 15);

      ctx.fillStyle = '#9fb6cc';
      ctx.fillText(t.count + 'x', w - 50, y + 15);
    });
  }

  /**
   * Store injected dependencies. Safe to call more than once (the vitest harness
   * re-inits per test with its own controllable deps).
   */
  function init(injected) {
    injected = injected || {};
    for (var k in deps) {
      if (Object.prototype.hasOwnProperty.call(injected, k)) {
        deps[k] = injected[k];
      }
    }
  }

  return {
    init: init,
    loadAnalytics: loadAnalytics,

    // Surface used by the characterization tests to drive the module.
    drawListenerChart: drawListenerChart,
    loadHistoryStats: loadHistoryStats,
    drawTopTracksChart: drawTopTracksChart,
  };
});
