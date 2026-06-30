/**
 * genericModal.js — Generic modal UI for the STUDIO 23 / FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js generic-modal
 * refactor). Owns the shared #generic-modal element: openGenericModal sets the
 * title/body + stores the save callback and shows the modal; closeGenericModal
 * hides it and clears the callback; #generic-modal-save fires the stored
 * callback (it does NOT close — closing is the onSave's job); the backdrop click
 * closes only when the click target is the modal itself.
 *
 * Pure DOM — no fetch / WebSocket / timer / FRUtils, so init() takes no host
 * services (the `injected` arg is accepted for parity but unused). The two DOM
 * binds (#generic-modal-save.onclick + the backdrop onclick) and the DOM-ref
 * lookups relocate into init() so they run after the document exists, mirroring
 * visualprofiles.js bindCreateButton.
 *
 * window.closeGenericModal is assigned at factory load time (before init), so
 * the index.html inline onclick="closeGenericModal()" buttons keep working, and
 * the sibling modules' deferred `function(){ return window.closeGenericModal(); }`
 * wrappers resolve at call time exactly as before.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/genericModal.js"> (attaches its public API to
 * window.FRGenericModal) AND required by the vitest suite via module.exports
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
    window.FRGenericModal = api;
  }
})(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Module-owned state + DOM refs (moved out of app.js). The DOM refs stay null
  // until init() resolves them; genericModalCallback holds the current onSave.
  // -------------------------------------------------------------------------
  var genericModal = null;
  var genericModalSave = null;
  var genericModalCallback = null;

  function openGenericModal(title, bodyHtml, onSave) {
    document.getElementById('generic-modal-title').textContent = title;
    document.getElementById('generic-modal-body').innerHTML = bodyHtml;
    genericModalCallback = onSave;
    genericModal.style.display = 'flex';
  }

  function closeGenericModal() {
    genericModal.style.display = 'none';
    genericModalCallback = null;
  }

  // Keep window.closeGenericModal assigned at load time (before init) so the
  // index.html inline onclick buttons and the sibling modules' deferred
  // wrappers resolve it regardless of init order.
  if (typeof window !== 'undefined') {
    window.closeGenericModal = closeGenericModal;
  }

  /**
   * Resolve the modal DOM refs and bind the save / backdrop handlers (were
   * module-scope inline statements in app.js). Called from init() so the binds
   * run after the document exists. Pure DOM — no deps to store. Null-guarded for
   * a missing modal/save element.
   */
  function init(injected) {
    injected = injected || {};
    genericModal = document.getElementById('generic-modal');
    genericModalSave = document.getElementById('generic-modal-save');
    if (!genericModal || !genericModalSave) return;

    genericModalSave.onclick = function() {
      if (genericModalCallback) genericModalCallback();
    };

    genericModal.onclick = function(e) {
      if (e.target === genericModal) closeGenericModal();
    };
  }

  return {
    init: init,
    openGenericModal: openGenericModal,
    closeGenericModal: closeGenericModal,
    getGenericModalCallback: function () { return genericModalCallback; },
    setGenericModalCallback: function (v) { genericModalCallback = v; },
  };
});
