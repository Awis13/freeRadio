/**
 * channelstrip.js — Channel-strip DSP UI for the STUDIO 23 / FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js channel-strip
 * refactor). Owns the strip metering/debounce/loaded state plus the DOM refs the
 * cluster captures ONCE AT BOOT (stripBypass / stripPreset / stripBypassBadge /
 * stripGateLed / stripCompGr), wires the bypass + preset + slider handlers, and
 * runs the self-contained boot config load + 2s metering auto-start gate.
 *
 * Dependency injection: `init(deps)` receives the host services (authFetch, log,
 * showError). init() copies the injected deps, THEN resolves the five captured
 * DOM refs via getElementById (preserving the former boot-time "capture once"
 * semantics), THEN runs the four boot binding blocks (bypass onchange, preset
 * onchange, slider oninput, boot load + 2s auto-start) — each null-guarded
 * exactly as the original app.js closure already guarded them. Functions that
 * read the DOM via dynamic getElementById at call time keep doing so.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/channelstrip.js"> (attaches its public API to
 * window.FRChannelStrip) AND required by the vitest suite via module.exports
 * (CJS). It deliberately uses NO top-level `export`/`import` so a browser
 * <script> can load it without a SyntaxError.
 */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.FRChannelStrip = api;
  }
})(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Module-owned state (moved out of app.js). The DOM-ref vars are declared at
  // module scope but ASSIGNED inside init() (null until init), preserving the
  // former closure's "capture once at boot" semantics.
  // -------------------------------------------------------------------------
  var stripBypass = null;
  var stripPreset = null;
  var stripBypassBadge = null;
  var stripGateLed = null;
  var stripCompGr = null;
  var stripDebounce = null;
  var stripMeteringInterval = null;
  var stripLoaded = false;

  // Injected host services (set by init).
  var deps = {
    authFetch: function () { return Promise.reject(new Error('FRChannelStrip not initialised')); },
    log: function () {},
    showError: function () {},
  };

  // -------------------------------------------------------------------------
  // Helpers that resolve injected services at call time.
  // -------------------------------------------------------------------------
  function authFetch(url, opts) { return deps.authFetch(url, opts); }
  function log(msg) { return deps.log(msg); }
  function showError(msg) { return deps.showError(msg); }

  // All channel strip sliders
  var STRIP_PARAMS = [
    { id: "strip-gate-threshold", key: "gate_threshold", unit: " dB" },
    { id: "strip-gate-attack", key: "gate_attack", unit: " ms" },
    { id: "strip-gate-release", key: "gate_release", unit: " ms" },
    { id: "strip-eq-low-freq", key: "eq_low_freq", unit: " Hz" },
    { id: "strip-eq-low-slope", key: "eq_low_slope", unit: " dB" },
    { id: "strip-eq-mid-freq", key: "eq_mid_freq", unit: " Hz" },
    { id: "strip-eq-mid-gain", key: "eq_mid_gain", unit: " dB" },
    { id: "strip-eq-mid-q", key: "eq_mid_q", unit: "", fmt: function(v) { return parseFloat(v).toFixed(1); } },
    { id: "strip-eq-high-freq", key: "eq_high_freq", unit: " Hz" },
    { id: "strip-eq-high-slope", key: "eq_high_slope", unit: " dB" },
    { id: "strip-comp-threshold", key: "comp_threshold", unit: " dB" },
    { id: "strip-comp-ratio", key: "comp_ratio", unit: ":1" },
    { id: "strip-comp-attack", key: "comp_attack", unit: " ms" },
    { id: "strip-comp-release", key: "comp_release", unit: " ms" },
    { id: "strip-comp-makeup", key: "comp_makeup", unit: " dB" },
    { id: "strip-lim-threshold", key: "lim_threshold", unit: " dB" },
    { id: "strip-output-gain", key: "output_gain", unit: " dB", fmt: function(v) { return (20 * Math.log10(Math.max(0.001, parseFloat(v)))).toFixed(1); } }
  ];

  // Update slider value display
  function stripUpdateVal(param) {
    var el = document.getElementById(param.id);
    var valEl = document.getElementById(param.id + "-val");
    if (!el || !valEl) return;
    var v = el.value;
    var display = param.fmt ? param.fmt(v) : v;
    valEl.textContent = display + param.unit;
  }

  // Load config from server
  function stripLoadConfig() {
    authFetch("/api/channel-strip")
      .then(function(r) { return r.json(); })
      .then(function(data) {
        stripLoaded = true;
        if (data.bypass !== undefined) {
          if (stripBypass) stripBypass.checked = !!data.bypass;
          stripUpdateBadge(data.bypass);
        }
        STRIP_PARAMS.forEach(function(param) {
          if (data[param.key] !== undefined) {
            var el = document.getElementById(param.id);
            if (el) {
              el.value = data[param.key];
              stripUpdateVal(param);
            }
          }
        });
        log("strip: config loaded (bypass=" + data.bypass + ")");
      })
      .catch(function(e) { log("strip: load error: " + e); });
  }

  function stripUpdateBadge(bypass) {
    if (!stripBypassBadge) return;
    var grid = document.getElementById("channel-strip-grid");
    if (bypass) {
      stripBypassBadge.textContent = "BYPASS";
      stripBypassBadge.className = "strip-badge bypass";
      if (grid) grid.classList.add("bypassed");
    } else {
      stripBypassBadge.textContent = "ACTIVE";
      stripBypassBadge.className = "strip-badge active";
      if (grid) grid.classList.remove("bypassed");
    }
  }

  // Send changes with debounce
  function stripSendConfig(params) {
    clearTimeout(stripDebounce);
    stripDebounce = setTimeout(function() {
      authFetch("/api/channel-strip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params)
      }).catch(function(e) { log("strip: send error: " + e); });
    }, 50);
  }

  // Metering polling (300ms)
  function stripStartMetering() {
    if (stripMeteringInterval) return;
    stripMeteringInterval = setInterval(function() {
      authFetch("/api/channel-strip/metering")
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var gateOpen = data.gate > 0.5;
          // Gate LED (large, meters column)
          if (stripGateLed) {
            stripGateLed.className = "strip-led-large" + (gateOpen ? " open" : "");
          }
          // Compact gate LED (header)
          var compactGate = document.getElementById("strip-compact-gate");
          if (compactGate) {
            compactGate.className = "strip-led" + (gateOpen ? " open" : "");
          }
          // Compressor GR meter (vertical)
          if (stripCompGr) {
            var gr = data.comp_gain || 0;
            var grDb = Math.max(-20, Math.min(0, gr));
            var pct = Math.abs(grDb) / 20 * 100;
            var fill = stripCompGr.querySelector(".strip-gr-vertical-fill");
            if (fill) fill.style.height = pct + "%";
            // GR value text
            var grVal = document.getElementById("strip-gr-value");
            if (grVal) grVal.textContent = grDb.toFixed(1) + " dB";
          }
          // Compact GR text (header)
          var compactGr = document.getElementById("strip-compact-gr");
          if (compactGr) {
            var grDb2 = Math.max(-20, Math.min(0, data.comp_gain || 0));
            compactGr.textContent = grDb2.toFixed(1) + " dB";
          }
        })
        .catch(function() {});
    }, 300);
  }

  function stripStopMetering() {
    if (stripMeteringInterval) {
      clearInterval(stripMeteringInterval);
      stripMeteringInterval = null;
    }
    // Reset LED and GR meter
    if (stripGateLed) stripGateLed.className = "strip-led-large";
    if (stripCompGr) {
      var fill = stripCompGr.querySelector(".strip-gr-vertical-fill");
      if (fill) fill.style.height = "0%";
    }
    var grVal = document.getElementById("strip-gr-value");
    if (grVal) grVal.textContent = "0 dB";
    var compactGate = document.getElementById("strip-compact-gate");
    if (compactGate) compactGate.className = "strip-led";
    var compactGr = document.getElementById("strip-compact-gr");
    if (compactGr) compactGr.textContent = "0 dB";
  }

  /**
   * Store injected dependencies, resolve the five captured DOM refs (preserving
   * the former boot-time "capture once" semantics), then run the four boot
   * binding blocks (bypass onchange, preset onchange, slider oninput, boot load
   * + 2s auto-start) — each null-guarded exactly as the original app.js closure
   * already guarded them. Safe to call more than once (the vitest harness
   * re-inits per test with its own deps).
   */
  function init(injected) {
    injected = injected || {};
    window.FRUtils.mergeDeps(deps, injected, 'FRChannelStrip');

    stripBypass = document.getElementById("strip-bypass");
    stripPreset = document.getElementById("strip-preset");
    stripBypassBadge = document.getElementById("strip-bypass-badge");
    stripGateLed = document.getElementById("strip-gate-led");
    stripCompGr = document.getElementById("strip-comp-gr");

    // Bypass toggle
    if (stripBypass) stripBypass.onchange = function() {
      var bypass = stripBypass.checked;
      stripUpdateBadge(bypass);
      stripSendConfig({ bypass: bypass });
      stripPreset.value = "";
      log("strip: bypass=" + bypass);
      // Start/stop metering
      if (!bypass) stripStartMetering();
      else stripStopMetering();
    };

    // Preset selector
    if (stripPreset) stripPreset.onchange = function() {
      var name = stripPreset.value;
      if (!name) return;
      authFetch("/api/channel-strip/preset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name })
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok) {
            log("strip: preset=" + name);
            stripLoadConfig();
          } else {
            showError("Strip preset failed: " + (data.error || "unknown"));
          }
        })
        .catch(function(e) { showError("Strip preset failed: " + e); });
    };

    // Sliders — oninput
    STRIP_PARAMS.forEach(function(param) {
      var el = document.getElementById(param.id);
      if (!el) return;
      el.oninput = function() {
        stripUpdateVal(param);
        var obj = {};
        obj[param.key] = parseFloat(el.value);
        stripSendConfig(obj);
        stripPreset.value = "";
      };
    });

    if (stripBypass) {
      stripLoadConfig();
      // Start metering if strip is active
      setTimeout(function() {
        if (stripLoaded && stripBypass && !stripBypass.checked) stripStartMetering();
      }, 2000);
    }
  }

  return {
    init: init,
    STRIP_PARAMS: STRIP_PARAMS,
    stripUpdateVal: stripUpdateVal,
    stripLoadConfig: stripLoadConfig,
    stripUpdateBadge: stripUpdateBadge,
    stripSendConfig: stripSendConfig,
    stripStartMetering: stripStartMetering,
    stripStopMetering: stripStopMetering,
    getMeteringInterval: function () { return stripMeteringInterval; },
    getStripLoaded: function () { return stripLoaded; },
    setStripLoaded: function (v) { stripLoaded = v; },
  };
});
