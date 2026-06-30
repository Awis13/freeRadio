/**
 * tests/dashboard/genericModalUI.test.js
 *
 * Characterization pins for the generic-modal UI cluster, currently living inside
 * the app.js IIFE closure (openGenericModal / window.closeGenericModal / the
 * #generic-modal-save + backdrop onclick wiring / the genericModalCallback state).
 * These tests pin the AS-IS observable contract; they were authored in C1 against
 * the code in app.js and will be re-pointed in C2 to the extracted
 * dashboard/public/genericModal.js (window.FRGenericModal) with assertions
 * unchanged, to prove behavioural equivalence.
 *
 * The cluster is pure DOM — no fetch / WebSocket / timer. So there is no backend
 * to control: tests boot the window, grab the hook, drive openGenericModal /
 * closeGenericModal + the REAL #generic-modal-save button, and assert the DOM
 * (#generic-modal display + title/body) plus the callback firing.
 *
 * Functions/state pinned (current app.js lines ~2072-2094):
 *   - openGenericModal(title, bodyHtml, onSave)  sets title/body, stores cb, display:flex
 *   - window.closeGenericModal()                 display:none, nulls the callback
 *   - #generic-modal-save.onclick                fires genericModalCallback (guarded), no close
 *   - #generic-modal backdrop onclick            closes only when e.target === the modal
 *   - getGenericModalCallback / setGenericModalCallback  state accessors
 *
 * AS-IS quirks pinned here (flagged for the C2 extraction):
 *   - save does NOT close the modal — closing is the onSave's responsibility.
 *   - save with a null callback is a silent no-op (guarded by `if (genericModalCallback)`).
 *   - close nulls the callback, so a subsequent save no-ops.
 *   - backdrop click on a child (e.target !== modal) does nothing.
 */

import { describe, it, expect } from 'vitest';
import { bootWindow } from './appBoot.js';

/**
 * Boot a fresh window and grab the generic-modal hook. No init/deps to inject —
 * the hook fns are the real closure fns. (C2 re-point: gm = win.FRGenericModal.)
 */
function boot() {
  const { win, doc } = bootWindow();
  const gm = win.FRGenericModal;
  return { win, doc, gm };
}

describe('generic-modal UI characterization (window.__appGenericModal)', () => {
  it('exposes openGenericModal/closeGenericModal + callback getter/setter', () => {
    const { gm } = boot();
    expect(gm).toBeTruthy();
    for (const fn of [
      'openGenericModal', 'closeGenericModal',
      'getGenericModalCallback', 'setGenericModalCallback',
    ]) {
      expect(typeof gm[fn]).toBe('function');
    }
  });

  // -------------------------------------------------------------------------
  // open
  // -------------------------------------------------------------------------
  describe('openGenericModal', () => {
    it('sets title (textContent), body (innerHTML), stores the callback, display:flex', () => {
      const { doc, gm } = boot();
      const cb = () => {};
      gm.openGenericModal('T', '<b>x</b>', cb);

      expect(doc.getElementById('generic-modal-title').textContent).toBe('T');
      expect(doc.getElementById('generic-modal-body').innerHTML).toBe('<b>x</b>');
      expect(doc.getElementById('generic-modal').style.display).toBe('flex');
      // the stored callback is exactly the one passed in
      expect(gm.getGenericModalCallback()).toBe(cb);
    });

    it('title is set as text (not HTML) — angle brackets are escaped on read-back', () => {
      const { doc, gm } = boot();
      gm.openGenericModal('<i>hi</i>', '', null);
      const titleEl = doc.getElementById('generic-modal-title');
      expect(titleEl.textContent).toBe('<i>hi</i>');
      // textContent assignment means no child <i> element was created
      expect(titleEl.querySelector('i')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // save button (real #generic-modal-save)
  // -------------------------------------------------------------------------
  describe('#generic-modal-save onclick', () => {
    it('fires the stored callback when set', () => {
      const { doc, gm } = boot();
      let fired = 0;
      gm.openGenericModal('T', '', () => { fired += 1; });

      doc.getElementById('generic-modal-save').onclick();
      expect(fired).toBe(1);
    });

    it('AS-IS: save does NOT close the modal (display stays flex)', () => {
      const { doc, gm } = boot();
      gm.openGenericModal('T', '', () => {});
      doc.getElementById('generic-modal-save').onclick();
      // closing is the onSave's responsibility; save itself leaves it open
      expect(doc.getElementById('generic-modal').style.display).toBe('flex');
    });

    it('AS-IS: save with a null callback is a silent no-op', () => {
      const { doc, gm } = boot();
      gm.setGenericModalCallback(null);
      // does not throw, does nothing observable
      expect(() => doc.getElementById('generic-modal-save').onclick()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------
  describe('closeGenericModal', () => {
    it('sets display:none and nulls the callback', () => {
      const { doc, gm } = boot();
      gm.openGenericModal('T', '<b>x</b>', () => {});
      gm.closeGenericModal();

      expect(doc.getElementById('generic-modal').style.display).toBe('none');
      expect(gm.getGenericModalCallback()).toBeNull();
    });

    it('after close, a subsequent save no-ops (callback was nulled)', () => {
      const { doc, gm } = boot();
      let fired = 0;
      gm.openGenericModal('T', '', () => { fired += 1; });
      gm.closeGenericModal();

      doc.getElementById('generic-modal-save').onclick();
      expect(fired).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // backdrop click
  // -------------------------------------------------------------------------
  describe('#generic-modal backdrop onclick', () => {
    it('clicking the backdrop itself (e.target === modal) closes', () => {
      const { doc, gm } = boot();
      gm.openGenericModal('T', '', () => {});
      const modal = doc.getElementById('generic-modal');
      modal.onclick({ target: modal });
      expect(modal.style.display).toBe('none');
    });

    it('clicking a child (e.target !== modal) does nothing', () => {
      const { doc, gm } = boot();
      gm.openGenericModal('T', '', () => {});
      const modal = doc.getElementById('generic-modal');
      const child = doc.getElementById('generic-modal-body');
      modal.onclick({ target: child });
      // still open
      expect(modal.style.display).toBe('flex');
    });
  });

  // -------------------------------------------------------------------------
  // state accessors
  // -------------------------------------------------------------------------
  describe('callback state accessors', () => {
    it('setGenericModalCallback then getGenericModalCallback round-trips the fn', () => {
      const { gm } = boot();
      const cb = () => {};
      gm.setGenericModalCallback(cb);
      expect(gm.getGenericModalCallback()).toBe(cb);
    });

    it('after open the getter returns the stored fn; after close it returns null', () => {
      const { gm } = boot();
      const cb = () => {};
      gm.openGenericModal('T', '', cb);
      expect(gm.getGenericModalCallback()).toBe(cb);
      gm.closeGenericModal();
      expect(gm.getGenericModalCallback()).toBeNull();
    });
  });
});
