/**
 * tests/dashboard/notifyUI.test.js
 *
 * Characterization pins for the logging + error-toast ("notify") cluster, which
 * currently lives inline in the app.js IIFE and is slated for extraction into
 * dashboard/public/notify.js (window.FRNotify). These tests pin the AS-IS
 * observable contract of two co-located DOM fan-out primitives:
 *
 *   - log(msg)        in-page ring-buffer logger -> #log debug console
 *   - showError(msg)  transient #error-banner toast (auto-hide after 5000ms)
 *   plus the #dbg-clear / #dbg-pause control buttons.
 *
 * They were authored in C1 against the code in app.js (driven via the
 * window.__appNotify hook + the REAL #dbg-clear / #dbg-pause buttons) and will
 * be re-pointed in C2 to window.FRNotify, with assertions UNCHANGED to prove
 * behavioural equivalence.
 *
 * This cluster is PURE DOM (zero fetch): the only backend control needed is
 * vi fake timers for showError's 5000ms auto-hide setTimeout.
 *
 * AS-IS facts pinned (app.js:195-221):
 *   - ring-buffer cap is exactly 500 (logs.length > 500 -> logs.shift()).
 *   - each entry is prefixed '[HH:MM:SS.mmm] ' (ISO time, slice(11,23)).
 *   - #log textContent === logs.join('\n') ONLY when not paused.
 *   - paused: log() keeps pushing into logs[] but does NOT touch #log textContent.
 *   - #dbg-pause toggles text 'Pause' <-> 'Resume'; resume re-renders #log.
 *   - #dbg-clear empties logs AND blanks #log textContent.
 *   - showError sets #error-banner textContent + .visible class, logs an
 *     'ERROR: <msg>' line, and removes .visible after exactly 5000ms (text stays).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { bootWindow } from './appBoot.js';

/**
 * Boot a fresh window and grab the notify hook. No init/deps to inject — the
 * hook fns are the real closure fns (pure DOM); tests drive via the hook plus
 * the REAL #dbg-clear / #dbg-pause buttons.
 */
function boot() {
  const { win, doc } = bootWindow();
  const n = win.FRNotify;
  return { win, doc, n };
}

afterEach(() => {
  // showError pins flip on fake timers; always restore so other files are real.
  vi.useRealTimers();
});

describe('notify UI characterization (window.FRNotify)', () => {
  it('exposes log/showError + logs & logsPaused getter/setter', () => {
    const { n } = boot();
    expect(n).toBeTruthy();
    for (const fn of ['log', 'showError', 'getLogs', 'setLogs', 'getLogsPaused', 'setLogsPaused']) {
      expect(typeof n[fn]).toBe('function');
    }
  });

  // -------------------------------------------------------------------------
  // log() — ring buffer + #log rendering
  // -------------------------------------------------------------------------
  describe('log()', () => {
    it('pushes a "[HH:MM:SS.mmm] msg" entry and renders #log textContent', () => {
      const { doc, n } = boot();
      n.setLogs([]); // clear any boot-time log noise

      n.log('hello world');

      const logs = n.getLogs();
      expect(logs.length).toBe(1);
      // entry prefix: '[HH:MM:SS.mmm] ' then the message
      expect(logs[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] hello world$/);
      // #log mirrors the buffer joined with newlines
      expect(doc.getElementById('log').textContent).toBe(logs.join('\n'));
    });

    it('joins multiple entries with "\\n" into #log when not paused', () => {
      const { doc, n } = boot();
      n.setLogs([]);
      n.log('one');
      n.log('two');
      const logs = n.getLogs();
      expect(logs.length).toBe(2);
      expect(doc.getElementById('log').textContent).toBe(logs.join('\n'));
      expect(doc.getElementById('log').textContent.split('\n').length).toBe(2);
    });

    it('AS-IS: ring buffer caps at 500 entries, FIFO-dropping the oldest', () => {
      const { n } = boot();
      n.setLogs([]);
      for (let i = 0; i < 600; i++) n.log('m' + i);

      const logs = n.getLogs();
      // cap is exactly 500 (logs.length > 500 -> shift)
      expect(logs.length).toBe(500);
      // oldest (m0..m99) shifted out; the window is m100..m599
      expect(logs[0]).toContain('m100');
      expect(logs[logs.length - 1]).toContain('m599');
    });

    it('AS-IS: 501st push trims back to exactly 500', () => {
      const { n } = boot();
      n.setLogs([]);
      for (let i = 0; i < 500; i++) n.log('x' + i);
      expect(n.getLogs().length).toBe(500);
      n.log('overflow');
      expect(n.getLogs().length).toBe(500);
      expect(n.getLogs()[n.getLogs().length - 1]).toContain('overflow');
      // first entry is now x1 (x0 dropped)
      expect(n.getLogs()[0]).toContain('x1');
    });
  });

  // -------------------------------------------------------------------------
  // #dbg-pause — pause buffering
  // -------------------------------------------------------------------------
  describe('#dbg-pause', () => {
    it('1st click -> "Resume" + logsPaused=true; subsequent log() buffers but does NOT touch #log', () => {
      const { doc, n } = boot();
      n.setLogs([]);
      n.log('before-pause');
      const logEl = doc.getElementById('log');
      const rendered = logEl.textContent;

      doc.getElementById('dbg-pause').onclick();
      expect(doc.getElementById('dbg-pause').textContent).toBe('Resume');
      expect(n.getLogsPaused()).toBe(true);

      n.log('while-paused');
      // buffer grows...
      expect(n.getLogs().length).toBe(2);
      expect(n.getLogs()[1]).toContain('while-paused');
      // ...but #log textContent is frozen at the pre-pause render
      expect(logEl.textContent).toBe(rendered);
      expect(logEl.textContent).not.toContain('while-paused');
    });

    it('2nd click -> "Pause" + logsPaused=false; #log re-rendered to full buffer', () => {
      const { doc, n } = boot();
      n.setLogs([]);
      const pauseBtn = doc.getElementById('dbg-pause');

      pauseBtn.onclick(); // pause
      n.log('buffered-1');
      n.log('buffered-2');
      const logEl = doc.getElementById('log');
      expect(logEl.textContent).not.toContain('buffered-2');

      pauseBtn.onclick(); // resume
      expect(pauseBtn.textContent).toBe('Pause');
      expect(n.getLogsPaused()).toBe(false);
      // resume re-renders the whole buffer
      expect(logEl.textContent).toBe(n.getLogs().join('\n'));
      expect(logEl.textContent).toContain('buffered-1');
      expect(logEl.textContent).toContain('buffered-2');
    });
  });

  // -------------------------------------------------------------------------
  // #dbg-clear — wipe buffer + console
  // -------------------------------------------------------------------------
  describe('#dbg-clear', () => {
    it('empties the logs buffer AND blanks #log textContent', () => {
      const { doc, n } = boot();
      n.setLogs([]);
      n.log('a');
      n.log('b');
      expect(n.getLogs().length).toBe(2);

      doc.getElementById('dbg-clear').onclick();

      expect(n.getLogs().length).toBe(0);
      expect(doc.getElementById('log').textContent).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // showError() — transient #error-banner toast
  // -------------------------------------------------------------------------
  describe('showError()', () => {
    it('sets #error-banner text + .visible, and appends an "ERROR: <msg>" log line', () => {
      vi.useFakeTimers();
      const { doc, n } = boot();
      n.setLogs([]);

      n.showError('disk full');

      const banner = doc.getElementById('error-banner');
      expect(banner.textContent).toBe('disk full');
      expect(banner.classList.contains('visible')).toBe(true);
      // showError logs 'ERROR: <msg>' internally (side-effect on the ring buffer)
      const logs = n.getLogs();
      expect(logs.length).toBe(1);
      expect(logs[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] ERROR: disk full$/);
    });

    it('AS-IS: auto-hides after exactly 5000ms (removes .visible, text stays)', () => {
      vi.useFakeTimers();
      const { doc, n } = boot();
      n.showError('boom');
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);

      // just before the timeout: still visible
      vi.advanceTimersByTime(4999);
      expect(banner.classList.contains('visible')).toBe(true);

      // at 5000ms: hidden, but textContent is left intact
      vi.advanceTimersByTime(1);
      expect(banner.classList.contains('visible')).toBe(false);
      expect(banner.textContent).toBe('boom');
    });
  });
});
