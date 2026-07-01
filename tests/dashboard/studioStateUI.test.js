/**
 * tests/dashboard/studioStateUI.test.js
 *
 * Characterization pins for the studio/interaction state getter FACADE, currently
 * living inside the app.js IIFE (app.js ~38 and ~250). These pin the AS-IS
 * observable contract of the two read-only getters BEFORE any consumer is
 * re-sourced (this is C1 of the core facade-foundation PR, mirroring
 * audioFacadeUI.test.js for the WebAudio graph getters). They must stay green
 * after the consumers are rerouted through these getters, to prove zero behaviour
 * change.
 *
 * The two closure handles — studioPlayer and userInteracted — are unreachable
 * from a test, so they are exposed via the guarded window.__appStudio hook
 * (app.js inside the existing `if (window.__APP_TEST__)` block, after __appAudio;
 * inert in production).
 *
 * IDENTITY proof (studioPlayer): index.html declares `<video id="studio-player">`,
 * so document.getElementById('studio-player') returns a live HTMLVideoElement on
 * boot — NOT null. getStudioPlayer() must be === that element.
 *
 * BOOT-VALUE proof (userInteracted): the var is initialised to `false` and only
 * set to true inside event handlers that are never triggered during a bare
 * bootWindow(). getUserInteracted() must return false on boot.
 */

import { describe, it, expect } from 'vitest';
import { bootWindow } from './appBoot.js';

describe('studio/interaction state facade characterization (window.__appStudio)', () => {
  it('exposes the two read-only getters as functions', () => {
    const { win } = bootWindow();
    const hook = win.__appStudio;
    expect(hook).toBeTruthy();
    expect(typeof hook.getStudioPlayer).toBe('function');
    expect(typeof hook.getUserInteracted).toBe('function');
  });

  it('getStudioPlayer returns the live #studio-player element (identity check)', () => {
    const { win } = bootWindow();
    const hook = win.__appStudio;
    // index.html has <video id="studio-player"> so getElementById returns the real element.
    const el = win.document.getElementById('studio-player');
    expect(el).not.toBe(null);
    expect(hook.getStudioPlayer()).toBe(el);
  });

  it('getUserInteracted returns false on boot — no user gesture has fired yet', () => {
    const { win } = bootWindow();
    const hook = win.__appStudio;
    expect(hook.getUserInteracted()).toBe(false);
  });
});
