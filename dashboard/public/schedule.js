/**
 * schedule.js — Schedule UI for the STUDIO 23 / FreeRadio dashboard.
 *
 * Extracted verbatim from the app.js IIFE (C2 of the app-js schedule refactor).
 * Owns the schedule state (`scheduleData`, `DAYS`) and renders the weekly grid,
 * events list, and settings; wires the save/add-slot/add-event buttons; runs the
 * 30s current-slot poll; and drives the add-slot / add-event modal flows.
 *
 * Dependency injection: `init(deps)` receives the host services
 * (authFetch, log, showError, openGenericModal, closeGenericModal). pad and
 * escapeHtml are taken from window.FRUtils, and the music-playlist select feed
 * from window.FRPlaylists.loadForSelect (both loaded before this file). All
 * grid / list / settings DOM nodes are resolved via document.getElementById at
 * call time, exactly as the former app.js closure referenced them. init() also
 * binds the three schedule buttons (save-schedule-settings, add-weekly-slot-btn,
 * add-event-btn) and starts the current-slot poll; those handlers reach
 * openGenericModal/closeGenericModal through the injected deps, so they no longer
 * depend on function-hoisting like the old module-scope bindings did.
 *
 * Dual-target UMD module: loaded directly by the browser as a plain
 * <script src="/schedule.js"> (attaches its public API to window.FRSchedule)
 * AND required by the vitest suite via module.exports (CJS). It deliberately
 * uses NO top-level `export`/`import` so a browser <script> can load it without
 * a SyntaxError.
 */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.FRSchedule = api;
  }
})(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Module-owned state (moved out of app.js). scheduleData holds the weekly /
  // events / settings payload; DAYS is the canonical Mon..Sun column order.
  // -------------------------------------------------------------------------
  var scheduleData = { weekly: {}, events: {}, settings: {} };

  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // Injected host services (set by init).
  var deps = {
    authFetch: function () { return Promise.reject(new Error('FRSchedule not initialised')); },
    log: function () {},
    showError: function () {},
    openGenericModal: function () {},
    closeGenericModal: function () {},
  };

  // -------------------------------------------------------------------------
  // Helpers that resolve injected services at call time.
  // -------------------------------------------------------------------------
  function authFetch(url, opts) { return deps.authFetch(url, opts); }
  function log(msg) { return deps.log(msg); }
  function showError(msg) { return deps.showError(msg); }
  function openGenericModal(title, body, onSave) { return deps.openGenericModal(title, body, onSave); }
  function closeGenericModal() { return deps.closeGenericModal(); }

  function pad(x) {
    return window.FRUtils.pad(x);
  }

  function escapeHtml(s) {
    return window.FRUtils.escapeHtml(s);
  }

  // -------------------------------------------------------------------------
  // Schedule (behaviour-identical to the former app.js functions).
  // -------------------------------------------------------------------------
  function loadSchedule() {
    authFetch('/api/schedule')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        scheduleData = data;
        renderScheduleGrid();
        renderEventsList();
        renderScheduleSettings();
        loadScheduleCurrent();
      })
      .catch(function(e) { log('schedule: error: ' + e); });
  }

  function loadScheduleCurrent() {
    authFetch('/api/schedule/current')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        document.getElementById('sched-active-slot').textContent = data.label || data.slotId || '--';
        document.getElementById('sched-active-playlist').textContent = data.playlistName || '--';
        var vplEl = document.getElementById('sched-active-video-playlist');
        if (vplEl) vplEl.textContent = data.videoPlaylistName || '--';
        document.getElementById('sw-now').textContent = data.label || 'No active slot';
        document.getElementById('sw-next').textContent = data.nextLabel || '--';
      })
      .catch(function() {
        document.getElementById('sw-now').textContent = 'Schedule off';
      });
  }

  function renderScheduleGrid() {
    var grid = document.getElementById('schedule-grid');
    grid.innerHTML = '';

    var headerRow = document.createElement('div');
    headerRow.className = 'sched-header-row';
    headerRow.innerHTML = '<div class="sched-time-col"></div>';
    DAYS.forEach(function(d) {
      headerRow.innerHTML += '<div class="sched-day-col">' + d + '</div>';
    });
    grid.appendChild(headerRow);

    for (var h = 0; h < 24; h += 2) {
      var row = document.createElement('div');
      row.className = 'sched-row';

      var timeCell = document.createElement('div');
      timeCell.className = 'sched-time-col';
      timeCell.textContent = pad(h) + ':00';
      row.appendChild(timeCell);

      for (var d = 0; d < 7; d++) {
        var cell = document.createElement('div');
        cell.className = 'sched-cell';
        cell.dataset.day = d;
        cell.dataset.hour = h;

        var slots = Object.values(scheduleData.weekly || {}).filter(function(s) {
          if (s.day !== d) return false;
          var startH = parseInt(s.startTime.split(':')[0]);
          var endH = parseInt(s.endTime.split(':')[0]);
          if (endH <= startH) endH += 24;
          return h >= startH && h < endH || (h + 24 >= startH && h + 24 < endH);
        });

        if (slots.length > 0) {
          cell.className += ' sched-cell-filled';
          cell.textContent = slots[0].label || 'Slot';
          cell.title = slots[0].label + ' (' + slots[0].startTime + '-' + slots[0].endTime + ')';
          (function(slot) {
            cell.onclick = function() {
              if (confirm('Delete slot "' + (slot.label || slot.id) + '"?')) {
                deleteWeeklySlot(slot.id);
              }
            };
          })(slots[0]);
        }

        row.appendChild(cell);
      }
      grid.appendChild(row);
    }
  }

  function renderEventsList() {
    var container = document.getElementById('events-list');
    var events = Object.values(scheduleData.events || {});
    container.innerHTML = '';
    if (events.length === 0) {
      container.innerHTML = '<div class="empty-state">No events</div>';
      return;
    }
    events.sort(function(a, b) { return a.date < b.date ? -1 : 1; });
    events.forEach(function(ev) {
      var div = document.createElement('div');
      div.className = 'event-item';
      div.innerHTML =
        '<span class="event-date">' + escapeHtml(ev.date) + '</span>' +
        '<span class="event-time">' + escapeHtml(ev.startTime) + '-' + escapeHtml(ev.endTime) + '</span>' +
        '<span class="event-label">' + escapeHtml(ev.label || 'Event') + '</span>' +
        '<button class="file-del" title="Delete">x</button>';
      div.querySelector('button').onclick = function() {
        deleteEvent(ev.id);
      };
      container.appendChild(div);
    });
  }

  function renderScheduleSettings() {
    var s = scheduleData.settings || {};
    document.getElementById('schedule-timezone').value = s.timezone || 'Europe/Moscow';
    document.getElementById('schedule-enabled').checked = s.enabled !== false;
    loadPlaylistsForSelect();
    setTimeout(function() {
      var sel = document.getElementById('schedule-default-playlist');
      sel.value = s.defaultPlaylistId || '';
    }, 500);
  }

  function loadPlaylistsForSelect() {
    // Music playlist selects live in playlists.js (window.FRPlaylists).
    window.FRPlaylists.loadForSelect();

    // Load video playlists for video-playlist-select dropdowns
    authFetch('/api/video-playlists')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var selects = document.querySelectorAll('.video-playlist-select');
        selects.forEach(function(sel) {
          var current = sel.value;
          sel.innerHTML = '<option value="">-- None --</option>';
          data.forEach(function(pl) {
            sel.innerHTML += '<option value="' + escapeHtml(pl.id) + '">' + escapeHtml(pl.name) + ' (' + escapeHtml('' + (pl.trackCount || 0)) + ' videos)</option>';
          });
          sel.value = current;
        });
      })
      .catch(function() {});
  }

  function deleteWeeklySlot(id) {
    authFetch('/api/schedule/weekly/' + id, { method: 'DELETE' })
      .then(function() { loadSchedule(); })
      .catch(function(e) { showError('Delete slot failed: ' + e); });
  }

  function deleteEvent(id) {
    if (!confirm('Delete this event?')) return;
    authFetch('/api/schedule/events/' + id, { method: 'DELETE' })
      .then(function() { loadSchedule(); })
      .catch(function(e) { showError('Delete event failed: ' + e); });
  }

  /**
   * Bind the save-schedule-settings onclick (was a module-scope inline statement
   * in app.js). Called from init() — runs AFTER deps are injected. Null-guarded
   * for a missing element.
   */
  function bindSettingsSaveButton() {
    var el = document.getElementById('save-schedule-settings');
    if (!el) return;
    el.onclick = function() {
      var settings = {
        timezone: document.getElementById('schedule-timezone').value,
        defaultPlaylistId: document.getElementById('schedule-default-playlist').value || null,
        enabled: document.getElementById('schedule-enabled').checked
      };
      authFetch('/api/schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: settings })
      })
        .then(function() { log('schedule: settings saved'); })
        .catch(function(e) { showError('Save schedule settings failed: ' + e); });
    };
  }

  /**
   * Bind the add-weekly-slot-btn onclick (was a module-scope inline statement in
   * app.js). Called from init() — runs AFTER deps are injected, so the modal
   * handler resolves openGenericModal/closeGenericModal via deps. Null-guarded.
   */
  function bindAddWeeklySlotButton() {
    var el = document.getElementById('add-weekly-slot-btn');
    if (!el) return;
    el.onclick = function() {
      openGenericModal('Add Weekly Slot',
        '<div class="form-group"><label>Day</label><select id="slot-day">' +
        DAYS.map(function(d, i) { return '<option value="' + i + '">' + d + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="form-group"><label>Start Time</label><input type="time" id="slot-start" value="22:00"></div>' +
        '<div class="form-group"><label>End Time</label><input type="time" id="slot-end" value="06:00"></div>' +
        '<div class="form-group"><label>Playlist</label><select id="slot-playlist" class="playlist-select"><option value="">-- None --</option></select></div>' +
        '<div class="form-group"><label>Video Playlist</label><select id="slot-video-playlist" class="video-playlist-select"><option value="">-- None --</option></select></div>' +
        '<div class="form-group"><label>Label</label><input type="text" id="slot-label" placeholder="Friday Night"></div>',
        function() {
          var slot = {
            day: parseInt(document.getElementById('slot-day').value),
            startTime: document.getElementById('slot-start').value,
            endTime: document.getElementById('slot-end').value,
            playlistId: document.getElementById('slot-playlist').value || null,
            videoPlaylistId: document.getElementById('slot-video-playlist').value || null,
            label: document.getElementById('slot-label').value.trim()
          };
          authFetch('/api/schedule/weekly', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(slot)
          })
            .then(function() { closeGenericModal(); loadSchedule(); })
            .catch(function(e) { showError('Add slot failed: ' + e); });
        }
      );
      loadPlaylistsForSelect();
    };
  }

  /**
   * Bind the add-event-btn onclick (was a module-scope inline statement in
   * app.js). Called from init() — runs AFTER deps are injected, so the modal
   * handler resolves openGenericModal/closeGenericModal via deps. Null-guarded.
   */
  function bindAddEventButton() {
    var el = document.getElementById('add-event-btn');
    if (!el) return;
    el.onclick = function() {
      openGenericModal('Add Event',
        '<div class="form-group"><label>Date</label><input type="date" id="event-date"></div>' +
        '<div class="form-group"><label>Start Time</label><input type="time" id="event-start" value="20:00"></div>' +
        '<div class="form-group"><label>End Time</label><input type="time" id="event-end" value="23:00"></div>' +
        '<div class="form-group"><label>Playlist</label><select id="event-playlist" class="playlist-select"><option value="">-- None --</option></select></div>' +
        '<div class="form-group"><label>Video Playlist</label><select id="event-video-playlist" class="video-playlist-select"><option value="">-- None --</option></select></div>' +
        '<div class="form-group"><label>Label</label><input type="text" id="event-label" placeholder="Guest DJ"></div>',
        function() {
          var ev = {
            date: document.getElementById('event-date').value,
            startTime: document.getElementById('event-start').value,
            endTime: document.getElementById('event-end').value,
            playlistId: document.getElementById('event-playlist').value || null,
            videoPlaylistId: document.getElementById('event-video-playlist').value || null,
            label: document.getElementById('event-label').value.trim()
          };
          authFetch('/api/schedule/events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ev)
          })
            .then(function() { closeGenericModal(); loadSchedule(); })
            .catch(function(e) { showError('Add event failed: ' + e); });
        }
      );
      loadPlaylistsForSelect();
    };
  }

  /**
   * Start the 30s current-slot poll (was a module-scope setInterval in app.js).
   * Called from init().
   */
  function startCurrentSlotPolling() {
    setInterval(loadScheduleCurrent, 30000);
  }

  /**
   * Store injected dependencies, then bind the three schedule buttons and start
   * the current-slot poll. Safe to call more than once (the vitest harness
   * re-inits per test with its own deps).
   */
  function init(injected) {
    injected = injected || {};
    window.FRUtils.mergeDeps(deps, injected, 'FRSchedule');
    bindSettingsSaveButton();
    bindAddWeeklySlotButton();
    bindAddEventButton();
    startCurrentSlotPolling();
  }

  return {
    init: init,
    loadSchedule: loadSchedule,
    loadPlaylistsForSelect: loadPlaylistsForSelect,

    // Surface used by the characterization tests to drive the module.
    loadScheduleCurrent: loadScheduleCurrent,
    renderScheduleGrid: renderScheduleGrid,
    renderEventsList: renderEventsList,
    renderScheduleSettings: renderScheduleSettings,
    deleteWeeklySlot: deleteWeeklySlot,
    deleteEvent: deleteEvent,
    getScheduleData: function () { return scheduleData; },
    setScheduleData: function (d) { scheduleData = d; },
    getDAYS: function () { return DAYS; },
  };
});
