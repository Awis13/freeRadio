/**
 * tests/dashboard/utils.test.js
 *
 * Comprehensive unit tests for dashboard-snapshot/utils.js.
 * All pure utility functions and refactored state-dependent logic are covered.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

// utils.js is now a dual-target UMD module (window.FRUtils + module.exports),
// loaded directly by the browser as a plain <script>. Consume it here via CJS
// require so the same shipped file is exercised by the suite.
const require = createRequire(import.meta.url);
const utilsPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../dashboard/public/utils.js'
);
const {
  pad,
  fmtSize,
  cleanTrackName,
  timeAgo,
  formatTime,
  pttFormatTime,
  computeMixDur,
  getBroadcastPhase,
  deriveUiMode,
  uniquePlatformName,
  escapeHtml,
} = require(utilsPath);

// ---------------------------------------------------------------------------
// pad(n)
// ---------------------------------------------------------------------------
describe('pad(n)', () => {
  it('pads 0 to "00"', () => expect(pad(0)).toBe('00'));
  it('pads 5 to "05"', () => expect(pad(5)).toBe('05'));
  it('pads 9 to "09"', () => expect(pad(9)).toBe('09'));
  it('does not pad 10 — returns "10"', () => expect(pad(10)).toBe('10'));
  it('does not pad 99 — returns "99"', () => expect(pad(99)).toBe('99'));
});

// ---------------------------------------------------------------------------
// fmtSize(bytes)
// ---------------------------------------------------------------------------
describe('fmtSize(bytes)', () => {
  it('formats 0 bytes as "0 B"', () => expect(fmtSize(0)).toBe('0 B'));
  it('formats 512 bytes as "512 B"', () => expect(fmtSize(512)).toBe('512 B'));
  it('formats 1023 bytes as "1023 B" (just below 1 KB)', () => expect(fmtSize(1023)).toBe('1023 B'));
  it('formats 1024 bytes as "1.0 KB"', () => expect(fmtSize(1024)).toBe('1.0 KB'));
  it('formats 1536 bytes as "1.5 KB"', () => expect(fmtSize(1536)).toBe('1.5 KB'));
  it('formats 1048575 bytes as "1024.0 KB" (just below 1 MB)', () => expect(fmtSize(1048575)).toBe('1024.0 KB'));
  it('formats 1048576 bytes as "1.0 MB"', () => expect(fmtSize(1048576)).toBe('1.0 MB'));
  it('formats 10485760 bytes as "10.0 MB"', () => expect(fmtSize(10485760)).toBe('10.0 MB'));
});

// ---------------------------------------------------------------------------
// cleanTrackName(filename)
// ---------------------------------------------------------------------------
describe('cleanTrackName(filename)', () => {
  it('returns "" for empty string', () => expect(cleanTrackName('')).toBe(''));
  it('returns "" for null', () => expect(cleanTrackName(null)).toBe(''));
  it('returns "" for undefined', () => expect(cleanTrackName(undefined)).toBe(''));

  it('strips extension from a simple filename', () =>
    expect(cleanTrackName('track.mp3')).toBe('track'));

  it('strips path and extension, replaces underscores with spaces', () =>
    expect(cleanTrackName('/path/to/my_track.wav')).toBe('my track'));

  it('replaces underscores in a longer name', () =>
    expect(cleanTrackName('some_long_track_name.flac')).toBe('some long track name'));

  it('replaces underscores when there is no extension', () =>
    expect(cleanTrackName('no_extension')).toBe('no extension'));

  it('strips only the last extension when multiple dots are present', () =>
    expect(cleanTrackName('file.with.many.dots.mp3')).toBe('file.with.many.dots'));
});

// ---------------------------------------------------------------------------
// timeAgo(ts)
// ---------------------------------------------------------------------------
describe('timeAgo(ts)', () => {
  it('returns "just now" when diff < 60s (e.g. 30s ago)', () => {
    expect(timeAgo(Date.now() - 30 * 1000)).toBe('just now');
  });

  it('returns "just now" at the 59s boundary', () => {
    expect(timeAgo(Date.now() - 59 * 1000)).toBe('just now');
  });

  it('returns "1m ago" at the 60s boundary', () => {
    expect(timeAgo(Date.now() - 60 * 1000)).toBe('1m ago');
  });

  it('returns "2m ago" for 120s', () => {
    expect(timeAgo(Date.now() - 120 * 1000)).toBe('2m ago');
  });

  it('returns "59m ago" at the 3599s boundary', () => {
    expect(timeAgo(Date.now() - 3599 * 1000)).toBe('59m ago');
  });

  it('returns "1h ago" at the 3600s boundary', () => {
    expect(timeAgo(Date.now() - 3600 * 1000)).toBe('1h ago');
  });

  it('returns "2h ago" for 7200s', () => {
    expect(timeAgo(Date.now() - 7200 * 1000)).toBe('2h ago');
  });

  it('returns "2d ago" for 172800s (48h)', () => {
    expect(timeAgo(Date.now() - 172800 * 1000)).toBe('2d ago');
  });
});

// ---------------------------------------------------------------------------
// formatTime(sec)
// ---------------------------------------------------------------------------
describe('formatTime(sec)', () => {
  it('returns "0:00" for 0', () => expect(formatTime(0)).toBe('0:00'));
  it('returns "0:00" for null', () => expect(formatTime(null)).toBe('0:00'));
  it('returns "0:00" for undefined', () => expect(formatTime(undefined)).toBe('0:00'));
  it('returns "0:00" for negative values', () => expect(formatTime(-5)).toBe('0:00'));

  it('formats 5s as "0:05"', () => expect(formatTime(5)).toBe('0:05'));
  it('formats 59s as "0:59"', () => expect(formatTime(59)).toBe('0:59'));
  it('formats 60s as "1:00"', () => expect(formatTime(60)).toBe('1:00'));
  it('formats 65s as "1:05"', () => expect(formatTime(65)).toBe('1:05'));
  it('formats 125s as "2:05"', () => expect(formatTime(125)).toBe('2:05'));
  it('formats 600s as "10:00"', () => expect(formatTime(600)).toBe('10:00'));
  it('formats 3661s as "61:01"', () => expect(formatTime(3661)).toBe('61:01'));
});

// ---------------------------------------------------------------------------
// pttFormatTime(ms)
// ---------------------------------------------------------------------------
describe('pttFormatTime(ms)', () => {
  it('formats 0ms as "0:00"', () => expect(pttFormatTime(0)).toBe('0:00'));
  it('formats 500ms as "0:00" (floor)', () => expect(pttFormatTime(500)).toBe('0:00'));
  it('formats 1000ms as "0:01"', () => expect(pttFormatTime(1000)).toBe('0:01'));
  it('formats 5500ms as "0:05" (floor)', () => expect(pttFormatTime(5500)).toBe('0:05'));
  it('formats 60000ms as "1:00"', () => expect(pttFormatTime(60000)).toBe('1:00'));
  it('formats 65000ms as "1:05"', () => expect(pttFormatTime(65000)).toBe('1:05'));
});

// ---------------------------------------------------------------------------
// computeMixDur(bpm, mixMode)
// ---------------------------------------------------------------------------
describe('computeMixDur(bpm, mixMode)', () => {
  describe('cut mode', () => {
    it('returns 0 regardless of BPM', () => {
      expect(computeMixDur(140, 'cut')).toBe(0);
      expect(computeMixDur(0, 'cut')).toBe(0);
      expect(computeMixDur(null, 'cut')).toBe(0);
    });
  });

  describe('crossfade mode', () => {
    it('returns 5.0 regardless of BPM', () => {
      expect(computeMixDur(140, 'crossfade')).toBe(5.0);
      expect(computeMixDur(0, 'crossfade')).toBe(5.0);
      expect(computeMixDur(null, 'crossfade')).toBe(5.0);
    });
  });

  describe('smart mode', () => {
    it('returns 10.0 (default) for null BPM', () =>
      expect(computeMixDur(null, 'smart')).toBe(10.0));

    it('returns 10.0 (default) for 0 BPM', () =>
      expect(computeMixDur(0, 'smart')).toBe(10.0));

    it('returns 10.0 (default) for negative BPM', () =>
      expect(computeMixDur(-20, 'smart')).toBe(10.0));

    it('140 BPM: barDur=1.714s, 8 bars fit under 28s → 8 * (60/140*4)', () => {
      // barDur = (60/140)*4 = 1.71428...
      // floor(28 / 1.71428) = floor(16.333) = 16, min(8,16)=8, max(2,8)=8
      // result = 8 * (60/140*4) = 13.71428...
      const expected = 8 * ((60 / 140) * 4);
      expect(computeMixDur(140, 'smart')).toBeCloseTo(expected, 10);
    });

    it('200 BPM: barDur=1.2s, 8 bars fit under 28s → 8 * 1.2 = 9.6', () => {
      // barDur = (60/200)*4 = 1.2
      // floor(28/1.2) = floor(23.33) = 23, min(8,23)=8, max(2,8)=8
      // result = 8 * 1.2 = 9.6
      expect(computeMixDur(200, 'smart')).toBeCloseTo(9.6, 10);
    });

    it('60 BPM: barDur=4s, 8 bars = 32s > 28s → cap at 7 bars → 28s', () => {
      // barDur = (60/60)*4 = 4.0
      // floor(28/4) = 7, min(8,7)=7, max(2,7)=7
      // result = 7 * 4 = 28.0
      expect(computeMixDur(60, 'smart')).toBe(28.0);
    });

    it('30 BPM: barDur=8s, floor(28/8)=3 bars → 3 * 8 = 24s', () => {
      // barDur = (60/30)*4 = 8.0
      // floor(28/8) = 3, min(8,3)=3, max(2,3)=3
      // result = 3 * 8 = 24.0
      expect(computeMixDur(30, 'smart')).toBe(24.0);
    });

    it('20 BPM: barDur=12s, floor(28/12)=2 bars (max(2,2)=2) → 2 * 12 = 24s', () => {
      // barDur = (60/20)*4 = 12.0
      // floor(28/12) = 2, min(8,2)=2, max(2,2)=2
      // result = 2 * 12 = 24.0
      expect(computeMixDur(20, 'smart')).toBe(24.0);
    });

    it('returns 10.0 (default) when mixMode is an unrecognised string', () => {
      // Falls through cut/crossfade checks; bpm is falsy so returns default
      expect(computeMixDur(0, 'unknown')).toBe(10.0);
    });
  });
});

// ---------------------------------------------------------------------------
// getBroadcastPhase(state)
// ---------------------------------------------------------------------------
describe('getBroadcastPhase(state)', () => {
  it('returns "arming" when state.arming is true', () =>
    expect(getBroadcastPhase({ arming: true })).toBe('arming'));

  it('returns "arming" even if streamMode=armed and broadcast=true (arming takes priority)', () =>
    expect(getBroadcastPhase({ arming: true, streamMode: 'armed', broadcast: true })).toBe('arming'));

  it('returns "broadcasting" when streamMode=armed and broadcast=true', () =>
    expect(getBroadcastPhase({ streamMode: 'armed', broadcast: true })).toBe('broadcasting'));

  it('returns "armed" when streamMode=armed and broadcast=false', () =>
    expect(getBroadcastPhase({ streamMode: 'armed', broadcast: false })).toBe('armed'));

  it('returns "armed" when streamMode=armed and broadcast is absent', () =>
    expect(getBroadcastPhase({ streamMode: 'armed' })).toBe('armed'));

  it('returns "live" when streamMode=live and broadcast=true', () =>
    expect(getBroadcastPhase({ streamMode: 'live', broadcast: true })).toBe('live'));

  it('returns "playing" when streamMode=live and broadcast=false', () =>
    expect(getBroadcastPhase({ streamMode: 'live', broadcast: false })).toBe('playing'));

  it('returns "playing" when streamMode=live and broadcast is absent', () =>
    expect(getBroadcastPhase({ streamMode: 'live' })).toBe('playing'));

  it('returns "idle" for empty state', () =>
    expect(getBroadcastPhase({})).toBe('idle'));

  it('returns "idle" for streamMode=standby', () =>
    expect(getBroadcastPhase({ streamMode: 'standby' })).toBe('idle'));
});

// ---------------------------------------------------------------------------
// deriveUiMode(visualMode)
// ---------------------------------------------------------------------------
describe('deriveUiMode(visualMode)', () => {
  it('"live" → { uiMode: "takeover", uiSubMode: "obs" }', () =>
    expect(deriveUiMode('live')).toEqual({ uiMode: 'takeover', uiSubMode: 'obs' }));

  it('"visual-radio" → { uiMode: "radio", uiSubMode: "visual-radio" }', () =>
    expect(deriveUiMode('visual-radio')).toEqual({ uiMode: 'radio', uiSubMode: 'visual-radio' }));

  it('"video-playlist" → { uiMode: "radio", uiSubMode: "video-playlist" }', () =>
    expect(deriveUiMode('video-playlist')).toEqual({ uiMode: 'radio', uiSubMode: 'video-playlist' }));

  it('null → { uiMode: "radio", uiSubMode: "visual-radio" }', () =>
    expect(deriveUiMode(null)).toEqual({ uiMode: 'radio', uiSubMode: 'visual-radio' }));

  it('undefined → { uiMode: "radio", uiSubMode: "visual-radio" }', () =>
    expect(deriveUiMode(undefined)).toEqual({ uiMode: 'radio', uiSubMode: 'visual-radio' }));

  it('"" (empty string) → { uiMode: "radio", uiSubMode: "visual-radio" }', () =>
    expect(deriveUiMode('')).toEqual({ uiMode: 'radio', uiSubMode: 'visual-radio' }));
});

// ---------------------------------------------------------------------------
// uniquePlatformName(base, existingNames)
// ---------------------------------------------------------------------------
describe('uniquePlatformName(base, existingNames)', () => {
  it('returns base name when it is not taken', () =>
    expect(uniquePlatformName('YouTube', [])).toBe('YouTube'));

  it('returns "YouTube 2" when "YouTube" is taken', () =>
    expect(uniquePlatformName('YouTube', ['YouTube'])).toBe('YouTube 2'));

  it('returns "YouTube 3" when "YouTube" and "YouTube 2" are taken', () =>
    expect(uniquePlatformName('YouTube', ['YouTube', 'YouTube 2'])).toBe('YouTube 3'));

  it('returns base name unchanged when a different name is taken', () =>
    expect(uniquePlatformName('Kick', ['YouTube'])).toBe('Kick'));

  it('falls back to "base + Date.now()" when slots 2-99 are all exhausted', () => {
    // Build an array that contains 'Test' plus 'Test 2' through 'Test 99'
    const taken = ['Test'];
    for (let i = 2; i <= 99; i++) taken.push('Test ' + i);

    const before = Date.now();
    const result = uniquePlatformName('Test', taken);
    const after = Date.now();

    expect(result.startsWith('Test ')).toBe(true);
    const suffix = Number(result.slice('Test '.length));
    expect(suffix).toBeGreaterThanOrEqual(before);
    expect(suffix).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// escapeHtml(str)
// ---------------------------------------------------------------------------
describe('escapeHtml(str)', () => {
  it('escapes <script> tags', () =>
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));

  it('escapes double quotes', () =>
    expect(escapeHtml('"quotes"')).toBe('&quot;quotes&quot;'));

  it('escapes single quotes (apostrophes)', () =>
    expect(escapeHtml("it's")).toBe('it&#039;s'));

  it('escapes ampersand', () =>
    expect(escapeHtml('a & b')).toBe('a &amp; b'));

  it('escapes greater-than sign', () =>
    expect(escapeHtml('a > b')).toBe('a &gt; b'));

  it('escapes less-than sign', () =>
    expect(escapeHtml('a < b')).toBe('a &lt; b'));

  it('handles a string with all special chars together', () =>
    expect(escapeHtml('<div class="a" data-x=\'b\'>&</div>')).toBe(
      '&lt;div class=&quot;a&quot; data-x=&#039;b&#039;&gt;&amp;&lt;/div&gt;'));

  it('returns empty string unchanged', () =>
    expect(escapeHtml('')).toBe(''));

  it('returns a plain string unchanged', () =>
    expect(escapeHtml('hello world')).toBe('hello world'));

  it('passes through numbers unchanged (not a string)', () =>
    expect(escapeHtml(42)).toBe(42));

  it('passes through null unchanged', () =>
    expect(escapeHtml(null)).toBe(null));

  it('passes through undefined unchanged', () =>
    expect(escapeHtml(undefined)).toBe(undefined));
});

// ---------------------------------------------------------------------------
// browser-global attachment (window.FRUtils)
//
// This is the REAL pin: it executes utils.js the way the browser does (as a
// plain script, with `window` present but no CommonJS `module`), and asserts
// the public API gets attached to window.FRUtils. The ESM/CJS export path is
// already covered above; this proves the shipped browser entrypoint works.
// ---------------------------------------------------------------------------
describe('window.FRUtils (browser-global attachment)', () => {
  function loadInBrowserLikeContext() {
    const source = readFileSync(utilsPath, 'utf8');
    const fakeWindow = {};
    // Mimic a browser: `window` exists, `self` points at the global, and
    // neither `module` nor `exports` is defined (no CommonJS).
    const sandbox = {};
    sandbox.window = fakeWindow;
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'utils.js' });
    return fakeWindow;
  }

  it('attaches the API to window.FRUtils', () => {
    const win = loadInBrowserLikeContext();
    expect(win.FRUtils).toBeTypeOf('object');
  });

  it('exposes every public function on window.FRUtils', () => {
    const win = loadInBrowserLikeContext();
    for (const name of [
      'pad', 'fmtSize', 'cleanTrackName', 'escapeHtml', 'timeAgo',
      'formatTime', 'pttFormatTime', 'computeMixDur', 'getBroadcastPhase',
      'uniquePlatformName', 'deriveUiMode',
    ]) {
      expect(win.FRUtils[name]).toBeTypeOf('function');
    }
  });

  it('window.FRUtils.pad(3) === "03"', () => {
    const win = loadInBrowserLikeContext();
    expect(win.FRUtils.pad(3)).toBe('03');
  });

  it('window.FRUtils.fmtSize(1024) === "1.0 KB"', () => {
    const win = loadInBrowserLikeContext();
    expect(win.FRUtils.fmtSize(1024)).toBe('1.0 KB');
  });

  it('window.FRUtils.escapeHtml escapes <script>', () => {
    const win = loadInBrowserLikeContext();
    expect(win.FRUtils.escapeHtml('<b>')).toBe('&lt;b&gt;');
  });
});
