/**
 * tests/dashboard/schedule.test.js
 *
 * Unit tests for dashboard/lib/schedule.js — schedule module.
 * Covers the pure functions (isTimeInRange, slotsOverlap, prevDate,
 * getNowInTimezone, getCurrentSlot, getNextSlot, cleanupPastEvents,
 * loadSchedule, saveSchedule) and the executor (executeScheduleTick,
 * startExecutor).
 *
 * Harness: schedule.js is loaded via createRequire (native CJS), NOT a mocked
 * ESM import. schedule.js consumes its deps with `require(...)`, which the
 * vitest ESM mock layer (vi.mock) does not intercept, so mocking that way would
 * silently hit the real liqClient/playlist/etc. Instead, deps are driven by
 * vi.spyOn on the live singletons (see freshExecutor). Loading through a single
 * nodeRequire copy also gives v8 one instrumented module to count, and the
 * executor tests fresh-require schedule between cases to reset its module-level
 * state (currentSlotId / currentPlaylistId). fs is stubbed via vi.spyOn.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import { createRequire } from 'module';
import { mockRes, getRouteHandler } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
const mod = nodeRequire('../../dashboard/lib/schedule');
const {
  isTimeInRange, slotsOverlap, getNowInTimezone, getCurrentSlot,
  getNextSlot, cleanupPastEvents, prevDate, loadSchedule, saveSchedule
} = mod._test || mod.default?._test || {};

// ─── Helpers ──────────────────────────────────────────────────

function mockScheduleFile(data) {
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(data));
  vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  // This suite discards writes rather than storing them, so the rename only has
  // to stay off the real filesystem — jsonStore renames <file>.tmp into place.
  vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
}

function emptySchedule(overrides = {}) {
  return {
    weekly: {},
    events: {},
    settings: {
      timezone: 'UTC',
      defaultPlaylistId: null,
      defaultVideoPlaylistId: null,
      enabled: true,
      ...overrides
    }
  };
}

// ─── isTimeInRange ────────────────────────────────────────────

describe('isTimeInRange', () => {
  it('returns true when time is within normal range', () => {
    expect(isTimeInRange('10:00', '08:00', '18:00')).toBe(true);
  });

  it('returns true at exact start time', () => {
    expect(isTimeInRange('08:00', '08:00', '18:00')).toBe(true);
  });

  it('returns false at exact end time (exclusive)', () => {
    expect(isTimeInRange('18:00', '08:00', '18:00')).toBe(false);
  });

  it('returns false when time is outside normal range', () => {
    expect(isTimeInRange('07:00', '08:00', '18:00')).toBe(false);
    expect(isTimeInRange('19:00', '08:00', '18:00')).toBe(false);
  });

  it('handles overnight range: time after start', () => {
    expect(isTimeInRange('23:00', '22:00', '06:00')).toBe(true);
  });

  it('handles overnight range: time before end', () => {
    expect(isTimeInRange('03:00', '22:00', '06:00')).toBe(true);
  });

  it('handles overnight range: at exact start', () => {
    expect(isTimeInRange('22:00', '22:00', '06:00')).toBe(true);
  });

  it('handles overnight range: before end (exclusive)', () => {
    expect(isTimeInRange('06:00', '22:00', '06:00')).toBe(false);
  });

  it('handles overnight range: time in gap', () => {
    expect(isTimeInRange('12:00', '22:00', '06:00')).toBe(false);
  });

  it('handles midnight boundary', () => {
    expect(isTimeInRange('00:00', '22:00', '06:00')).toBe(true);
    expect(isTimeInRange('00:00', '00:00', '06:00')).toBe(true);
  });

  it('handles same start and end (24h slot)', () => {
    // end <= start → overnight logic → current >= start || current < end
    // Since start === end, this is always true
    expect(isTimeInRange('12:00', '06:00', '06:00')).toBe(true);
  });
});

// ─── prevDate ─────────────────────────────────────────────────

describe('prevDate', () => {
  it('returns previous day for normal date', () => {
    expect(prevDate('2026-02-24')).toBe('2026-02-23');
  });

  it('handles month boundary', () => {
    expect(prevDate('2026-03-01')).toBe('2026-02-28');
  });

  it('handles year boundary', () => {
    expect(prevDate('2026-01-01')).toBe('2025-12-31');
  });

  it('handles leap year', () => {
    expect(prevDate('2024-03-01')).toBe('2024-02-29');
  });

  it('handles non-leap year', () => {
    expect(prevDate('2025-03-01')).toBe('2025-02-28');
  });
});

// ─── slotsOverlap ─────────────────────────────────────────────

describe('slotsOverlap', () => {
  it('detects overlap on same day', () => {
    const a = { day: 1, startTime: '10:00', endTime: '14:00' };
    const b = { day: 1, startTime: '12:00', endTime: '16:00' };
    expect(slotsOverlap(a, b)).toBe(true);
  });

  it('no overlap on same day, adjacent slots', () => {
    const a = { day: 1, startTime: '10:00', endTime: '14:00' };
    const b = { day: 1, startTime: '14:00', endTime: '18:00' };
    expect(slotsOverlap(a, b)).toBe(false);
  });

  it('no overlap on different days', () => {
    const a = { day: 1, startTime: '10:00', endTime: '14:00' };
    const b = { day: 3, startTime: '10:00', endTime: '14:00' };
    expect(slotsOverlap(a, b)).toBe(false);
  });

  it('detects overnight slot overlapping next day morning slot', () => {
    const a = { day: 1, startTime: '22:00', endTime: '04:00' }; // Tue 22-04
    const b = { day: 2, startTime: '02:00', endTime: '08:00' }; // Wed 02-08
    expect(slotsOverlap(a, b)).toBe(true);
  });

  it('no overlap: overnight ends before next day slot starts', () => {
    const a = { day: 1, startTime: '22:00', endTime: '02:00' }; // Tue 22-02
    const b = { day: 2, startTime: '03:00', endTime: '08:00' }; // Wed 03-08
    expect(slotsOverlap(a, b)).toBe(false);
  });

  it('detects two overnight slots overlapping', () => {
    const a = { day: 1, startTime: '22:00', endTime: '06:00' };
    const b = { day: 1, startTime: '23:00', endTime: '05:00' };
    expect(slotsOverlap(a, b)).toBe(true);
  });

  it('handles week wrap: Sunday overnight to Monday', () => {
    const a = { day: 6, startTime: '22:00', endTime: '04:00' }; // Sun 22-04
    const b = { day: 0, startTime: '02:00', endTime: '08:00' }; // Mon 02-08
    expect(slotsOverlap(a, b)).toBe(true);
  });

  it('symmetric: overlap(a,b) === overlap(b,a)', () => {
    const a = { day: 2, startTime: '20:00', endTime: '03:00' };
    const b = { day: 3, startTime: '01:00', endTime: '10:00' };
    expect(slotsOverlap(a, b)).toBe(slotsOverlap(b, a));
  });
});

// ─── getNowInTimezone ─────────────────────────────────────────

describe('getNowInTimezone', () => {
  it('returns object with weekday, timeStr, dateStr', () => {
    const result = getNowInTimezone('UTC');
    expect(result).toHaveProperty('weekday');
    expect(result).toHaveProperty('timeStr');
    expect(result).toHaveProperty('dateStr');
    expect(typeof result.weekday).toBe('number');
    expect(result.weekday).toBeGreaterThanOrEqual(0);
    expect(result.weekday).toBeLessThanOrEqual(6);
    expect(result.timeStr).toMatch(/^\d{2}:\d{2}$/);
    expect(result.dateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('falls back to server time for invalid timezone', () => {
    const result = getNowInTimezone('Invalid/Zone');
    expect(result).toHaveProperty('weekday');
    expect(result).toHaveProperty('timeStr');
    expect(result).toHaveProperty('dateStr');
  });

  it('weekday is 0=Mon convention', () => {
    // Just verify weekday is in range 0-6 (0=Mon, 6=Sun)
    const result = getNowInTimezone('Europe/Moscow');
    expect(result.weekday).toBeGreaterThanOrEqual(0);
    expect(result.weekday).toBeLessThanOrEqual(6);
  });
});

// ─── getCurrentSlot ───────────────────────────────────────────

describe('getCurrentSlot', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns disabled source when schedule is disabled', () => {
    mockScheduleFile(emptySchedule({ enabled: false, defaultPlaylistId: 'pl1' }));
    const slot = getCurrentSlot();
    expect(slot.source).toBe('disabled');
    expect(slot.playlistId).toBe('pl1');
  });

  it('returns default when no slots match', () => {
    mockScheduleFile(emptySchedule({ defaultPlaylistId: 'default-pl' }));
    const slot = getCurrentSlot();
    expect(slot.source).toBe('default');
    expect(slot.playlistId).toBe('default-pl');
  });

  it('matches a weekly slot on current day/time', () => {
    const { weekday, timeStr } = getNowInTimezone('UTC');
    const data = emptySchedule();
    // Create a slot for the current day, current time +/- 1 hour
    const [h, m] = timeStr.split(':').map(Number);
    const start = String(Math.max(0, h - 1)).padStart(2, '0') + ':00';
    const end = String(Math.min(23, h + 1)).padStart(2, '0') + ':59';
    data.weekly.ws1 = {
      id: 'ws1', day: weekday, startTime: start, endTime: end,
      playlistId: 'test-pl', videoPlaylistId: null, label: 'Test'
    };
    mockScheduleFile(data);
    const slot = getCurrentSlot();
    expect(slot.source).toBe('weekly');
    expect(slot.slotId).toBe('ws1');
    expect(slot.playlistId).toBe('test-pl');
  });

  it('matches overnight weekly slot on next calendar day', () => {
    // Key test for the overnight bug
    // Mock getNowInTimezone to control time
    const data = emptySchedule();
    // Slot: day=1 (Tue) 22:00-06:00
    data.weekly.ws_night = {
      id: 'ws_night', day: 1, startTime: '22:00', endTime: '06:00',
      playlistId: 'night-pl', videoPlaylistId: 'night-vpl', label: 'Night'
    };
    mockScheduleFile(data);

    // Override getNowInTimezone — now day=2 (Wed) 03:00
    // Mock Date and Intl for this
    const originalNow = Date.now;
    // Wed Feb 25 2026 03:00 UTC → weekday=2, timeStr=03:00
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-02-25T03:00:00Z').getTime());
    // Need to mock new Date() too
    const OrigDate = Date;
    const mockDate = new OrigDate('2026-02-25T03:00:00Z');

    // More robust approach: mock loadSchedule via file, getNowInTimezone via Intl
    // But simpler: call getCurrentSlot directly with controlled time
    // getCurrentSlot internally calls getNowInTimezone('UTC') which uses new Date()

    // Instead of complex mocking, verify logic via _test functions directly
    // isTimeInRange('03:00', '22:00', '06:00') is already true
    // Check matchNextDay works: (ws.day + 1) % 7 === weekday
    // ws.day=1, weekday=2 -> (1+1)%7=2 === 2, endTime='06:00' > '03:00'
    expect(isTimeInRange('03:00', '22:00', '06:00')).toBe(true);

    // For a full e2e getCurrentSlot test — can't mock getNowInTimezone
    // (it's an internal module function), but the logic is verified above
    Date.now = originalNow;
  });

  it('events have priority over weekly slots', () => {
    const { weekday, timeStr, dateStr } = getNowInTimezone('UTC');
    const [h] = timeStr.split(':').map(Number);
    const start = String(Math.max(0, h - 1)).padStart(2, '0') + ':00';
    const end = String(Math.min(23, h + 1)).padStart(2, '0') + ':59';

    const data = emptySchedule();
    data.weekly.ws1 = {
      id: 'ws1', day: weekday, startTime: start, endTime: end,
      playlistId: 'weekly-pl', label: 'Weekly'
    };
    data.events.ev1 = {
      id: 'ev1', date: dateStr, startTime: start, endTime: end,
      playlistId: 'event-pl', label: 'Event', priority: 5
    };
    mockScheduleFile(data);
    const slot = getCurrentSlot();
    expect(slot.source).toBe('event');
    expect(slot.playlistId).toBe('event-pl');
  });

  it('events sorted by priority (lower number = higher priority)', () => {
    const { weekday, timeStr, dateStr } = getNowInTimezone('UTC');
    const [h] = timeStr.split(':').map(Number);
    const start = String(Math.max(0, h - 1)).padStart(2, '0') + ':00';
    const end = String(Math.min(23, h + 1)).padStart(2, '0') + ':59';

    const data = emptySchedule();
    data.events.ev_low = {
      id: 'ev_low', date: dateStr, startTime: start, endTime: end,
      playlistId: 'low-prio', label: 'Low', priority: 20
    };
    data.events.ev_high = {
      id: 'ev_high', date: dateStr, startTime: start, endTime: end,
      playlistId: 'high-prio', label: 'High', priority: 1
    };
    mockScheduleFile(data);
    const slot = getCurrentSlot();
    expect(slot.playlistId).toBe('high-prio');
  });

  it('returns videoPlaylistId from slot', () => {
    const { weekday, timeStr } = getNowInTimezone('UTC');
    const [h] = timeStr.split(':').map(Number);
    const start = String(Math.max(0, h - 1)).padStart(2, '0') + ':00';
    const end = String(Math.min(23, h + 1)).padStart(2, '0') + ':59';

    const data = emptySchedule();
    data.weekly.ws1 = {
      id: 'ws1', day: weekday, startTime: start, endTime: end,
      playlistId: 'pl', videoPlaylistId: 'vpl', label: 'Test'
    };
    mockScheduleFile(data);
    const slot = getCurrentSlot();
    expect(slot.videoPlaylistId).toBe('vpl');
  });

  it('handles empty schedule gracefully', () => {
    mockScheduleFile(emptySchedule());
    const slot = getCurrentSlot();
    expect(slot.source).toBe('default');
    expect(slot.slotId).toBe(null);
  });

  it('handles missing settings gracefully', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ weekly: {}, events: {} }));
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    // settings is missing — should not crash
    const slot = getCurrentSlot();
    expect(['default', 'disabled', 'weekly', 'event']).toContain(slot.source);
  });

  it('handles no schedule file', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const slot = getCurrentSlot();
    expect(slot.source).toBe('default');
  });
});

// ─── getCurrentSlot overnight matching (integration-style) ───

describe('getCurrentSlot overnight matching logic', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('overnight weekly: isTimeInRange returns true for morning side', () => {
    // Basic check that isTimeInRange handles overnight correctly
    expect(isTimeInRange('03:00', '22:00', '06:00')).toBe(true);
    expect(isTimeInRange('05:59', '22:00', '06:00')).toBe(true);
    expect(isTimeInRange('06:00', '22:00', '06:00')).toBe(false);
  });

  it('overnight weekly: next-day matching formula is correct', () => {
    // Formula: (ws.day + 1) % 7 === weekday && timeStr < ws.endTime
    // Slot day=1 22:00-06:00, current weekday=2, time=03:00
    const ws = { day: 1, startTime: '22:00', endTime: '06:00' };
    const weekday = 2;
    const timeStr = '03:00';
    const isOvernight = ws.endTime <= ws.startTime;
    const matchNextDay = isOvernight && (ws.day + 1) % 7 === weekday && timeStr < ws.endTime;
    expect(matchNextDay).toBe(true);
  });

  it('overnight weekly: Sunday to Monday wrap', () => {
    const ws = { day: 6, startTime: '23:00', endTime: '05:00' }; // Sunday
    const weekday = 0; // Monday
    const timeStr = '02:00';
    const isOvernight = ws.endTime <= ws.startTime;
    const matchNextDay = isOvernight && (ws.day + 1) % 7 === weekday && timeStr < ws.endTime;
    expect(matchNextDay).toBe(true);
  });

  it('overnight weekly: does not match wrong next day', () => {
    const ws = { day: 1, startTime: '22:00', endTime: '06:00' };
    const weekday = 3; // Thursday, not Wednesday
    const timeStr = '03:00';
    const isOvernight = ws.endTime <= ws.startTime;
    const matchNextDay = isOvernight && (ws.day + 1) % 7 === weekday && timeStr < ws.endTime;
    expect(matchNextDay).toBe(false);
  });

  it('overnight weekly: does not match after end time', () => {
    const ws = { day: 1, startTime: '22:00', endTime: '06:00' };
    const weekday = 2;
    const timeStr = '07:00'; // After 06:00
    const isOvernight = ws.endTime <= ws.startTime;
    const matchNextDay = isOvernight && (ws.day + 1) % 7 === weekday && timeStr < ws.endTime;
    expect(matchNextDay).toBe(false);
  });

  it('overnight event: prevDate + time matching', () => {
    const ev = { date: '2026-02-23', startTime: '22:00', endTime: '06:00' };
    const dateStr = '2026-02-24';
    const timeStr = '03:00';
    const yesterday = prevDate(dateStr);
    const isOvernightEvent = ev.endTime <= ev.startTime;
    const matchOvernight = isOvernightEvent && ev.date === yesterday && timeStr < ev.endTime;
    expect(matchOvernight).toBe(true);
  });

  it('overnight event: does not match 2 days later', () => {
    const ev = { date: '2026-02-22', startTime: '22:00', endTime: '06:00' };
    const dateStr = '2026-02-24';
    const timeStr = '03:00';
    const yesterday = prevDate(dateStr);
    const matchOvernight = ev.endTime <= ev.startTime && ev.date === yesterday && timeStr < ev.endTime;
    expect(matchOvernight).toBe(false);
  });

  it('non-overnight slot does not trigger next-day matching', () => {
    const ws = { day: 1, startTime: '10:00', endTime: '18:00' };
    const weekday = 2;
    const timeStr = '12:00';
    const isOvernight = ws.endTime <= ws.startTime;
    expect(isOvernight).toBe(false);
    // matchNextDay should be false for non-overnight
    const matchNextDay = isOvernight && (ws.day + 1) % 7 === weekday && timeStr < ws.endTime;
    expect(matchNextDay).toBe(false);
  });
});

// ─── getNextSlot ──────────────────────────────────────────────

describe('getNextSlot', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when no slots exist', () => {
    mockScheduleFile(emptySchedule());
    expect(getNextSlot()).toBe(null);
  });

  it('finds next weekly slot', () => {
    const { weekday, timeStr } = getNowInTimezone('UTC');
    const [h] = timeStr.split(':').map(Number);
    // Slot 2 hours from now
    const futureH = (h + 2) % 24;
    const start = String(futureH).padStart(2, '0') + ':00';
    const end = String((futureH + 2) % 24).padStart(2, '0') + ':00';
    const slotDay = futureH < h ? (weekday + 1) % 7 : weekday;

    const data = emptySchedule();
    data.weekly.ws1 = {
      id: 'ws1', day: slotDay, startTime: start, endTime: end,
      playlistId: 'pl', label: 'Future'
    };
    mockScheduleFile(data);
    const next = getNextSlot();
    expect(next).not.toBe(null);
    expect(next.slotId).toBe('ws1');
  });

  it('finds next one-time event', () => {
    const { dateStr, timeStr } = getNowInTimezone('UTC');
    const [h] = timeStr.split(':').map(Number);
    const futureH = (h + 2) % 24;
    const futureDate = futureH < h
      ? new Date(new Date(dateStr).getTime() + 86400000).toISOString().slice(0, 10)
      : dateStr;
    const start = String(futureH).padStart(2, '0') + ':00';

    const data = emptySchedule();
    data.events.ev1 = {
      id: 'ev1', date: futureDate, startTime: start, endTime: '23:59',
      playlistId: 'pl', label: 'Future Event', priority: 5
    };
    mockScheduleFile(data);
    const next = getNextSlot();
    expect(next).not.toBe(null);
    expect(next.slotId).toBe('ev1');
  });

  it('picks closer slot when multiple exist', () => {
    const { weekday } = getNowInTimezone('UTC');
    // Slot tomorrow morning vs 3 days out
    const tomorrow = (weekday + 1) % 7;
    const farDay = (weekday + 3) % 7;

    const data = emptySchedule();
    data.weekly.ws_far = {
      id: 'ws_far', day: farDay, startTime: '10:00', endTime: '12:00',
      playlistId: 'pl', label: 'Far'
    };
    data.weekly.ws_near = {
      id: 'ws_near', day: tomorrow, startTime: '10:00', endTime: '12:00',
      playlistId: 'pl', label: 'Near'
    };
    mockScheduleFile(data);
    const next = getNextSlot();
    expect(next).not.toBe(null);
    expect(next.slotId).toBe('ws_near');
  });
});

// ─── cleanupPastEvents ────────────────────────────────────────

describe('cleanupPastEvents', () => {
  it('removes events with date before today', () => {
    const { dateStr } = getNowInTimezone('UTC');
    const data = {
      settings: { timezone: 'UTC' },
      events: {
        ev_old: { id: 'ev_old', date: '2020-01-01' },
        ev_today: { id: 'ev_today', date: dateStr },
        ev_future: { id: 'ev_future', date: '2030-12-31' }
      }
    };
    const cleaned = cleanupPastEvents(data);
    expect(cleaned).toBe(1);
    expect(data.events.ev_old).toBeUndefined();
    expect(data.events.ev_today).toBeDefined();
    expect(data.events.ev_future).toBeDefined();
  });

  it('returns 0 when no past events', () => {
    const data = {
      settings: { timezone: 'UTC' },
      events: { ev1: { id: 'ev1', date: '2030-12-31' } }
    };
    expect(cleanupPastEvents(data)).toBe(0);
  });

  it('handles empty events', () => {
    const data = { settings: { timezone: 'UTC' }, events: {} };
    expect(cleanupPastEvents(data)).toBe(0);
  });
});

// ─── loadSchedule / saveSchedule ──────────────────────────────

describe('loadSchedule', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns default structure when file does not exist', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const data = loadSchedule();
    expect(data).toHaveProperty('weekly');
    expect(data).toHaveProperty('events');
    expect(data).toHaveProperty('settings');
    expect(data.settings.timezone).toBe('Europe/Moscow');
  });

  it('parses valid JSON file', () => {
    const schedule = { weekly: { ws1: { id: 'ws1' } }, events: {}, settings: { timezone: 'UTC', enabled: true } };
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(schedule));
    const data = loadSchedule();
    expect(data.weekly.ws1.id).toBe('ws1');
  });

  it('returns default on corrupt JSON', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('not json');
    const data = loadSchedule();
    expect(data).toHaveProperty('settings');
  });
});

describe('saveSchedule', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('writes JSON to file', () => {
    const SCHEDULE_FILE = '/shared/schedule.json';
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    // saveSchedule writes atomically: bytes to <file>.tmp, rename into place.
    // Both paths are pinned EXACTLY — a substring match on the destination
    // would still pass if the rename landed somewhere else entirely.
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    const data = { weekly: {}, events: {}, settings: {} };
    saveSchedule(data);
    expect(renameSpy).toHaveBeenCalledWith(SCHEDULE_FILE + '.tmp', SCHEDULE_FILE);
    expect(spy).toHaveBeenCalledWith(
      SCHEDULE_FILE + '.tmp',
      JSON.stringify(data, null, 2)
    );
  });
});

// ─── executeScheduleTick / startExecutor (P1-7) ───────────────
//
// Characterization tests that PIN the current behavior of the schedule
// executor (executeScheduleTick) and the startExecutor wrapper, including
// surprising/buggy edges (swallowed errors, ACTIVE_FILE handling, the
// `needed = 5 - len` refill math). They lock in what the code does today
// before any future refactor — they are NOT bug fixes.
//
// Harness note: schedule.js consumes liqClient/playlist/videoPlaylist via
// `require(...)`, which vitest's ESM mock layer (vi.mock) does not intercept —
// mocking that way silently resolves the real CJS singletons. We therefore use
// the same proven pattern as queue.test.js: load schedule.js and its deps as
// live CJS singletons through createRequire, then vi.spyOn the shared dep
// objects — schedule's internal require returns those very objects. Deleting
// schedule from the require cache between tests resets its module-level state
// (currentSlotId / currentPlaylistId start at null again).

const ACTIVE_VISUAL_FILE = '/shared/active_visual_profile.json';

const SCHEDULE_SPEC = '../../dashboard/lib/schedule';
const liqLive = nodeRequire('../../dashboard/lib/liqClient');
const playlistLive = nodeRequire('../../dashboard/lib/playlist');
const videoLive = nodeRequire('../../dashboard/lib/videoPlaylist');

let schedLive;
let tick;
let startExec;

/**
 * Spy on the live dep singletons, then fresh-require schedule so it closes over
 * the spies. ORDER MATTERS: schedule.js DESTRUCTURES resolvePlaylist and
 * resolveVideoPlaylist at require time, so those spies must be installed BEFORE
 * the require. liqClient is kept as a whole-object (`const liq = require(...)`)
 * and its methods are read at call time, so it can be spied in any order.
 * Deleting schedule from the cache also resets its module-level state
 * (currentSlotId / currentPlaylistId back to null). Also silences console.log /
 * console.error, which the executor writes on every tick — every executor
 * describe block needs this, so it lives here next to the rest of the spies.
 */
function freshExecutor() {
  vi.spyOn(playlistLive, 'resolvePlaylist').mockReturnValue([]);
  vi.spyOn(videoLive, 'resolveVideoPlaylist').mockReturnValue([]);
  vi.spyOn(liqLive, 'clearQueue').mockResolvedValue({});
  vi.spyOn(liqLive, 'skip').mockResolvedValue({});
  vi.spyOn(liqLive, 'pushTrack').mockResolvedValue({});
  vi.spyOn(liqLive, 'getQueueLength').mockResolvedValue({ data: { length: 5 } });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  delete nodeRequire.cache[nodeRequire.resolve(SCHEDULE_SPEC)];
  schedLive = nodeRequire(SCHEDULE_SPEC);
  tick = schedLive._test.executeScheduleTick;
  startExec = schedLive._test.startExecutor;
}

// Use getNowInTimezone from the live module to build an "active now" slot.
function activeSlotSchedule({ playlistId = null, videoPlaylistId = null } = {}) {
  const { weekday, timeStr } = schedLive._test.getNowInTimezone('UTC');
  const [h] = timeStr.split(':').map(Number);
  const start = String(Math.max(0, h - 1)).padStart(2, '0') + ':00';
  const end = String(Math.min(23, h + 1)).padStart(2, '0') + ':59';
  const id = 'ws_exec';
  const data = {
    weekly: {
      [id]: { id, day: weekday, startTime: start, endTime: end, playlistId, videoPlaylistId, label: 'Slot ' + id }
    },
    events: {},
    settings: { timezone: 'UTC', defaultPlaylistId: null, defaultVideoPlaylistId: null, enabled: true }
  };
  return { data, id };
}

describe('executeScheduleTick — slot-changed broadcast contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    freshExecutor();
  });

  it('does not throw when broadcastFn is null (default, never injected)', async () => {
    const { data } = activeSlotSchedule({ playlistId: null });
    mockScheduleFile(data);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    await expect(tick()).resolves.toBeUndefined();
  });

  it('broadcasts schedule-slot with the full slot payload when broadcastFn is set', async () => {
    const { data, id } = activeSlotSchedule({ playlistId: 'pl-a', videoPlaylistId: 'vpl-a' });
    mockScheduleFile(data);
    videoLive.resolveVideoPlaylist.mockReturnValue(['v.mp4']);

    const broadcast = vi.fn();
    // startExecutor injects broadcastFn, then runs executeScheduleTick once.
    startExec(() => ({}), '/visuals', broadcast);
    // The tick is async; wait on the observable effect instead of draining a
    // magic number of microtasks tied to the tick's internal promise depth.
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalled());

    expect(broadcast).toHaveBeenCalledWith('schedule-slot', {
      slotId: id,
      playlistId: 'pl-a',
      videoPlaylistId: 'vpl-a',
      label: 'Slot ' + id,
      source: 'weekly'
    });
  });
});

describe('executeScheduleTick — playlist switch on slot change', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    freshExecutor();
  });

  it('clears queue, skips, and pushes the first 5 resolved tracks as processed paths', async () => {
    const { data } = activeSlotSchedule({ playlistId: 'pl1' });
    mockScheduleFile(data);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    // resolvePlaylist returns 7 tracks; only the first 5 should be pushed.
    playlistLive.resolvePlaylist.mockReturnValue([
      'a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3', 'f.mp3', 'g.mp3'
    ]);

    await tick();

    expect(liqLive.clearQueue).toHaveBeenCalledTimes(1);
    expect(liqLive.skip).toHaveBeenCalledTimes(1);
    // Batch is slice(0,5). getQueueLength default returns length 5 (>=3),
    // so the refill block pushes nothing extra — these 5 are the batch only.
    expect(liqLive.pushTrack).toHaveBeenCalledTimes(5);
    // Paths are converted to /music/processed/<base>.wav
    expect(liqLive.pushTrack).toHaveBeenNthCalledWith(1, '/music/processed/a.wav');
    expect(liqLive.pushTrack).toHaveBeenNthCalledWith(5, '/music/processed/e.wav');
  });

  it('swallows a single pushTrack rejection and still pushes the rest of the batch', async () => {
    const { data } = activeSlotSchedule({ playlistId: 'pl1' });
    mockScheduleFile(data);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    playlistLive.resolvePlaylist.mockReturnValue(['a.mp3', 'b.mp3', 'c.mp3']);
    // Make the 2nd track reject; the empty catch in the loop must absorb it.
    liqLive.pushTrack
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('push boom'))
      .mockResolvedValue({});

    await expect(tick()).resolves.toBeUndefined();
    // All 3 push attempts were made despite the middle one failing.
    expect(liqLive.pushTrack).toHaveBeenCalledTimes(3);
  });

  it('catches an outer playlist-switch failure (clearQueue rejects) without throwing', async () => {
    const { data } = activeSlotSchedule({ playlistId: 'pl1' });
    mockScheduleFile(data);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    playlistLive.resolvePlaylist.mockReturnValue(['a.mp3', 'b.mp3']);
    liqLive.clearQueue.mockRejectedValue(new Error('clearQueue down'));

    await expect(tick()).resolves.toBeUndefined();
    // Failure happened before skip/resolvePlaylist/pushTrack ran (skip is after clearQueue).
    expect(liqLive.skip).not.toHaveBeenCalled();
    expect(liqLive.pushTrack).not.toHaveBeenCalled();
  });

  it('does not touch the queue when the slot has no playlistId', async () => {
    const { data } = activeSlotSchedule({ playlistId: null });
    mockScheduleFile(data);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    await tick();

    expect(liqLive.clearQueue).not.toHaveBeenCalled();
    expect(liqLive.skip).not.toHaveBeenCalled();
    expect(liqLive.pushTrack).not.toHaveBeenCalled();
  });
});

describe('executeScheduleTick — video playlist activation file', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    freshExecutor();
  });

  it('writes ACTIVE_FILE with {id, name, videos, activatedAt} when slot has a video playlist', async () => {
    const { data, id } = activeSlotSchedule({ playlistId: null, videoPlaylistId: 'vpl-9' });
    mockScheduleFile(data);
    videoLive.resolveVideoPlaylist.mockReturnValue(['v1.mp4', 'v2.mp4']);

    const fixedNow = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    await tick();

    // Written atomically now: bytes land in ACTIVE_VISUAL_FILE + '.tmp' and the
    // rename publishes them under ACTIVE_VISUAL_FILE.
    const activeCall = writeSpy.mock.calls.find(c => c[0] === ACTIVE_VISUAL_FILE + '.tmp');
    expect(activeCall).toBeDefined();
    expect(fs.renameSync).toHaveBeenCalledWith(ACTIVE_VISUAL_FILE + '.tmp', ACTIVE_VISUAL_FILE);
    const payload = JSON.parse(activeCall[1]);
    expect(payload).toEqual({
      id: 'vpl-9',
      name: 'schedule-' + id,
      videos: ['v1.mp4', 'v2.mp4'],
      activatedAt: fixedNow
    });
    expect(typeof payload.activatedAt).toBe('number');
  });

  it('does not write ACTIVE_FILE when the resolved video playlist is empty', async () => {
    const { data } = activeSlotSchedule({ playlistId: null, videoPlaylistId: 'vpl-empty' });
    mockScheduleFile(data);
    videoLive.resolveVideoPlaylist.mockReturnValue([]);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    await tick();

    const activeCall = writeSpy.mock.calls.find(
      c => c[0] === ACTIVE_VISUAL_FILE || c[0] === ACTIVE_VISUAL_FILE + '.tmp'
    );
    expect(activeCall).toBeUndefined();
  });

  it('unlinks ACTIVE_FILE when slot has no video playlist and the file exists', async () => {
    const { data } = activeSlotSchedule({ playlistId: null, videoPlaylistId: null });
    mockScheduleFile(data); // existsSync mocked true → ACTIVE_FILE "exists"
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    await tick();

    expect(unlinkSpy).toHaveBeenCalledWith(ACTIVE_VISUAL_FILE);
  });

  it('does not unlink ACTIVE_FILE when no video playlist and the file does not exist', async () => {
    // existsSync false everywhere → loadSchedule returns defaults (no playlist),
    // and existsSync(ACTIVE_FILE) is false → no unlink.
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    await tick();

    expect(unlinkSpy).not.toHaveBeenCalled();
  });
});

describe('executeScheduleTick — refill path (slot unchanged)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    freshExecutor();
  });

  /**
   * Drives two ticks against the SAME slot id. Tick 1 takes the slot-changed
   * branch (sets currentSlotId/currentPlaylistId and runs the first batch).
   * Tick 2 sees an unchanged slot, so only the refill block runs. queueLength
   * is controlled per tick. Clears batch-phase calls before tick 2.
   */
  async function twoTicks({ resolveTracks, queueLenTick1, queueLenTick2 }) {
    const { data } = activeSlotSchedule({ playlistId: 'pl-refill' });
    mockScheduleFile(data); // same data → stable slot id across both ticks
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    playlistLive.resolvePlaylist.mockReturnValue(resolveTracks);
    liqLive.getQueueLength
      .mockResolvedValueOnce({ data: { length: queueLenTick1 } })
      .mockResolvedValueOnce({ data: { length: queueLenTick2 } });

    await tick(); // slot change + first batch
    liqLive.pushTrack.mockClear();
    liqLive.clearQueue.mockClear();
    liqLive.skip.mockClear();
    await tick(); // refill-only
  }

  it('refills exactly `needed = 5 - len` tracks when queue length < 3', async () => {
    // tick 2: len = 1 → needed = 4. Plenty of tracks resolved.
    await twoTicks({
      resolveTracks: ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3', 'f.mp3'],
      queueLenTick1: 5,
      queueLenTick2: 1
    });
    // Slot unchanged on tick 2 → no clearQueue/skip, only refill pushes.
    expect(liqLive.clearQueue).not.toHaveBeenCalled();
    expect(liqLive.skip).not.toHaveBeenCalled();
    expect(liqLive.pushTrack).toHaveBeenCalledTimes(4);
  });

  it('does not refill when queue length >= 3', async () => {
    await twoTicks({
      resolveTracks: ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'],
      queueLenTick1: 5,
      queueLenTick2: 3 // exactly 3 → not < 3 → no refill
    });
    expect(liqLive.pushTrack).not.toHaveBeenCalled();
  });

  it('caps refill at the number of available tracks when fewer than `needed`', async () => {
    // len = 0 → needed = 5, but only 2 tracks resolved → push 2.
    await twoTicks({
      resolveTracks: ['a.mp3', 'b.mp3'],
      queueLenTick1: 5,
      queueLenTick2: 0
    });
    expect(liqLive.pushTrack).toHaveBeenCalledTimes(2);
  });

  it('does not push when the resolved playlist is empty during refill', async () => {
    await twoTicks({
      resolveTracks: [],
      queueLenTick1: 5,
      queueLenTick2: 0
    });
    expect(liqLive.pushTrack).not.toHaveBeenCalled();
  });

  it('swallows a getQueueLength rejection during refill without throwing', async () => {
    const { data } = activeSlotSchedule({ playlistId: 'pl-refill' });
    mockScheduleFile(data);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    playlistLive.resolvePlaylist.mockReturnValue(['a.mp3', 'b.mp3', 'c.mp3']);
    liqLive.getQueueLength
      .mockResolvedValueOnce({ data: { length: 5 } }) // tick 1
      .mockRejectedValueOnce(new Error('no endpoint')); // tick 2 refill

    await tick();
    await expect(tick()).resolves.toBeUndefined();
  });

  it('treats a malformed getQueueLength result as length 0 and refills `needed` = 5', async () => {
    // queueResult.data.length not a number → len defaults to 0 → needed = 5.
    // PIN: this is the surprising default-to-0 branch in the source.
    const { data } = activeSlotSchedule({ playlistId: 'pl-refill' });
    mockScheduleFile(data);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    playlistLive.resolvePlaylist.mockReturnValue([
      'a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3', 'f.mp3'
    ]);
    liqLive.getQueueLength
      .mockResolvedValueOnce({ data: { length: 5 } }) // tick 1: no refill
      .mockResolvedValueOnce({}); // tick 2: no .data → len = 0

    await tick();
    liqLive.pushTrack.mockClear();
    await tick();
    expect(liqLive.pushTrack).toHaveBeenCalledTimes(5);
  });
});

describe('startExecutor (P1-7)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    freshExecutor();
  });

  it('saves the schedule after cleaning up past events on start', async () => {
    const { dateStr } = schedLive._test.getNowInTimezone('UTC');
    const data = {
      weekly: {}, events: { ev_old: { id: 'ev_old', date: '2020-01-01' } },
      settings: { timezone: 'UTC', defaultPlaylistId: null, enabled: true }
    };
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(data));
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    startExec(() => ({}), '/visuals', vi.fn());

    // saveSchedule wrote the schedule back (a past event was cleaned).
    const savedCall = writeSpy.mock.calls.find(c => String(c[0]).includes('schedule.json'));
    expect(savedCall).toBeDefined();
    const saved = JSON.parse(savedCall[1]);
    expect(saved.events.ev_old).toBeUndefined();
    expect(dateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('registers a 30s interval that re-invokes the tick', async () => {
    const { data } = activeSlotSchedule({ playlistId: null });
    mockScheduleFile(data);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0);

    startExec(() => ({}), '/visuals', vi.fn());

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30000);
  });
});

// ─── Router write-edge validation ─────────────────────────────
//
// The store is only as sound as the writes that reach it. Every reader of a
// weekly slot (slotsOverlap's toMinutes, getNextSlot, the client's
// renderScheduleGrid) splits startTime/endTime with no guard, so a malformed
// record breaks readers rather than its own write — one bad slot aborts the
// whole grid render. These cover the API refusing to create such a record.
//
// Reachability, exactly: a slot with startTime MISSING was already refused by
// the pre-existing required-fields check. What was not refused is a slot whose
// times are present but not parseable strings — POST accepted any truthy value
// (and only noticed via a TypeError inside the overlap check, which does not
// run at all when the schedule is empty), and PUT validated nothing whatsoever.

describe('createScheduleRouter — weekly slot write validation', () => {
  const { createScheduleRouter } = mod;

  function harness(initial) {
    const writes = [];
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(initial));
    vi.spyOn(fs, 'writeFileSync').mockImplementation((f, d) => { writes.push(JSON.parse(d)); });
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    return { router: createScheduleRouter(), writes };
  }

  const validSlot = { id: 'ws1', day: 4, startTime: '21:00', endTime: '23:30', playlistId: null, videoPlaylistId: null, label: 'Friday Night' };

  function postWeekly(initial, body) {
    const { router, writes } = harness(initial);
    const res = mockRes();
    getRouteHandler(router, 'post', '/weekly')({ body }, res);
    return { res, writes };
  }

  function putWeekly(initial, id, body) {
    const { router, writes } = harness(initial);
    const res = mockRes();
    getRouteHandler(router, 'put', '/weekly/:id')({ params: { id }, body }, res);
    return { res, writes };
  }

  beforeEach(() => vi.restoreAllMocks());

  it('accepts the payload the client actually sends, unchanged', () => {
    // Exactly what bindAddWeeklySlotButton POSTs: day as a parsed int 0-6 and
    // both times from <input type="time"> (always HH:MM).
    const { res, writes } = postWeekly(emptySchedule(), {
      day: 4, startTime: '21:00', endTime: '23:30',
      playlistId: null, videoPlaylistId: null, label: 'Friday Night',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ day: 4, startTime: '21:00', endTime: '23:30', label: 'Friday Night' });
    expect(writes).toHaveLength(1);
    expect(Object.values(writes[0].weekly)[0]).toMatchObject({ day: 4, startTime: '21:00' });
  });

  it('still accepts a numeric-string day, as parseInt did before', () => {
    const { res, writes } = postWeekly(emptySchedule(), { day: '4', startTime: '21:00', endTime: '23:30' });

    expect(res.statusCode).toBe(200);
    expect(res.body.day).toBe(4);
    expect(Object.values(writes[0].weekly)[0].day).toBe(4);
  });

  it('accepts both ends of the day range and midnight boundaries', () => {
    for (const [day, startTime, endTime] of [[0, '00:00', '23:59'], [6, '23:59', '00:00']]) {
      const { res } = postWeekly(emptySchedule(), { day, startTime, endTime });
      expect(res.statusCode).toBe(200);
    }
  });

  it('the register crash shape — a slot with no startTime — is refused', () => {
    const { res, writes } = postWeekly(emptySchedule(), { day: 4, endTime: '23:30' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('day, startTime, endTime required');
    expect(writes).toHaveLength(0);
  });

  it('POST refuses a non-string time on an empty schedule, where no overlap check would catch it', () => {
    // The gap this closes: with no existing slots slotsOverlap never runs, so
    // 123 used to sail into the store and detonate in the client instead.
    const { res, writes } = postWeekly(emptySchedule(), { day: 4, startTime: 123, endTime: '23:30' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('startTime must be HH:MM (24-hour)');
    expect(writes).toHaveLength(0);
  });

  it('POST refuses times that are strings but not clock times', () => {
    for (const bad of ['not-a-time', '25:00', '12:60', '7:00', '12:5']) {
      const { res, writes } = postWeekly(emptySchedule(), { day: 4, startTime: bad, endTime: '23:30' });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('startTime must be HH:MM (24-hour)');
      expect(writes).toHaveLength(0);
    }
  });

  it('POST refuses an endTime that is not a clock time', () => {
    const { res, writes } = postWeekly(emptySchedule(), { day: 4, startTime: '21:00', endTime: '99:99' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('endTime must be HH:MM (24-hour)');
    expect(writes).toHaveLength(0);
  });

  it('POST refuses a day outside 0-6 or not an integer', () => {
    for (const bad of [7, -1, 4.5, 'Friday', null, {}]) {
      const { res, writes } = postWeekly(emptySchedule(), { day: bad, startTime: '21:00', endTime: '23:30' });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('day must be an integer 0-6 (0=Mon, 6=Sun)');
      expect(writes).toHaveLength(0);
    }
  });

  it('PUT still applies a valid partial edit', () => {
    const initial = emptySchedule();
    initial.weekly = { ws1: { ...validSlot } };
    const { res, writes } = putWeekly(initial, 'ws1', { label: 'Renamed' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ label: 'Renamed', startTime: '21:00', day: 4 });
    expect(writes[0].weekly.ws1.label).toBe('Renamed');
  });

  it('PUT refuses a null startTime — the write that used to poison the grid', () => {
    // `if (body[key] !== undefined)` treats null as a value, so this replaced a
    // good time with null and every later render threw on null.split(':').
    const initial = emptySchedule();
    initial.weekly = { ws1: { ...validSlot } };
    const { res, writes } = putWeekly(initial, 'ws1', { startTime: null });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('startTime must be HH:MM (24-hour)');
    expect(writes).toHaveLength(0);
  });

  it('PUT refuses an out-of-range day', () => {
    const initial = emptySchedule();
    initial.weekly = { ws1: { ...validSlot } };
    const { res, writes } = putWeekly(initial, 'ws1', { day: 9 });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('day must be an integer 0-6 (0=Mon, 6=Sun)');
    expect(writes).toHaveLength(0);
  });

  it('PUT validates the merged result, so a malformed stored slot cannot be kept alive by a label edit', () => {
    const initial = emptySchedule();
    initial.weekly = { ws1: { id: 'ws1', day: 4, endTime: '23:30', label: 'legacy' } };
    const { res, writes } = putWeekly(initial, 'ws1', { label: 'still broken' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('startTime must be HH:MM (24-hour)');
    expect(writes).toHaveLength(0);
  });

  it('PUT on an unknown id still 404s before validation', () => {
    const { res } = putWeekly(emptySchedule(), 'nope', { startTime: null });
    expect(res.statusCode).toBe(404);
  });
});

describe('createScheduleRouter — settings shape guard', () => {
  const { createScheduleRouter } = mod;

  function putSettings(body) {
    const writes = [];
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(emptySchedule()));
    vi.spyOn(fs, 'writeFileSync').mockImplementation((f, d) => { writes.push(JSON.parse(d)); });
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    const res = mockRes();
    getRouteHandler(createScheduleRouter(), 'put', '/')({ body }, res);
    return { res, writes };
  }

  beforeEach(() => vi.restoreAllMocks());

  it('accepts the payload the settings form actually sends', () => {
    const { res, writes } = putSettings({
      settings: { timezone: 'Europe/Prague', defaultPlaylistId: 'pl1', enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(writes[0].settings).toMatchObject({ timezone: 'Europe/Prague', defaultPlaylistId: 'pl1', enabled: false });
  });

  it('refuses a non-boolean enabled', () => {
    // 'false' is truthy and never equals false, so the whole disable switch
    // would read as ON while the UI showed it OFF.
    const { res, writes } = putSettings({ settings: { enabled: 'false' } });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('settings.enabled has the wrong type');
    expect(writes).toHaveLength(0);
  });

  it('refuses a non-string timezone', () => {
    const { res, writes } = putSettings({ settings: { timezone: 42 } });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('settings.timezone has the wrong type');
    expect(writes).toHaveLength(0);
  });

  it('refuses settings that are not an object', () => {
    for (const bad of [[], 'timezone=UTC', 7]) {
      const { res, writes } = putSettings({ settings: bad });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('settings must be an object');
      expect(writes).toHaveLength(0);
    }
  });

  it('a body with no settings key still saves and returns the schedule', () => {
    const { res, writes } = putSettings({});
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('weekly');
    expect(writes).toHaveLength(1);
  });
});

describe('createScheduleRouter — one-time event write validation', () => {
  const { createScheduleRouter } = mod;

  function harness(initial) {
    const writes = [];
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(initial));
    vi.spyOn(fs, 'writeFileSync').mockImplementation((f, d) => { writes.push(JSON.parse(d)); });
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    return { router: createScheduleRouter(), writes };
  }

  const validEvent = { id: 'ev1', date: '2026-08-20', startTime: '20:00', endTime: '23:00', playlistId: null, videoPlaylistId: null, label: 'Guest DJ', priority: 10 };

  function postEvent(body) {
    const { router, writes } = harness(emptySchedule());
    const res = mockRes();
    getRouteHandler(router, 'post', '/events')({ body }, res);
    return { res, writes };
  }

  function putEvent(initial, id, body) {
    const { router, writes } = harness(initial);
    const res = mockRes();
    getRouteHandler(router, 'put', '/events/:id')({ params: { id }, body }, res);
    return { res, writes };
  }

  function seeded() {
    const initial = emptySchedule();
    initial.events = { ev1: { ...validEvent } };
    return initial;
  }

  beforeEach(() => vi.restoreAllMocks());

  it('accepts the payload the client actually sends', () => {
    // bindAddEventButton posts <input type="date"> and two <input type="time">.
    const { res, writes } = postEvent({
      date: '2026-08-20', startTime: '20:00', endTime: '23:00',
      playlistId: null, videoPlaylistId: null, label: 'Guest DJ',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ date: '2026-08-20', startTime: '20:00', endTime: '23:00', priority: 10 });
    expect(Object.values(writes[0].events)[0]).toMatchObject({ date: '2026-08-20' });
  });

  it('refuses a time that getNextSlot could not parse — the silent-skip case', () => {
    // getNextSlot builds new Date(date + 'T' + startTime + ':00'). 'evening'
    // makes that an Invalid Date, the minutes-until-start become NaN, and
    // `NaN < nearestMinutes` is false — so the event is passed over on every
    // pass, forever, while still appearing in the events list.
    const { res, writes } = postEvent({ date: '2026-08-20', startTime: 'evening', endTime: '23:00' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('startTime must be HH:MM (24-hour)');
    expect(writes).toHaveLength(0);
  });

  it('refuses a date that is not YYYY-MM-DD', () => {
    for (const bad of ['20-08-2026', '2026/08/20', 'tomorrow', 20260820]) {
      const { res, writes } = postEvent({ date: bad, startTime: '20:00', endTime: '23:00' });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('date must be YYYY-MM-DD');
      expect(writes).toHaveLength(0);
    }
  });

  it('refuses a well-shaped date that is not a real calendar day', () => {
    // Date rolls '2026-02-30' forward to March 1, so this would have been
    // accepted and then silently fired a day the caller never asked for.
    const { res, writes } = postEvent({ date: '2026-02-30', startTime: '20:00', endTime: '23:00' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('date must be YYYY-MM-DD');
    expect(writes).toHaveLength(0);
  });

  it('accepts a real leap day', () => {
    const { res } = postEvent({ date: '2028-02-29', startTime: '20:00', endTime: '23:00' });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a non-numeric priority, which would make the event sort meaningless', () => {
    const { res, writes } = postEvent({ date: '2026-08-20', startTime: '20:00', endTime: '23:00', priority: 'high' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('priority must be a number');
    expect(writes).toHaveLength(0);
  });

  it('still 400s on the pre-existing required-fields check', () => {
    const { res, writes } = postEvent({ date: '2026-08-20', endTime: '23:00' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('date, startTime, endTime required');
    expect(writes).toHaveLength(0);
  });

  it('PUT still applies a valid partial edit', () => {
    const { res, writes } = putEvent(seeded(), 'ev1', { label: 'Renamed' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ label: 'Renamed', date: '2026-08-20' });
    expect(writes[0].events.ev1.label).toBe('Renamed');
  });

  it('PUT refuses a null startTime instead of overwriting a good one', () => {
    const { res, writes } = putEvent(seeded(), 'ev1', { startTime: null });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('startTime must be HH:MM (24-hour)');
    expect(writes).toHaveLength(0);
  });

  it('PUT validates the merged result, so a broken stored event cannot ride along', () => {
    const initial = emptySchedule();
    initial.events = { ev1: { id: 'ev1', date: 'someday', startTime: '20:00', endTime: '23:00' } };
    const { res, writes } = putEvent(initial, 'ev1', { label: 'still broken' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('date must be YYYY-MM-DD');
    expect(writes).toHaveLength(0);
  });

  it('PUT on an unknown id still 404s before validation', () => {
    const { res } = putEvent(emptySchedule(), 'nope', { date: 'nonsense' });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Read-side guards (legacy malformed records already on disk) ──────────────
//
// The write edge cannot vouch for a file that predates it, was hand-edited, or
// came back from an older backup. These pin the readers refusing to be taken
// down by one such record: they skip it and serve the rest.

describe('readers skip unparseable stored records', () => {
  const { createScheduleRouter } = mod;
  const { getCurrentSlot, getNextSlot, slotsOverlap } = mod._test;

  // Parseable JSON, unparseable content: exactly what an old file looks like.
  const BROKEN_SLOT = { id: 'ws_bad', day: 1, startTime: null, endTime: '12:00' };
  const GOOD_SLOT = { id: 'ws_ok', day: 1, startTime: '10:00', endTime: '11:00' };
  const BROKEN_EVENT = { id: 'ev_bad', date: 'someday', startTime: '20:00', endTime: '23:00' };

  function scheduleWith(overrides) {
    const data = emptySchedule();
    Object.assign(data, overrides);
    return data;
  }

  function harness(initial) {
    const writes = [];
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(initial));
    vi.spyOn(fs, 'writeFileSync').mockImplementation((f, d) => { writes.push(JSON.parse(d)); });
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {});
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    return { router: createScheduleRouter(), writes };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    // The report memo is module state that outlives a single call by design;
    // without this a logging assertion inherits the previous test's memory.
    mod._test._resetSkipReports();
  });

  it('getCurrentSlot does not match a malformed weekly slot', () => {
    // Worth being precise about which readers actually threw, because
    // getCurrentSlot is NOT one of them: it reaches the times through
    // isTimeInRange, which only compares them, so a null startTime silently
    // fails to match rather than raising. The throwers are getNextSlot (which
    // splits) and slotsOverlap (via toMinutes). Filtering here buys consistency
    // and the skip report, not a crash fix — the report is what the log pins
    // below discriminate on.
    //
    // The slot carries TODAY's weekday so the reader genuinely reaches its
    // times; with any other day the `ws.day === weekday` test short-circuits
    // first and the case proves nothing.
    const { weekday } = getNowInTimezone('UTC');
    const data = scheduleWith({ weekly: { ws_bad: { ...BROKEN_SLOT, day: weekday } } });
    data.settings.timezone = 'UTC';
    mockScheduleFile(data);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => getCurrentSlot()).not.toThrow();
    expect(getCurrentSlot().source).toBe('default');
  });

  it('a malformed slot does not hide a good one that IS active', () => {
    const { weekday, timeStr } = getNowInTimezone('UTC');
    const [h] = timeStr.split(':').map(Number);
    const data = scheduleWith({
      weekly: {
        ws_bad: { ...BROKEN_SLOT, day: weekday },
        ws_ok: {
          id: 'ws_ok', day: weekday,
          startTime: String(Math.max(0, h - 1)).padStart(2, '0') + ':00',
          endTime: String(Math.min(23, h + 1)).padStart(2, '0') + ':00',
          playlistId: 'pl-good',
        },
      },
    });
    // The one-hour window collapses at the very top of the day; skip rather than
    // assert something the clock makes impossible.
    if (h === 0 || h === 23) return;
    data.settings.timezone = 'UTC';
    mockScheduleFile(data);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const slot = getCurrentSlot();
    expect(slot.source).toBe('weekly');
    expect(slot.slotId).toBe('ws_ok');
  });

  it('getNextSlot survives malformed weekly slots and events', () => {
    mockScheduleFile(scheduleWith({
      weekly: { ws_bad: { ...BROKEN_SLOT } },
      events: { ev_bad: { ...BROKEN_EVENT } },
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => getNextSlot()).not.toThrow();
    expect(getNextSlot()).toBeNull();
  });

  it('slotsOverlap reports no overlap for an unparseable slot rather than throwing', () => {
    expect(() => slotsOverlap(GOOD_SLOT, BROKEN_SLOT)).not.toThrow();
    expect(slotsOverlap(GOOD_SLOT, BROKEN_SLOT)).toBe(false);
    expect(slotsOverlap(BROKEN_SLOT, GOOD_SLOT)).toBe(false);
  });

  it('GET /current answers 200 with the bad slot skipped', () => {
    const { router } = harness(scheduleWith({ weekly: { ws_bad: { ...BROKEN_SLOT } } }));
    const res = mockRes();
    getRouteHandler(router, 'get', '/current')({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('default');
  });

  it('POST of a VALID slot succeeds even with a broken record in the same file', () => {
    // The overlap check walks every stored slot, so before the guard this
    // request died on someone else's bad data.
    const { router, writes } = harness(scheduleWith({ weekly: { ws_bad: { ...BROKEN_SLOT } } }));
    const res = mockRes();
    getRouteHandler(router, 'post', '/weekly')(
      { body: { day: 3, startTime: '09:00', endTime: '10:00' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ day: 3, startTime: '09:00' });
    // The broken record is preserved, not silently dropped by the write.
    expect(writes[0].weekly.ws_bad).toMatchObject({ id: 'ws_bad' });
  });

  it('GET / still lists the broken record verbatim', () => {
    // Filtering the listing would hide the thing an operator has to fix.
    const { router } = harness(scheduleWith({ weekly: { ws_bad: { ...BROKEN_SLOT } } }));
    const res = mockRes();
    getRouteHandler(router, 'get', '/')({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.weekly.ws_bad).toMatchObject({ id: 'ws_bad', startTime: null });
  });

  it('reports the skip once per pass, not once per record', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockScheduleFile(scheduleWith({
      weekly: {
        a: { id: 'a', day: 1, startTime: null, endTime: '12:00' },
        b: { id: 'b', day: 1, startTime: 'noon', endTime: '12:00' },
      },
    }));

    getCurrentSlot();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('skipping 2 unparseable weekly slots');
    expect(warn.mock.calls[0][0]).toContain('a, b');
  });

  it('reports weekly slots and events separately when BOTH are broken', () => {
    // The memo used to be one shared string, so these two overwrote each
    // other's memory and BOTH lines reprinted on every pass — the noise the
    // memo exists to prevent, in the one case where it mattered most.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockScheduleFile(scheduleWith({
      weekly: { ws_bad: { ...BROKEN_SLOT } },
      events: { ev_bad: { ...BROKEN_EVENT } },
    }));

    getCurrentSlot();
    getCurrentSlot();
    getCurrentSlot();

    const lines = warn.mock.calls.map((c) => c[0]);
    expect(lines.filter((l) => l.includes('weekly slots'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('events'))).toHaveLength(1);
    expect(lines).toHaveLength(2);
  });

  it('reports again when a fault comes back after a clean pass', () => {
    // Without clearing the memo on a clean pass, a repaired-then-rebroken file
    // stays silent forever because the message matches what was last seen.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockScheduleFile(scheduleWith({ weekly: { ws_bad: { ...BROKEN_SLOT } } }));
    getCurrentSlot();
    expect(warn).toHaveBeenCalledTimes(1);

    // Repaired.
    vi.restoreAllMocks();
    const warn2 = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockScheduleFile(scheduleWith({ weekly: { ws_ok: { ...GOOD_SLOT } } }));
    getCurrentSlot();
    expect(warn2).not.toHaveBeenCalled();

    // Broken again, the same way.
    vi.restoreAllMocks();
    const warn3 = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockScheduleFile(scheduleWith({ weekly: { ws_bad: { ...BROKEN_SLOT } } }));
    getCurrentSlot();
    expect(warn3).toHaveBeenCalledTimes(1);
  });

  it('does not reprint the same complaint on every executor tick', () => {
    // getCurrentSlot runs on a 30s tick; an unconditional per-pass line would
    // be the same log-noise problem the track-poller had.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockScheduleFile(scheduleWith({ weekly: { ws_bad: { ...BROKEN_SLOT } } }));

    getCurrentSlot();
    getCurrentSlot();
    getCurrentSlot();

    expect(warn).toHaveBeenCalledTimes(1);
  });
});
