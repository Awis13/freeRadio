/**
 * tests/dashboard/audioFacadeUI.test.js
 *
 * Characterization pins for the WebAudio graph getter FACADE, currently living
 * inside the app.js IIFE (app.js ~2541-2560). These pin the AS-IS observable
 * contract of the five read-only graph getters BEFORE any consumer is
 * re-sourced (this is C1 of the core facade-foundation PR, mirroring the
 * wsReconnectUI getWs/setWs pins). They must stay green after the consumers are
 * rerouted through these getters, to prove zero behaviour change.
 *
 * The five closure handles — azAudioCtx, azGainNode, azMain, azL, azR — are
 * unreachable from a test, so they are exposed via the guarded
 * window.__appAudio hook (app.js inside the existing `if (window.__APP_TEST__)`
 * block, after __appWs; inert in production).
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

import { describe, it, expect } from 'vitest';
import { bootWindow } from './appBoot.js';

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
