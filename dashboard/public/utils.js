/**
 * utils.js — Pure utility functions extracted from app.js (STUDIO 23 / FreeRadio dashboard).
 *
 * All functions are standalone with no DOM or closure dependencies.
 * State-dependent functions accept their required state as explicit parameters.
 *
 * Do NOT modify app.js — this module exists solely for testing.
 */

'use strict';

// ---------------------------------------------------------------------------
// Pure formatting utilities
// ---------------------------------------------------------------------------

/**
 * Zero-pad a single-digit integer to two digits.
 * @param {number} n
 * @returns {string}
 */
export function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

/**
 * Format a byte count as a human-readable string (B / KB / MB).
 * @param {number} bytes
 * @returns {string}
 */
export function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

/**
 * Strip the directory path, file extension and underscores from a filename.
 * @param {string|null|undefined} filename
 * @returns {string}
 */
export function cleanTrackName(filename) {
  if (!filename) return '';
  var name = filename.split('/').pop() || filename;
  name = name.replace(/\.[^.]+$/, '');
  name = name.replace(/_/g, ' ');
  return name;
}

/**
 * Return a human-readable relative-time string for a Unix-ms timestamp.
 * @param {number} ts  — timestamp in milliseconds (Date.now() style)
 * @returns {string}
 */
export function timeAgo(ts) {
  var diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

/**
 * Format a duration in seconds as "m:ss".
 * @param {number|null|undefined} sec
 * @returns {string}
 */
export function formatTime(sec) {
  if (!sec || sec < 0) return '0:00';
  var m = Math.floor(sec / 60);
  var s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

/**
 * Format a duration in milliseconds as "m:ss" (PTT timer display).
 * @param {number} ms
 * @returns {string}
 */
export function pttFormatTime(ms) {
  var s = Math.floor(ms / 1000);
  var m = Math.floor(s / 60);
  s = s % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// ---------------------------------------------------------------------------
// State-dependent logic (refactored to accept state as parameters)
// ---------------------------------------------------------------------------

/**
 * Compute the crossfade/mix duration in seconds for a given BPM and mix mode.
 *
 * Mirrors the Liquidsoap crossfade logic from app.js computeMixDur(), refactored
 * to accept mixMode as an explicit parameter instead of reading from closure.
 *
 * @param {number} bpm
 * @param {'cut'|'crossfade'|'smart'|string} mixMode
 * @returns {number}
 */
export function computeMixDur(bpm, mixMode) {
  if (mixMode === 'cut') return 0;
  if (mixMode === 'crossfade') return 5.0;
  // Smart mode: 8 bars at track BPM, capped at 28s
  if (!bpm || bpm <= 0) return 10.0; // reasonable default
  var barDur = (60.0 / bpm) * 4.0;
  var mixBars = Math.min(8, Math.floor(28.0 / barDur));
  mixBars = Math.max(2, mixBars);
  return mixBars * barDur;
}

/**
 * Determine the broadcast phase label from a broadcast state object.
 *
 * Mirrors getBroadcastPhase() from app.js, refactored to accept state as a
 * parameter instead of reading from the broadcastState closure variable.
 *
 * @param {{ arming?: boolean, streamMode?: string, broadcast?: boolean }} state
 * @returns {'arming'|'broadcasting'|'armed'|'live'|'playing'|'idle'}
 */
export function getBroadcastPhase(state) {
  if (state.arming) return 'arming';
  if (state.streamMode === 'armed') {
    return state.broadcast ? 'broadcasting' : 'armed';
  }
  if (state.streamMode === 'live') {
    return state.broadcast ? 'live' : 'playing';
  }
  return 'idle';
}

/**
 * Derive the UI mode and sub-mode from a backend visualMode string.
 *
 * Mirrors deriveUiMode() from app.js, refactored to accept visualMode as a
 * parameter and return an object instead of mutating broadcastState.
 *
 * @param {string|null|undefined} visualMode
 * @returns {{ uiMode: string, uiSubMode: string }}
 */
export function deriveUiMode(visualMode) {
  if (visualMode === 'live') {
    return { uiMode: 'takeover', uiSubMode: 'obs' };
  }
  return { uiMode: 'radio', uiSubMode: visualMode || 'visual-radio' };
}

/**
 * Generate a unique platform name that does not collide with any existing name.
 *
 * Mirrors uniquePlatformName() from app.js, refactored to accept the existing
 * names array as an explicit parameter instead of reading currentPlatformNames.
 *
 * @param {string} base            — desired base name (e.g. 'YouTube')
 * @param {string[]} existingNames — array of names already in use
 * @returns {string}
 */
export function uniquePlatformName(base, existingNames) {
  if (existingNames.indexOf(base) === -1) return base;
  for (var i = 2; i <= 99; i++) {
    var candidate = base + ' ' + i;
    if (existingNames.indexOf(candidate) === -1) return candidate;
  }
  return base + ' ' + Date.now();
}

// ---------------------------------------------------------------------------
// XSS protection
// ---------------------------------------------------------------------------

/**
 * Escape HTML special chars for safe innerHTML insertion.
 * @param {*} str
 * @returns {*} — escaped string, or original value if not a string
 */
export function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
