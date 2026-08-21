import { describe, expect, it } from 'vitest';
import {
  GRID_END_HOUR,
  GRID_START_HOUR,
  eventDayKeys,
  layoutDayEvents,
  minutesToPercent,
  parseAllDayDate,
  startOfWeek,
  toDateKey,
  weekDays,
} from './layout';
import type { CalendarEvent } from './types';

function timed(id: string, start: string, end: string): CalendarEvent {
  return {
    calendarId: 'cal-1',
    id,
    summary: id,
    description: null,
    location: null,
    startAt: start,
    endAt: end,
    isAllDay: false,
    htmlLink: null,
    hasGuests: false,
    guestCount: 0,
    etag: null,
  };
}

function allDay(id: string, start: string, end: string): CalendarEvent {
  return { ...timed(id, start, end), isAllDay: true };
}

describe('toDateKey', () => {
  it('uses local date parts, not the UTC date', () => {
    // 8pm on the 21st in a US timezone is the 22nd in UTC. Reading the UTC
    // date would file this event under the wrong day column.
    const evening = new Date(2026, 7, 21, 20, 30);
    expect(toDateKey(evening)).toBe('2026-08-21');
  });

  it('zero-pads single-digit months and days', () => {
    expect(toDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('parseAllDayDate', () => {
  it('parses a bare date at local midnight, not UTC midnight', () => {
    const parsed = parseAllDayDate('2026-08-21');
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(7);
    // new Date('2026-08-21') would be UTC midnight, which reads back as the
    // 20th anywhere west of Greenwich.
    expect(parsed.getDate()).toBe(21);
    expect(parsed.getHours()).toBe(0);
  });

  it('round-trips through toDateKey', () => {
    expect(toDateKey(parseAllDayDate('2026-01-01'))).toBe('2026-01-01');
  });
});

describe('startOfWeek and weekDays', () => {
  it('returns the preceding Sunday at local midnight', () => {
    // 2026-08-20 is a Thursday.
    const start = startOfWeek(new Date(2026, 7, 20, 14, 0));
    expect(toDateKey(start)).toBe('2026-08-16');
    expect(start.getHours()).toBe(0);
  });

  it('returns the same day when already Sunday', () => {
    expect(toDateKey(startOfWeek(new Date(2026, 7, 16, 23, 0)))).toBe('2026-08-16');
  });

  it('produces seven consecutive days', () => {
    const days = weekDays(startOfWeek(new Date(2026, 7, 20)));
    expect(days).toHaveLength(7);
    expect(days.map(toDateKey)).toEqual([
      '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19',
      '2026-08-20', '2026-08-21', '2026-08-22',
    ]);
  });

  it('crosses a month boundary correctly', () => {
    const days = weekDays(startOfWeek(new Date(2026, 7, 31)));
    expect(days.map(toDateKey)).toContain('2026-09-05');
  });
});

describe('eventDayKeys', () => {
  it('returns one key for a single-day timed event', () => {
    const event = timed('a', '2026-08-21T14:00:00.000Z', '2026-08-21T15:00:00.000Z');
    expect(eventDayKeys(event)).toEqual([toDateKey(new Date(event.startAt))]);
  });

  it('spans every day of a multi-day all-day event, excluding Google exclusive end', () => {
    // Google stores a Mon-Wed all-day event with end = Thursday.
    const event = allDay('trip', '2026-08-17', '2026-08-20');
    expect(eventDayKeys(event)).toEqual(['2026-08-17', '2026-08-18', '2026-08-19']);
  });

  it('handles a single-day all-day event', () => {
    expect(eventDayKeys(allDay('h', '2026-08-21', '2026-08-22'))).toEqual(['2026-08-21']);
  });

  it('tolerates an all-day event whose end equals its start', () => {
    // Malformed but seen in the wild; must still render on one day.
    expect(eventDayKeys(allDay('h', '2026-08-21', '2026-08-21'))).toEqual(['2026-08-21']);
  });
});

describe('minutesToPercent', () => {
  it('maps the grid start to 0 and the grid end to 100', () => {
    expect(minutesToPercent(GRID_START_HOUR * 60)).toBe(0);
    expect(minutesToPercent(GRID_END_HOUR * 60)).toBe(100);
  });

  it('clamps times outside the visible grid', () => {
    // A 3am event must not render at a negative offset and escape the grid.
    expect(minutesToPercent(3 * 60)).toBe(0);
    expect(minutesToPercent(25 * 60)).toBe(100);
  });
});

describe('layoutDayEvents', () => {
  it('gives a lone event the full width', () => {
    const positioned = layoutDayEvents([
      timed('a', new Date(2026, 7, 21, 9, 0).toISOString(), new Date(2026, 7, 21, 10, 0).toISOString()),
    ]);

    expect(positioned).toHaveLength(1);
    expect(positioned[0].columnCount).toBe(1);
    expect(positioned[0].columnIndex).toBe(0);
    expect(positioned[0].heightPct).toBeGreaterThan(0);
  });

  it('splits two overlapping events into side-by-side columns', () => {
    const positioned = layoutDayEvents([
      timed('a', new Date(2026, 7, 21, 9, 0).toISOString(), new Date(2026, 7, 21, 11, 0).toISOString()),
      timed('b', new Date(2026, 7, 21, 10, 0).toISOString(), new Date(2026, 7, 21, 12, 0).toISOString()),
    ]);

    expect(positioned.every((p) => p.columnCount === 2)).toBe(true);
    expect(positioned.map((p) => p.columnIndex).sort()).toEqual([0, 1]);
  });

  it('keeps non-overlapping events full width', () => {
    const positioned = layoutDayEvents([
      timed('a', new Date(2026, 7, 21, 9, 0).toISOString(), new Date(2026, 7, 21, 10, 0).toISOString()),
      timed('b', new Date(2026, 7, 21, 11, 0).toISOString(), new Date(2026, 7, 21, 12, 0).toISOString()),
    ]);

    // Two meetings that do not overlap should not each be squeezed to half
    // width just because they share a day.
    expect(positioned.every((p) => p.columnCount === 1)).toBe(true);
  });

  it('treats back-to-back events as non-overlapping', () => {
    const positioned = layoutDayEvents([
      timed('a', new Date(2026, 7, 21, 9, 0).toISOString(), new Date(2026, 7, 21, 10, 0).toISOString()),
      timed('b', new Date(2026, 7, 21, 10, 0).toISOString(), new Date(2026, 7, 21, 11, 0).toISOString()),
    ]);

    expect(positioned.every((p) => p.columnCount === 1)).toBe(true);
  });

  it('chains a three-way overlap into three columns', () => {
    const positioned = layoutDayEvents([
      timed('a', new Date(2026, 7, 21, 9, 0).toISOString(), new Date(2026, 7, 21, 12, 0).toISOString()),
      timed('b', new Date(2026, 7, 21, 10, 0).toISOString(), new Date(2026, 7, 21, 11, 0).toISOString()),
      timed('c', new Date(2026, 7, 21, 10, 30).toISOString(), new Date(2026, 7, 21, 11, 30).toISOString()),
    ]);

    expect(positioned.every((p) => p.columnCount === 3)).toBe(true);
  });

  it('gives a zero-length event a visible minimum height', () => {
    const at = new Date(2026, 7, 21, 9, 0).toISOString();
    const positioned = layoutDayEvents([timed('a', at, at)]);

    // A zero-height block is invisible and unclickable.
    expect(positioned[0].heightPct).toBeGreaterThan(0);
  });
});
