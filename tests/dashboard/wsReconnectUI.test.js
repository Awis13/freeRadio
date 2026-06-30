/**
 * tests/dashboard/wsReconnectUI.test.js
 *
 * Characterization pins for the WebSocket reconnect BACKOFF, currently living
 * inside the app.js IIFE (app.js ~522-556). These tests pin the AS-IS observable
 * contract of the reconnect timer BEFORE any seam is re-sourced (this is C1 of
 * the core facade-foundation PR). They must stay green after the getter/setter
 * seam lands to prove zero behaviour change.
 *
 * The connection factory is connectWs() (app.js:526): it clears the pending
 * reconnect timer, closes/nulls any stale socket, then constructs a new
 * WebSocket and assigns onopen/onclose/onerror/onmessage as plain INSTANCE
 * properties. onclose (552) schedules the next reconnect via
 * `wsReconnectTimer = setTimeout(connectWs, wsReconnectDelay)` and then doubles
 * the delay: `wsReconnectDelay = Math.min(wsReconnectDelay * 2, 10000)` (555).
 * onopen (538) resets `wsReconnectDelay = 1000` (540).
 *
 * The three closure handles needed to drive this — connectWs, the live `ws`
 * instance, and the `wsReconnectDelay` closure var — are unreachable from a
 * test, so they are exposed via the guarded window.__appWs hook (app.js:3471,
 * inside the existing `if (window.__APP_TEST__)` block; inert in production).
 *
 * REALM CAVEAT (timers): app.js's setTimeout resolves to win.setTimeout (jsdom's
 * own timer realm), a DIFFERENT realm than node globalThis, so a bare
 * vi.useFakeTimers() would NOT intercept the reconnect timer. We use the
 * documented Recipe A (scheduleUI.test.js:407-410): override win.setTimeout with
 * a capturing spy that RECORDS the delay arg and returns a non-zero id WITHOUT
 * actually scheduling — otherwise firing onclose -> setTimeout(connectWs) would
 * recursively reconnect (a real reconnect storm) inside the test.
 *
 * The appBoot WebSocket stub (appBoot.js:63-68) discards the instances it
 * constructs and never auto-fires any handler, so we read the live boot-time
 * socket via the hook and call instance.onclose() / instance.onopen() directly
 * (they are ordinary properties on the object — no addEventListener dispatch).
 */

import { describe, it, expect } from 'vitest';
import { bootWindow } from './appBoot.js';

/**
 * Boot a fresh window and install a Recipe A capturing setTimeout spy. Returns
 * the live ws hook plus the array of captured reconnect delays.
 *
 * The spy records EVERY setTimeout delay and returns a fixed non-zero id; it
 * never actually schedules, so no real reconnect storm fires. (Boot itself opens
 * the socket synchronously before the spy is installed, so the captured delays
 * come purely from the onclose() calls the test drives.)
 */
function bootWithTimerSpy() {
  const { win } = bootWindow();
  const delays = [];
  win.setTimeout = (fn, ms) => { delays.push(ms); return 1; };
  const hook = win.__appWs;
  return { win, hook, delays };
}

describe('ws reconnect backoff characterization (window.__appWs)', () => {
  it('exposes connectWs + getWs + getWsReconnectDelay and a live boot socket', () => {
    const { hook } = bootWithTimerSpy();
    expect(hook).toBeTruthy();
    expect(typeof hook.connectWs).toBe('function');
    expect(typeof hook.getWs).toBe('function');
    expect(typeof hook.getWsReconnectDelay).toBe('function');
    // Boot opened exactly one socket; the live instance is reachable.
    expect(hook.getWs()).toBeTruthy();
    // Backoff starts at 1000 before any disconnect.
    expect(hook.getWsReconnectDelay()).toBe(1000);
  });

  it('doubles the reconnect delay on each onclose, capped at 10000', () => {
    const { hook, delays } = bootWithTimerSpy();
    const ws = hook.getWs();

    // Drive six disconnects. Each onclose schedules setTimeout(connectWs, delay)
    // with the CURRENT delay, then doubles the delay (cap 10000). The spy never
    // actually fires connectWs, so the same boot instance keeps handling close.
    for (let i = 0; i < 6; i++) {
      ws.onclose();
    }

    // The scheduled delays follow the doubling sequence, holding at the 10000 cap.
    expect(delays).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
  });

  it('advances getWsReconnectDelay() through the same backoff sequence', () => {
    const { hook } = bootWithTimerSpy();
    const ws = hook.getWs();

    const progression = [];
    for (let i = 0; i < 6; i++) {
      ws.onclose();
      progression.push(hook.getWsReconnectDelay());
    }

    // After each close the NEXT delay is the doubled value, capped at 10000.
    expect(progression).toEqual([2000, 4000, 8000, 10000, 10000, 10000]);
  });

  it('resets the backoff to 1000 on onopen, so the next onclose schedules 1000 again', () => {
    const { hook, delays } = bootWithTimerSpy();
    const ws = hook.getWs();

    // Walk the backoff up past the first step.
    ws.onclose(); // schedules 1000, delay -> 2000
    ws.onclose(); // schedules 2000, delay -> 4000
    ws.onclose(); // schedules 4000, delay -> 8000
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(hook.getWsReconnectDelay()).toBe(8000);

    // onopen resets the backoff to 1000 (reads FRAuth token + may ws.send against
    // the no-op stub — harmless; azServerFFT branch is false on boot).
    ws.onopen();
    expect(hook.getWsReconnectDelay()).toBe(1000);

    // The next disconnect schedules 1000 again, restarting the doubling.
    ws.onclose();
    expect(delays).toEqual([1000, 2000, 4000, 1000]);
    expect(hook.getWsReconnectDelay()).toBe(2000);
  });
});
