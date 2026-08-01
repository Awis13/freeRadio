/**
 * tests/dashboard/scheduleUI.test.js
 *
 * Characterization pins for the SCHEDULE UI domain, currently living inside the
 * app.js IIFE (app.js ~1264-1498). These tests pin the AS-IS observable contract
 * of the schedule functions BEFORE any code moves (this is C1 of a 2-commit
 * extraction PR). C2 will extract the domain into dashboard/public/schedule.js
 * (window.FRSchedule); these pins must stay green there to prove equivalence.
 *
 * The domain has NO init/dependency-injection surface: window.__appSchedule holds
 * the REAL closure fns, which use the REAL deps (authFetch -> win.fetch, log,
 * showError, escapeHtml/pad from FRUtils, FRPlaylists.loadForSelect,
 * openGenericModal/closeGenericModal). The only backend control is replacing the
 * boot's never-resolving win.fetch with a recording makeFetchStub AFTER boot,
 * then calling the hook fns / clicking the real DOM buttons and asserting DOM
 * (in `doc`) + recorded fetches (stub.calls).
 *
 * Functions pinned (current app.js lines ~1267-1498):
 *   - loadSchedule()            GET /api/schedule -> scheduleData + 4-render fan-out
 *   - loadScheduleCurrent()     GET /api/schedule/current -> active-slot widget
 *   - renderScheduleGrid()      DAYS header + 12 rows x 7 cells; filled slot cells
 *   - renderEventsList()        .event-item rows from scheduleData.events
 *   - renderScheduleSettings()  tz/enabled + the 500ms default-playlist race
 *   - loadPlaylistsForSelect()  GET /api/playlists (FRPlaylists) + /api/video-playlists
 *   - #save-schedule-settings   PUT /api/schedule {settings:{...}}
 *   - #add-weekly-slot-btn      generic modal -> POST /api/schedule/weekly
 *   - #add-event-btn            generic modal -> POST /api/schedule/events
 *   - deleteWeeklySlot(id)      DELETE /api/schedule/weekly/<id> (confirm in grid cell)
 *   - deleteEvent(id)           DELETE /api/schedule/events/<id> (internal confirm)
 *
 * AS-IS quirks pinned here (flagged for the C2 extraction):
 *   - scheduleData.weekly/.events are OBJECTS keyed by id (Object.values is taken).
 *   - renderScheduleGrid THROWS if a weekly slot lacks startTime/endTime, and uses
 *     an overnight wrap rule (endH<=startH => +24).
 *   - #schedule-enabled.checked = s.enabled !== false: checked unless EXACTLY false.
 *   - The 500ms timer applies s.defaultPlaylistId AFTER loadForSelect populated the
 *     <option>s; if the option is absent the assignment silently no-ops.
 *   - loadSchedule's error path uses log() (no #error-banner); save/add/delete error
 *     paths use showError() (#error-banner.visible).
 *   - deleteWeeklySlot has NO internal confirm (its confirm lives in the grid cell
 *     onclick); deleteEvent DOES confirm internally.
 *
 * REALM CAVEAT (timers): app.js's setTimeout/setInterval resolve to win.setTimeout /
 * win.setInterval (jsdom's own timers), a DIFFERENT realm than node globalThis, so a
 * bare vi.useFakeTimers() would NOT fire the 500ms race. We use Recipe A: override
 * win.setTimeout to capture the 500ms callback, then invoke it manually. The 30s
 * setInterval(loadScheduleCurrent,30000) is never touched (win.setInterval untouched),
 * so it can only fire after 30s of REAL time -> never in a fast test.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { bootWindow, makeFetchStub, routeExact, flush, closeAllWindows } from './appBoot.js';

// Tear down every jsdom window this file booted: each one keeps ~13 real
// timers alive for the rest of the process otherwise.
afterAll(closeAllWindows);

/**
 * Boot a fresh window and grab the schedule hook. No init/deps to inject — the
 * hook fns are the real closure fns; tests control only win.fetch (+ win.confirm).
 */
function boot() {
  const { win, doc } = bootWindow();
  const sched = win.FRSchedule;
  return { win, doc, sched };
}

/** Install a recording fetch stub (replacing the never-resolving boot fetch). */
function withFetch(win, routes) {
  const stub = makeFetchStub(routes);
  win.fetch = stub.fetch;
  return stub;
}

describe('schedule UI characterization (window.FRSchedule)', () => {
  it('exposes the 8 fns + the 3 state accessors', () => {
    const { sched } = boot();
    expect(sched).toBeTruthy();
    for (const fn of [
      'loadSchedule', 'loadScheduleCurrent', 'renderScheduleGrid',
      'renderEventsList', 'renderScheduleSettings', 'loadPlaylistsForSelect',
      'deleteWeeklySlot', 'deleteEvent',
      'getScheduleData', 'setScheduleData', 'getDAYS',
    ]) {
      expect(typeof sched[fn]).toBe('function');
    }
    // DAYS is the canonical Mon..Sun array
    expect(sched.getDAYS()).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    // initial scheduleData shape
    expect(sched.getScheduleData()).toEqual({ weekly: {}, events: {}, settings: {} });
  });

  // -------------------------------------------------------------------------
  // loadSchedule
  // -------------------------------------------------------------------------
  describe('loadSchedule', () => {
    it('GET /api/schedule -> sets scheduleData and runs the grid/events/settings/current fan-out', async () => {
      const { win, doc, sched } = boot();
      // capture the 500ms timer renderScheduleSettings schedules (do not fire it)
      win.setTimeout = () => 1;
      const data = {
        weekly: { s1: { id: 's1', day: 4, startTime: '22:00', endTime: '23:00', label: 'Fri Night' } },
        events: {},
        settings: { timezone: 'Europe/Berlin', enabled: false },
      };
      const stub = withFetch(win, [
        routeExact('GET', '/api/schedule', data),
        routeExact('GET', '/api/schedule/current', { label: 'Live Now', nextLabel: 'Up Next' }),
        routeExact('GET', '/api/playlists', []),
        routeExact('GET', '/api/video-playlists', []),
      ]);

      sched.loadSchedule();
      await flush(10);

      // scheduleData replaced by the response object
      expect(sched.getScheduleData()).toBe(data);
      // renderScheduleGrid ran (header + 12 hour rows)
      expect(doc.getElementById('schedule-grid').querySelector('.sched-header-row')).toBeTruthy();
      expect(doc.getElementById('schedule-grid').querySelectorAll('.sched-row').length).toBe(12);
      // renderEventsList ran (no events -> empty-state)
      expect(doc.getElementById('events-list').querySelector('.empty-state').textContent).toBe('No events');
      // renderScheduleSettings ran (tz + enabled applied)
      expect(doc.getElementById('schedule-timezone').value).toBe('Europe/Berlin');
      expect(doc.getElementById('schedule-enabled').checked).toBe(false);
      // loadScheduleCurrent ran last
      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/schedule/current')).toBe(true);
      expect(doc.getElementById('sched-active-slot').textContent).toBe('Live Now');
      expect(doc.getElementById('sw-next').textContent).toBe('Up Next');
    });

    it('AS-IS: load error path uses log() (no #error-banner)', async () => {
      const { win, doc, sched } = boot();
      win.fetch = () => Promise.reject(new Error('boom'));
      sched.loadSchedule();
      await flush();
      expect(doc.getElementById('error-banner').classList.contains('visible')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // loadScheduleCurrent
  // -------------------------------------------------------------------------
  describe('loadScheduleCurrent', () => {
    it('GET /api/schedule/current -> fills the active-slot widget from the response', async () => {
      const { win, doc, sched } = boot();
      const stub = withFetch(win, [
        routeExact('GET', '/api/schedule/current', {
          label: 'Morning Show',
          playlistName: 'AM Mix',
          videoPlaylistName: 'AM Visuals',
          nextLabel: 'Noon',
        }),
      ]);
      sched.loadScheduleCurrent();
      await flush();

      expect(stub.calls.some((c) => c.url === '/api/schedule/current')).toBe(true);
      expect(doc.getElementById('sched-active-slot').textContent).toBe('Morning Show');
      expect(doc.getElementById('sched-active-playlist').textContent).toBe('AM Mix');
      expect(doc.getElementById('sched-active-video-playlist').textContent).toBe('AM Visuals');
      expect(doc.getElementById('sw-now').textContent).toBe('Morning Show');
      expect(doc.getElementById('sw-next').textContent).toBe('Noon');
    });

    it('AS-IS: empty response falls back to slotId/-- defaults', async () => {
      const { win, doc, sched } = boot();
      withFetch(win, [
        routeExact('GET', '/api/schedule/current', { slotId: 'slot-7' }),
      ]);
      sched.loadScheduleCurrent();
      await flush();
      // label missing -> slotId for active-slot, 'No active slot' for sw-now
      expect(doc.getElementById('sched-active-slot').textContent).toBe('slot-7');
      expect(doc.getElementById('sched-active-playlist').textContent).toBe('--');
      expect(doc.getElementById('sw-now').textContent).toBe('No active slot');
      expect(doc.getElementById('sw-next').textContent).toBe('--');
    });

    it('AS-IS: error path only sets #sw-now to "Schedule off"', async () => {
      const { win, doc, sched } = boot();
      win.fetch = () => Promise.reject(new Error('nope'));
      sched.loadScheduleCurrent();
      await flush();
      expect(doc.getElementById('sw-now').textContent).toBe('Schedule off');
      // the other widgets keep their index.html default
      expect(doc.getElementById('sw-next').textContent).toBe('--');
    });
  });

  // -------------------------------------------------------------------------
  // renderScheduleGrid
  // -------------------------------------------------------------------------
  describe('renderScheduleGrid', () => {
    it('builds the DAYS header + 12 two-hour rows of 7 cells each', () => {
      const { doc, sched } = boot();
      sched.setScheduleData({ weekly: {}, events: {}, settings: {} });
      sched.renderScheduleGrid();

      const grid = doc.getElementById('schedule-grid');
      const header = grid.querySelector('.sched-header-row');
      const dayCols = header.querySelectorAll('.sched-day-col');
      expect(dayCols.length).toBe(7);
      expect(Array.from(dayCols).map((c) => c.textContent)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

      const rows = grid.querySelectorAll('.sched-row');
      expect(rows.length).toBe(12);
      // first row time label is pad(0)+':00' = '00:00'
      expect(rows[0].querySelector('.sched-time-col').textContent).toBe('00:00');
      // each row has 7 cells with dataset day/hour
      expect(rows[0].querySelectorAll('.sched-cell').length).toBe(7);
      expect(rows[0].querySelectorAll('.sched-cell')[3].dataset.day).toBe('3');
      // second row covers hour 2
      expect(rows[1].querySelector('.sched-time-col').textContent).toBe('02:00');
    });

    it('a matching weekly slot fills its cell with label + title and a confirm-gated onclick', async () => {
      const { win, doc, sched } = boot();
      const stub = withFetch(win, [
        routeExact('DELETE', '/api/schedule/weekly/s1', {}),
        routeExact('GET', '/api/schedule', { weekly: {}, events: {}, settings: {} }),
        routeExact('GET', '/api/schedule/current', {}),
        routeExact('GET', '/api/playlists', []),
        routeExact('GET', '/api/video-playlists', []),
      ]);
      // slot on Tue (day index 1) 10:00-12:00 -> only the hour-10 cell is filled
      sched.setScheduleData({
        weekly: { s1: { id: 's1', day: 1, startTime: '10:00', endTime: '12:00', label: 'Mid Morning' } },
        events: {},
        settings: {},
      });
      win.setTimeout = () => 1; // loadSchedule (triggered after delete) schedules a 500ms timer
      sched.renderScheduleGrid();

      const filled = doc.getElementById('schedule-grid').querySelectorAll('.sched-cell-filled');
      expect(filled.length).toBe(1);
      const cell = filled[0];
      expect(cell.className).toBe('sched-cell sched-cell-filled');
      expect(cell.textContent).toBe('Mid Morning');
      expect(cell.title).toBe('Mid Morning (10:00-12:00)');
      expect(cell.dataset.day).toBe('1');
      expect(cell.dataset.hour).toBe('10');

      // confirm=true -> deleteWeeklySlot fires DELETE then loadSchedule
      win.confirm = () => true;
      cell.onclick();
      await flush(10);
      expect(stub.calls.some((c) => c.method === 'DELETE' && c.url === '/api/schedule/weekly/s1')).toBe(true);
      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/schedule')).toBe(true);
    });

    it('confirm=false on a filled cell -> no DELETE', async () => {
      const { win, doc, sched } = boot();
      const stub = withFetch(win, [routeExact('DELETE', '/api/schedule/weekly/s1', {})]);
      sched.setScheduleData({
        weekly: { s1: { id: 's1', day: 0, startTime: '00:00', endTime: '02:00', label: 'Overnight' } },
        events: {},
        settings: {},
      });
      sched.renderScheduleGrid();
      win.confirm = () => false;
      doc.getElementById('schedule-grid').querySelector('.sched-cell-filled').onclick();
      await flush();
      expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(false);
    });

    it('AS-IS: an overnight slot (22:00-06:00) wraps and fills cells past midnight', () => {
      const { doc, sched } = boot();
      sched.setScheduleData({
        weekly: { s1: { id: 's1', day: 2, startTime: '22:00', endTime: '06:00', label: 'Night' } },
        events: {},
        settings: {},
      });
      sched.renderScheduleGrid();
      const filled = doc.getElementById('schedule-grid').querySelectorAll('.sched-cell-filled');
      // grid rows are 0,2,4,...,22. Wrap covers hours [22,30) => 22,0,2,4 on day index 2
      const hours = Array.from(filled)
        .filter((c) => c.dataset.day === '2')
        .map((c) => Number(c.dataset.hour))
        .sort((a, b) => a - b);
      expect(hours).toEqual([0, 2, 4, 22]);
    });

    it('AS-IS: a weekly slot without startTime/endTime makes renderScheduleGrid throw', () => {
      const { sched } = boot();
      sched.setScheduleData({
        weekly: { bad: { id: 'bad', day: 0, label: 'No times' } },
        events: {},
        settings: {},
      });
      expect(() => sched.renderScheduleGrid()).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // renderEventsList
  // -------------------------------------------------------------------------
  describe('renderEventsList', () => {
    it('no events -> "No events" empty-state', () => {
      const { doc, sched } = boot();
      sched.setScheduleData({ weekly: {}, events: {}, settings: {} });
      sched.renderEventsList();
      const container = doc.getElementById('events-list');
      expect(container.querySelectorAll('.event-item').length).toBe(0);
      expect(container.querySelector('.empty-state').textContent).toBe('No events');
    });

    it('renders one .event-item per event, sorted by date ascending, with date/time/label spans', () => {
      const { doc, sched } = boot();
      sched.setScheduleData({
        weekly: {},
        events: {
          e2: { id: 'e2', date: '2026-07-10', startTime: '20:00', endTime: '23:00', label: 'Guest DJ' },
          e1: { id: 'e1', date: '2026-07-01', startTime: '18:00', endTime: '20:00', label: 'Opening' },
        },
        settings: {},
      });
      sched.renderEventsList();
      const items = doc.getElementById('events-list').querySelectorAll('.event-item');
      expect(items.length).toBe(2);
      // sorted ascending by date -> e1 (Jul 1) first
      expect(items[0].querySelector('.event-date').textContent).toBe('2026-07-01');
      expect(items[0].querySelector('.event-time').textContent).toBe('18:00-20:00');
      expect(items[0].querySelector('.event-label').textContent).toBe('Opening');
      expect(items[1].querySelector('.event-date').textContent).toBe('2026-07-10');
      expect(items[1].querySelector('.event-label').textContent).toBe('Guest DJ');
    });

    it('AS-IS: missing label -> "Event"; the row delete button is confirm-gated deleteEvent', async () => {
      const { win, doc, sched } = boot();
      const stub = withFetch(win, [
        routeExact('DELETE', '/api/schedule/events/e1', {}),
        routeExact('GET', '/api/schedule', { weekly: {}, events: {}, settings: {} }),
        routeExact('GET', '/api/schedule/current', {}),
        routeExact('GET', '/api/playlists', []),
        routeExact('GET', '/api/video-playlists', []),
      ]);
      win.setTimeout = () => 1; // loadSchedule after delete schedules a 500ms timer
      sched.setScheduleData({
        weekly: {},
        events: { e1: { id: 'e1', date: '2026-07-01', startTime: '18:00', endTime: '20:00' } },
        settings: {},
      });
      sched.renderEventsList();
      const item = doc.getElementById('events-list').querySelector('.event-item');
      expect(item.querySelector('.event-label').textContent).toBe('Event');

      const delBtn = item.querySelector('button.file-del');
      expect(delBtn).toBeTruthy();
      // confirm=false -> no DELETE
      win.confirm = () => false;
      delBtn.onclick();
      await flush();
      expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(false);
      // confirm=true -> DELETE then loadSchedule
      win.confirm = () => true;
      delBtn.onclick();
      await flush(10);
      expect(stub.calls.some((c) => c.method === 'DELETE' && c.url === '/api/schedule/events/e1')).toBe(true);
      expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/schedule')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // deleteEvent / deleteWeeklySlot — driven directly
  // -------------------------------------------------------------------------
  describe('deletes (direct)', () => {
    it('deleteEvent has an INTERNAL confirm gate: confirm=false -> no DELETE', async () => {
      const { win, sched } = boot();
      const stub = withFetch(win, [routeExact('DELETE', '/api/schedule/events/e9', {})]);
      win.confirm = () => false;
      sched.deleteEvent('e9');
      await flush();
      expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(false);
    });

    it('AS-IS: deleteWeeklySlot has NO internal confirm — DELETE fires unconditionally', async () => {
      const { win, sched } = boot();
      const stub = withFetch(win, [
        routeExact('DELETE', '/api/schedule/weekly/s9', {}),
        routeExact('GET', '/api/schedule', { weekly: {}, events: {}, settings: {} }),
        routeExact('GET', '/api/schedule/current', {}),
        routeExact('GET', '/api/playlists', []),
        routeExact('GET', '/api/video-playlists', []),
      ]);
      win.setTimeout = () => 1;
      // even with confirm forced false, deleteWeeklySlot still fires (no gate inside it)
      win.confirm = () => false;
      sched.deleteWeeklySlot('s9');
      await flush(10);
      expect(stub.calls.some((c) => c.method === 'DELETE' && c.url === '/api/schedule/weekly/s9')).toBe(true);
    });

    it('deleteWeeklySlot error path -> showError #error-banner', async () => {
      const { win, doc, sched } = boot();
      win.fetch = () => Promise.reject(new Error('x'));
      sched.deleteWeeklySlot('s9');
      await flush();
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);
      expect(banner.textContent).toContain('Delete slot failed');
    });
  });

  // -------------------------------------------------------------------------
  // renderScheduleSettings — the 500ms default-playlist race (Recipe A timers)
  // -------------------------------------------------------------------------
  describe('renderScheduleSettings', () => {
    it('applies tz + enabled synchronously, then the 500ms timer sets the default playlist', async () => {
      const { win, doc, sched } = boot();
      // Recipe A: capture the 500ms callback instead of letting jsdom schedule it.
      let pendingCb = null;
      const realST = win.setTimeout.bind(win);
      win.setTimeout = (fn, ms) => { if (ms === 500) { pendingCb = fn; return 1; } return realST(fn, ms); };

      withFetch(win, [
        routeExact('GET', '/api/playlists', [{ id: 'pl1', name: 'P1' }]),
        routeExact('GET', '/api/video-playlists', []),
      ]);
      sched.setScheduleData({
        weekly: {},
        events: {},
        settings: { timezone: 'Europe/Berlin', enabled: false, defaultPlaylistId: 'pl1' },
      });
      sched.renderScheduleSettings();

      // tz + enabled applied synchronously
      expect(doc.getElementById('schedule-timezone').value).toBe('Europe/Berlin');
      expect(doc.getElementById('schedule-enabled').checked).toBe(false);

      await flush(); // resolve /api/playlists -> option value 'pl1' now in the select
      expect(typeof pendingCb).toBe('function');
      // before firing the timer, value not yet applied
      expect(doc.getElementById('schedule-default-playlist').value).toBe('');
      pendingCb(); // run the 500ms body
      expect(doc.getElementById('schedule-default-playlist').value).toBe('pl1');
    });

    it('AS-IS: enabled defaults to checked (true) unless settings.enabled === false', () => {
      const { win, doc, sched } = boot();
      win.setTimeout = () => 1;
      withFetch(win, [
        routeExact('GET', '/api/playlists', []),
        routeExact('GET', '/api/video-playlists', []),
      ]);
      // enabled undefined -> checked true; timezone missing -> 'Europe/Moscow'
      sched.setScheduleData({ weekly: {}, events: {}, settings: {} });
      sched.renderScheduleSettings();
      expect(doc.getElementById('schedule-enabled').checked).toBe(true);
      expect(doc.getElementById('schedule-timezone').value).toBe('Europe/Moscow');
    });

    it('AS-IS: the 500ms value-set no-ops when no matching option exists', async () => {
      const { win, doc, sched } = boot();
      let pendingCb = null;
      const realST = win.setTimeout.bind(win);
      win.setTimeout = (fn, ms) => { if (ms === 500) { pendingCb = fn; return 1; } return realST(fn, ms); };
      withFetch(win, [
        routeExact('GET', '/api/playlists', [{ id: 'plA', name: 'A' }]),
        routeExact('GET', '/api/video-playlists', []),
      ]);
      // defaultPlaylistId references an id NOT in the populated options
      sched.setScheduleData({ weekly: {}, events: {}, settings: { defaultPlaylistId: 'missing' } });
      sched.renderScheduleSettings();
      await flush();
      pendingCb();
      // assignment silently no-ops -> select stays at its first option value ''
      expect(doc.getElementById('schedule-default-playlist').value).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // loadPlaylistsForSelect
  // -------------------------------------------------------------------------
  describe('loadPlaylistsForSelect', () => {
    it('populates music selects via /api/playlists and video selects via /api/video-playlists', async () => {
      const { win, doc, sched } = boot();
      withFetch(win, [
        routeExact('GET', '/api/playlists', [{ id: 'm1', name: 'Music One' }]),
        routeExact('GET', '/api/video-playlists', [{ id: 'v1', name: 'Vid One', trackCount: 4 }]),
      ]);
      // give the page a video-playlist-select to populate
      const vsel = doc.createElement('select');
      vsel.className = 'video-playlist-select';
      doc.body.appendChild(vsel);

      sched.loadPlaylistsForSelect();
      await flush(10);

      // music: FRPlaylists.loadForSelect targets '#schedule-default-playlist, .playlist-select'
      const musicSel = doc.getElementById('schedule-default-playlist');
      expect(Array.from(musicSel.options).some((o) => o.value === 'm1' && o.textContent === 'Music One')).toBe(true);
      // video: '-- None --' + one option labelled with the video count
      expect(vsel.options[0].textContent).toBe('-- None --');
      expect(vsel.options[1].value).toBe('v1');
      expect(vsel.options[1].textContent).toBe('Vid One (4 videos)');
    });
  });

  // -------------------------------------------------------------------------
  // #save-schedule-settings button (direct, not a modal)
  // -------------------------------------------------------------------------
  describe('save-schedule-settings button', () => {
    it('PUT /api/schedule with the settings gathered from the form fields', async () => {
      const { win, doc } = boot();
      const stub = withFetch(win, [routeExact('PUT', '/api/schedule', {})]);
      doc.getElementById('schedule-timezone').value = 'Europe/Berlin';
      doc.getElementById('schedule-enabled').checked = false;
      // defaultPlaylistId '' -> null in the body
      doc.getElementById('save-schedule-settings').onclick();
      await flush();

      const put = stub.calls.find((c) => c.method === 'PUT' && c.url === '/api/schedule');
      expect(put).toBeTruthy();
      expect(put.body).toEqual({ settings: { timezone: 'Europe/Berlin', defaultPlaylistId: null, enabled: false } });
    });

    it('save error path -> showError #error-banner', async () => {
      const { win, doc } = boot();
      win.fetch = () => Promise.reject(new Error('x'));
      doc.getElementById('save-schedule-settings').onclick();
      await flush();
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);
      expect(banner.textContent).toContain('Save schedule settings failed');
    });
  });

  // -------------------------------------------------------------------------
  // #add-weekly-slot-btn -> generic modal -> POST /api/schedule/weekly
  // -------------------------------------------------------------------------
  describe('add-weekly-slot flow (real #add-weekly-slot-btn + #generic-modal-save)', () => {
    it('opens the modal, then save POSTs the slot body and closes the modal', async () => {
      const { win, doc } = boot();
      win.setTimeout = () => 1; // loadSchedule on success schedules a 500ms timer
      const stub = withFetch(win, [
        routeExact('POST', '/api/schedule/weekly', {}),
        routeExact('GET', '/api/schedule', { weekly: {}, events: {}, settings: {} }),
        routeExact('GET', '/api/schedule/current', {}),
        routeExact('GET', '/api/playlists', []),
        routeExact('GET', '/api/video-playlists', []),
      ]);

      doc.getElementById('add-weekly-slot-btn').onclick();
      expect(doc.getElementById('generic-modal').style.display).toBe('flex');
      expect(doc.getElementById('generic-modal-title').textContent).toBe('Add Weekly Slot');

      // fill the injected fields
      doc.getElementById('slot-day').value = '4';
      doc.getElementById('slot-start').value = '21:00';
      doc.getElementById('slot-end').value = '23:30';
      doc.getElementById('slot-label').value = '  Friday Night  ';

      doc.getElementById('generic-modal-save').onclick();
      await flush(10);

      const post = stub.calls.find((c) => c.method === 'POST' && c.url === '/api/schedule/weekly');
      expect(post).toBeTruthy();
      expect(post.body).toEqual({
        day: 4,
        startTime: '21:00',
        endTime: '23:30',
        playlistId: null,
        videoPlaylistId: null,
        label: 'Friday Night',
      });
      // success closes the modal
      expect(doc.getElementById('generic-modal').style.display).toBe('none');
    });

    it('add-slot error path -> showError, modal stays open', async () => {
      const { win, doc } = boot();
      doc.getElementById('add-weekly-slot-btn').onclick();
      win.fetch = () => Promise.reject(new Error('x'));
      doc.getElementById('generic-modal-save').onclick();
      await flush();
      const banner = doc.getElementById('error-banner');
      expect(banner.classList.contains('visible')).toBe(true);
      expect(banner.textContent).toContain('Add slot failed');
      expect(doc.getElementById('generic-modal').style.display).toBe('flex');
    });
  });

  // -------------------------------------------------------------------------
  // #add-event-btn -> generic modal -> POST /api/schedule/events
  // -------------------------------------------------------------------------
  describe('add-event flow (real #add-event-btn + #generic-modal-save)', () => {
    it('opens the modal, then save POSTs the event body and closes the modal', async () => {
      const { win, doc } = boot();
      win.setTimeout = () => 1;
      const stub = withFetch(win, [
        routeExact('POST', '/api/schedule/events', {}),
        routeExact('GET', '/api/schedule', { weekly: {}, events: {}, settings: {} }),
        routeExact('GET', '/api/schedule/current', {}),
        routeExact('GET', '/api/playlists', []),
        routeExact('GET', '/api/video-playlists', []),
      ]);

      doc.getElementById('add-event-btn').onclick();
      expect(doc.getElementById('generic-modal').style.display).toBe('flex');
      expect(doc.getElementById('generic-modal-title').textContent).toBe('Add Event');

      doc.getElementById('event-date').value = '2026-07-04';
      doc.getElementById('event-start').value = '19:00';
      doc.getElementById('event-end').value = '22:00';
      doc.getElementById('event-label').value = 'Independence';

      doc.getElementById('generic-modal-save').onclick();
      await flush(10);

      const post = stub.calls.find((c) => c.method === 'POST' && c.url === '/api/schedule/events');
      expect(post).toBeTruthy();
      expect(post.body).toEqual({
        date: '2026-07-04',
        startTime: '19:00',
        endTime: '22:00',
        playlistId: null,
        videoPlaylistId: null,
        label: 'Independence',
      });
      expect(doc.getElementById('generic-modal').style.display).toBe('none');
    });
  });
});
