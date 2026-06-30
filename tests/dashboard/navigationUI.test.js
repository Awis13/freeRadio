/**
 * tests/dashboard/navigationUI.test.js
 *
 * Characterization pins for the navigation cluster of the dashboard app.js IIFE:
 * top-level tab switching, collapsible panels, and the Space keyboard shortcut.
 * Authored in C1 against the UNMODIFIED app.js (cluster at app.js:189-221 plus the
 * state var `var activeTab = 'studio'` at app.js:76). In C2 these same pins are
 * re-pointed from window.__appNavigation to window.FRNavigation with assertions
 * UNCHANGED, proving the extraction is behaviour-preserving.
 *
 * The three handlers are bound to REAL DOM at boot, so the pins drive them via
 * real interactions:
 *   - tab switch       -> a real `.tab-btn` click (one per data-tab)
 *   - collapsible panel -> a real `.panel-toggle` click (and a click inside the
 *                          `.dbg-actions` sub-region to exercise the early-return)
 *   - Space shortcut    -> a dispatched document `keydown`
 * The only closure-private value the pins need is `activeTab`, read/written via
 * the window.__appNavigation getActiveTab/setActiveTab accessors.
 *
 * The cluster issues NO fetch of its own; the per-tab lazy loaders are all
 * window.FRX.* module methods (FRPlaylists / FRSchedule / FRVisualProfiles /
 * FRVideoPlaylists / FROverlays / FRAnalytics). The pins SPY those methods
 * (replace each with a recording fn before the click) rather than routing fetch.
 * Because the handler reads the loader off the global object property at call
 * time, the same spy works in both C1 (app.js-resident handler) and C2
 * (FRNavigation module) — the spy assertions stay green across the re-point.
 *
 * AS-IS contract pinned here:
 *   - clicking a `.tab-btn` sets exactly one active `.tab-btn` + exactly one
 *     active `.tab-content` (#tab-<name>) and updates activeTab;
 *   - each tab fires ONLY its own loader set (studio: none; schedule: loadSchedule
 *     + loadPlaylistsForSelect; playlists: loadPlaylists; visuals: loadVisualProfiles
 *     + loadVideoPlaylists + loadOverlays + loadOverlayAssets; analytics:
 *     loadAnalytics);
 *   - a `.panel-toggle` click flips `collapsed` on its `.panel-collapsible`;
 *   - a click inside `.dbg-actions` does NOT toggle (early return);
 *   - Space with activeTab 'studio' clicks #skip-btn and preventDefault()s;
 *   - Space with a non-studio activeTab does NOT click skip;
 *   - keydown whose target is INPUT/TEXTAREA/SELECT does NOT click skip.
 */

import { describe, it, expect } from 'vitest';
import { bootWindow } from './appBoot.js';

/** Boot a fresh window and grab the navigation hook. */
function boot() {
  const { win, doc } = bootWindow();
  const nav = win.FRNavigation;
  return { win, doc, nav };
}

/**
 * Replace every per-tab loader (all window.FRX.* methods) with a recording fn and
 * return a counts map keyed by the bare method name. Works in C1 and C2 alike
 * because the tab handler reads `FRX.loader` as a property at call time.
 */
function spyLoaders(win) {
  const calls = {};
  function spy(obj, name) {
    calls[name] = 0;
    win[obj][name] = function () { calls[name]++; };
  }
  spy('FRPlaylists', 'loadPlaylists');
  spy('FRSchedule', 'loadSchedule');
  spy('FRSchedule', 'loadPlaylistsForSelect');
  spy('FRVisualProfiles', 'loadVisualProfiles');
  spy('FRVideoPlaylists', 'loadVideoPlaylists');
  spy('FROverlays', 'loadOverlays');
  spy('FROverlays', 'loadOverlayAssets');
  spy('FRAnalytics', 'loadAnalytics');
  return calls;
}

/** Sum of all loader call counts — used to assert "no other loader fired". */
function totalCalls(calls) {
  return Object.keys(calls).reduce((n, k) => n + calls[k], 0);
}

describe('navigation UI characterization (window.FRNavigation)', () => {
  it('exposes the activeTab get/set accessors and defaults to "studio"', () => {
    const { nav } = boot();
    expect(nav).toBeTruthy();
    expect(typeof nav.getActiveTab).toBe('function');
    expect(typeof nav.setActiveTab).toBe('function');
    expect(nav.getActiveTab()).toBe('studio');
  });

  // -------------------------------------------------------------------------
  // Tab switching — driven via real .tab-btn clicks
  // -------------------------------------------------------------------------
  describe('tab switching', () => {
    // [data-tab, active pane id, set of loader names that MUST fire]
    const cases = [
      ['studio', 'tab-studio', []],
      ['schedule', 'tab-schedule', ['loadSchedule', 'loadPlaylistsForSelect']],
      ['playlists', 'tab-playlists', ['loadPlaylists']],
      ['visuals', 'tab-visuals', ['loadVisualProfiles', 'loadVideoPlaylists', 'loadOverlays', 'loadOverlayAssets']],
      ['analytics', 'tab-analytics', ['loadAnalytics']],
    ];

    for (const [tab, paneId, expectedLoaders] of cases) {
      it(`clicking [data-tab="${tab}"] activates exactly one btn + #${paneId} and fires only ${expectedLoaders.length} loader(s)`, () => {
        const { win, doc } = boot();
        const calls = spyLoaders(win);

        doc.querySelector(`.tab-btn[data-tab="${tab}"]`).click();

        // exactly one active tab button, and it is the clicked one
        const activeBtns = [...doc.querySelectorAll('.tab-btn.active')];
        expect(activeBtns.length).toBe(1);
        expect(activeBtns[0].dataset.tab).toBe(tab);

        // exactly one active tab-content, and it is #tab-<name>
        const activePanes = [...doc.querySelectorAll('.tab-content.active')];
        expect(activePanes.length).toBe(1);
        expect(activePanes[0].id).toBe(paneId);

        // activeTab updated
        expect(win.FRNavigation.getActiveTab()).toBe(tab);

        // ONLY the expected loaders fired, each exactly once
        for (const name of expectedLoaders) {
          expect(calls[name]).toBe(1);
        }
        expect(totalCalls(calls)).toBe(expectedLoaders.length);
      });
    }

    it('switching away clears the previously-active tab (single active pane)', () => {
      const { win, doc } = boot();
      spyLoaders(win);
      doc.querySelector('.tab-btn[data-tab="playlists"]').click();
      doc.querySelector('.tab-btn[data-tab="analytics"]').click();

      const activeBtns = [...doc.querySelectorAll('.tab-btn.active')];
      expect(activeBtns.length).toBe(1);
      expect(activeBtns[0].dataset.tab).toBe('analytics');
      const activePanes = [...doc.querySelectorAll('.tab-content.active')];
      expect(activePanes.length).toBe(1);
      expect(activePanes[0].id).toBe('tab-analytics');
    });
  });

  // -------------------------------------------------------------------------
  // Collapsible panels — driven via real .panel-toggle clicks
  // -------------------------------------------------------------------------
  describe('collapsible panels', () => {
    it('clicking a .panel-toggle flips "collapsed" on its .panel-collapsible', () => {
      const { win, doc } = boot();
      // pick a toggle that has NO .dbg-actions sub-region (clean toggle path)
      const toggle = [...doc.querySelectorAll('.panel-toggle')]
        .find((t) => !t.querySelector('.dbg-actions'));
      expect(toggle).toBeTruthy();
      const panel = toggle.closest('.panel-collapsible');
      const before = panel.classList.contains('collapsed');

      toggle.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      expect(panel.classList.contains('collapsed')).toBe(!before);

      // a second click flips it back
      toggle.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      expect(panel.classList.contains('collapsed')).toBe(before);
    });

    it('AS-IS: a click inside .dbg-actions early-returns and does NOT toggle', () => {
      const { win, doc } = boot();
      const dbgBtn = doc.getElementById('dbg-clear');
      const panel = dbgBtn.closest('.panel-collapsible');
      const before = panel.classList.contains('collapsed');

      dbgBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      expect(panel.classList.contains('collapsed')).toBe(before);
    });
  });

  // -------------------------------------------------------------------------
  // Keyboard shortcut — Space -> skip, gated by activeTab + target tag
  // -------------------------------------------------------------------------
  describe('Space keyboard shortcut', () => {
    it('Space with default activeTab "studio" clicks #skip-btn and preventDefault()s', () => {
      const { win, doc } = boot();
      const skip = doc.getElementById('skip-btn');
      let clicked = 0;
      skip.click = () => { clicked++; };

      const ev = new win.KeyboardEvent('keydown', { code: 'Space', cancelable: true });
      doc.dispatchEvent(ev);

      expect(clicked).toBe(1);
      expect(ev.defaultPrevented).toBe(true);
    });

    it('Space with a non-studio activeTab does NOT click skip', () => {
      const { win, doc, nav } = boot();
      nav.setActiveTab('schedule');
      const skip = doc.getElementById('skip-btn');
      let clicked = 0;
      skip.click = () => { clicked++; };

      const ev = new win.KeyboardEvent('keydown', { code: 'Space', cancelable: true });
      doc.dispatchEvent(ev);

      expect(clicked).toBe(0);
      expect(ev.defaultPrevented).toBe(false);
    });

    it('Space whose target is an INPUT early-returns (no skip click)', () => {
      const { win, doc } = boot();
      // default activeTab is 'studio' so only the INPUT guard can suppress it
      expect(doc.querySelector('input')).toBeTruthy();
      const input = doc.querySelector('input');
      const skip = doc.getElementById('skip-btn');
      let clicked = 0;
      skip.click = () => { clicked++; };

      const ev = new win.KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
      input.dispatchEvent(ev);

      expect(clicked).toBe(0);
    });

    it('a non-Space key does NOT click skip', () => {
      const { win, doc } = boot();
      const skip = doc.getElementById('skip-btn');
      let clicked = 0;
      skip.click = () => { clicked++; };

      doc.dispatchEvent(new win.KeyboardEvent('keydown', { code: 'KeyA', cancelable: true }));
      expect(clicked).toBe(0);
    });
  });
});
