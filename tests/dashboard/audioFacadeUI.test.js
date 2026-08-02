/**
 * tests/dashboard/audioFacadeUI.test.js
 *
 * Characterization pins for the WebAudio graph getter FACADE. The graph itself
 * now lives in dashboard/public/analyzer.js, with mixer.js as its other
 * consumer; these pins were authored while it was inline in the app.js IIFE and
 * have stayed green across the move, which is what proves the facade changed no
 * behaviour.
 *
 * The five graph handles — azAudioCtx, azGainNode, azMain, azL, azR — are
 * unreachable from a test, so they are read through the guarded
 * window.__appAudio hook, which app.js still publishes inside its
 * `if (window.__APP_TEST__)` block; inert in production.
 *
 * IDENTITY-to-null equivalence proof: on boot in jsdom azInit (the sole writer
 * of azAudioCtx/azGainNode, which also feeds azInitAnalysers) is NEVER called —
 * every call site (app.js 237/1483/1586/2107/3397) is gated behind a
 * user-gesture/event handler, and azInit early-returns on Safari. So all five
 * vars stay null after a bare bootWindow(). Each getter therefore returns the
 * exact live closure var, which is null in-harness. Combined with the full
 * suite staying green (the rerouted truthiness guards short-circuit identically
 * when null), this proves the facade introduces zero behaviour change. The
 * appBoot AudioContext stub (appBoot.js:79-85) is minimal and azInit is never
 * triggered, so null is the only observable in-harness state — we do NOT force
 * az* non-null. (wsReconnectUI.test.js:111 already notes "azServerFFT branch is
 * false on boot", consistent with azInit not running.)
 */

import { describe, it, expect, afterAll } from 'vitest';
import { bootWindow, closeAllWindows } from './appBoot.js';

// Close every jsdom window this file booted (rationale in appBoot.js).
afterAll(closeAllWindows);

describe('analyzer WebAudio facade characterization (window.__appAudio)', () => {
  it('exposes the five read-only graph getters as functions', () => {
    const { win } = bootWindow();
    const hook = win.__appAudio;
    expect(hook).toBeTruthy();
    expect(typeof hook.getAudioCtx).toBe('function');
    expect(typeof hook.getGainNode).toBe('function');
    expect(typeof hook.getMainAnalyser).toBe('function');
    expect(typeof hook.getAzL).toBe('function');
    expect(typeof hook.getAzR).toBe('function');
  });

  it('each getter returns the live var — null on boot, since azInit never runs in jsdom', () => {
    const { win } = bootWindow();
    const hook = win.__appAudio;
    // azInit is gated behind user gestures and never auto-runs on boot, so the
    // whole graph stays null. getX() === the exact live closure var (null here).
    expect(hook.getAudioCtx()).toBe(null);
    expect(hook.getGainNode()).toBe(null);
    expect(hook.getMainAnalyser()).toBe(null);
    expect(hook.getAzL()).toBe(null);
    expect(hook.getAzR()).toBe(null);
  });
});
