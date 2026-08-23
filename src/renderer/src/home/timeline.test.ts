import { describe, expect, it } from 'vitest';
import { buildToday } from './timeline';
import type { CalendarEvent } from '../calendar/types';
import type { UpcomingAssignment } from '../school/types';

// Local noon, so nothing in these fixtures straddles a UTC date boundary by
// accident and hides a real bug.
const NOW = new Date(2026, 7, 22, 12, 0, 0);

function event(overrides: Partial<CalendarEvent> & { startAt: string; endAt: string }): CalendarEvent {
  return {
    calendarId: 'primary',
    id: 'e1',
    summary: 'Event',
    description: null,
    location: null,
    isAllDay: false,
    htmlLink: null,
    hasGuests: false,
    guestCount: 0,
    etag: null,
    ...overrides,
  };
}

function assignment(overrides: Partial<UpcomingAssignment> & { dueAt: string }): UpcomingAssignment {
  return {
    id: 1,
    courseId: 1,
    courseName: 'Course',
    name: 'Assignment',
    pointsPossible: 10,
    hasSubmitted: false,
    htmlUrl: null,
    ...overrides,
  };
}

function iso(hour: number, minute = 0, day = 22): string {
  return new Date(2026, 7, day, hour, minute, 0).toISOString();
}

describe('buildToday', () => {
  it('includes a timed event happening today', () => {
    const items = buildToday([event({ id: 'a', summary: 'Lecture', startAt: iso(14), endAt: iso(15) })], [], NOW);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('event');
  });

  it('includes an assignment due today', () => {
    const items = buildToday([], [assignment({ dueAt: iso(23, 59) })], NOW);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('due');
  });

  it('excludes an event on another day', () => {
    const items = buildToday([event({ startAt: iso(14, 0, 23), endAt: iso(15, 0, 23) })], [], NOW);
    expect(items).toHaveLength(0);
  });

  it('excludes an assignment due on another day', () => {
    const items = buildToday([], [assignment({ dueAt: iso(9, 0, 21) })], NOW);
    expect(items).toHaveLength(0);
  });

  it('keeps a late-evening event on today, not tomorrow', () => {
    // The UTC date of an 11pm local timestamp west of Greenwich is already
    // tomorrow. Using the UTC date here would drop this item.
    const items = buildToday([event({ startAt: iso(23, 30), endAt: iso(23, 45) })], [], NOW);
    expect(items).toHaveLength(1);
  });

  it('keeps a just-after-midnight event on today', () => {
    const items = buildToday([event({ startAt: iso(0, 15), endAt: iso(1, 0) })], [], NOW);
    expect(items).toHaveLength(1);
  });

  it('sorts by time ascending', () => {
    const items = buildToday(
      [
        event({ id: 'late', summary: 'Late', startAt: iso(16), endAt: iso(17) }),
        event({ id: 'early', summary: 'Early', startAt: iso(9), endAt: iso(10) }),
      ],
      [],
      NOW
    );
    expect(items.map((item) => (item.kind === 'event' ? item.event.summary : null))).toEqual(['Early', 'Late']);
  });

  it('puts all-day events before timed ones', () => {
    const items = buildToday(
      [
        event({ id: 'timed', summary: 'Timed', startAt: iso(8), endAt: iso(9) }),
        event({ id: 'allday', summary: 'Holiday', isAllDay: true, startAt: '2026-08-22', endAt: '2026-08-23' }),
      ],
      [],
      NOW
    );
    expect(items.map((item) => (item.kind === 'event' ? item.event.summary : null))).toEqual(['Holiday', 'Timed']);
  });

  it("respects Google's exclusive all-day end date", () => {
    // An all-day event on the 21st ends on the 22nd. It is NOT a 22nd event.
    const items = buildToday(
      [event({ isAllDay: true, startAt: '2026-08-21', endAt: '2026-08-22' })],
      [],
      NOW
    );
    expect(items).toHaveLength(0);
  });

  it('puts an event before a due time at the same instant', () => {
    const at = iso(15);
    const items = buildToday([event({ startAt: at, endAt: iso(16) })], [assignment({ dueAt: at })], NOW);
    expect(items.map((item) => item.kind)).toEqual(['event', 'due']);
  });

  it('drops an item with an unparseable timestamp instead of corrupting the sort', () => {
    const items = buildToday(
      [event({ startAt: 'not a date', endAt: 'not a date' })],
      [assignment({ dueAt: 'also not a date' })],
      NOW
    );
    expect(items).toHaveLength(0);
  });

  it('keeps a submitted assignment, marked as submitted', () => {
    // Removing it would make a finished day look empty rather than finished.
    const items = buildToday([], [assignment({ dueAt: iso(17), hasSubmitted: true })], NOW);
    expect(items).toHaveLength(1);
    expect(items[0].kind === 'due' && items[0].assignment.hasSubmitted).toBe(true);
  });
});
