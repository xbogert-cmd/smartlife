import { describe, expect, it } from 'vitest';
import { formatDayHeader, formatEventRange, formatEventTime, formatHourLabel, formatRelative } from './formatters';
import type { CalendarEvent } from './types';

function event(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    calendarId: 'cal-1',
    id: 'e1',
    summary: 'Event',
    description: null,
    location: null,
    startAt: new Date(2026, 7, 21, 14, 0).toISOString(),
    endAt: new Date(2026, 7, 21, 15, 30).toISOString(),
    isAllDay: false,
    htmlLink: null,
    hasGuests: false,
    guestCount: 0,
    etag: null,
    ...overrides,
  };
}

describe('formatHourLabel', () => {
  it('formats midday and midnight without a zero hour', () => {
    expect(formatHourLabel(0)).toBe('12 AM');
    expect(formatHourLabel(9)).toBe('9 AM');
    expect(formatHourLabel(12)).toBe('12 PM');
    expect(formatHourLabel(18)).toBe('6 PM');
  });
});

describe('formatDayHeader', () => {
  it('shows the weekday and day number', () => {
    expect(formatDayHeader(new Date(2026, 7, 21))).toBe('Fri 21');
  });
});

describe('formatEventTime', () => {
  it('renders a timed range', () => {
    expect(formatEventTime(event({}))).toBe('2:00 – 3:30 PM');
  });

  it('renders a range that crosses noon with both meridiems', () => {
    const crossing = event({
      startAt: new Date(2026, 7, 21, 11, 0).toISOString(),
      endAt: new Date(2026, 7, 21, 13, 0).toISOString(),
    });
    expect(formatEventTime(crossing)).toBe('11:00 AM – 1:00 PM');
  });

  it('says All day for an all-day event', () => {
    expect(formatEventTime(event({ isAllDay: true, startAt: '2026-08-21', endAt: '2026-08-22' }))).toBe(
      'All day'
    );
  });
});

describe('formatEventRange', () => {
  it('includes the date for use in confirmation prompts', () => {
    expect(formatEventRange(event({}))).toBe('Fri Aug 21, 2:00 – 3:30 PM');
  });

  it('formats an all-day event by date without inventing a time', () => {
    const allDay = event({ isAllDay: true, startAt: '2026-08-21', endAt: '2026-08-22' });
    expect(formatEventRange(allDay)).toBe('Fri Aug 21, all day');
  });
});

describe('formatRelative', () => {
  it('describes recent syncs and never', () => {
    const now = new Date(2026, 7, 21, 12, 0);
    expect(formatRelative(null, now)).toBe('never');
    expect(formatRelative(new Date(2026, 7, 21, 11, 57).toISOString(), now)).toBe('3 min ago');
    expect(formatRelative(new Date(2026, 7, 21, 9, 0).toISOString(), now)).toBe('3 hr ago');
  });
});
