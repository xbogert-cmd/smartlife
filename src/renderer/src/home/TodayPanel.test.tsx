import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TodayPanel } from './TodayPanel';
import type { TodayItem } from './timeline';

function eventItem(summary: string, allDay = false): TodayItem {
  return {
    kind: 'event',
    at: new Date(2026, 7, 22, 14, 0).getTime(),
    allDay,
    event: {
      calendarId: 'primary',
      id: 'e1',
      summary,
      description: null,
      location: null,
      startAt: new Date(2026, 7, 22, 14, 0).toISOString(),
      endAt: new Date(2026, 7, 22, 15, 0).toISOString(),
      isAllDay: allDay,
      htmlLink: null,
      hasGuests: false,
      guestCount: 0,
      etag: null,
    },
  };
}

function dueItem(name: string, hasSubmitted = false): TodayItem {
  return {
    kind: 'due',
    at: new Date(2026, 7, 22, 23, 59).getTime(),
    assignment: {
      id: 42,
      courseId: 1,
      courseName: 'Financial Accounting',
      name,
      dueAt: new Date(2026, 7, 22, 23, 59).toISOString(),
      pointsPossible: 20,
      hasSubmitted,
      htmlUrl: null,
    },
  };
}

function dueItemAt(hour: number, minute: number): TodayItem {
  const at = new Date(2026, 7, 22, hour, minute).getTime();
  return {
    kind: 'due',
    at,
    assignment: {
      id: 42,
      courseId: 1,
      courseName: 'Financial Accounting',
      name: 'Timed lab',
      dueAt: new Date(at).toISOString(),
      pointsPossible: 20,
      hasSubmitted: false,
      htmlUrl: null,
    },
  };
}

function renderPanel(items: TodayItem[]) {
  return render(
    <MemoryRouter>
      <TodayPanel items={items} />
    </MemoryRouter>
  );
}

describe('TodayPanel', () => {
  it('renders an event summary', () => {
    renderPanel([eventItem('Accounting lecture')]);
    expect(screen.getByText('Accounting lecture')).toBeTruthy();
  });

  it('renders an assignment name and its course', () => {
    renderPanel([dueItem('Chapter 4 homework')]);
    expect(screen.getByText('Chapter 4 homework')).toBeTruthy();
    expect(screen.getByText(/Financial Accounting/)).toBeTruthy();
  });

  it('links an assignment to its workspace', () => {
    renderPanel([dueItem('Chapter 4 homework')]);
    const link = screen.getByRole('link', { name: /Chapter 4 homework/ });
    expect(link.getAttribute('href')).toBe('/assignment/42');
  });

  it('marks a submitted assignment as submitted', () => {
    renderPanel([dueItem('Already done', true)]);
    expect(screen.getByText(/submitted/i)).toBeTruthy();
  });

  it('labels an all-day event rather than showing a time range', () => {
    renderPanel([eventItem('Reading day', true)]);
    expect(screen.getByText(/all day/i)).toBeTruthy();
  });

  it('says the day is clear when there is nothing on it', () => {
    renderPanel([]);
    expect(screen.getByText(/nothing scheduled/i)).toBeTruthy();
  });

  it('renders 12:15 AM for a due item just after midnight', () => {
    // hours % 12 === 0 at midnight -- the branch timeLabel uses to avoid
    // printing "0:15 AM" -- had no coverage at all before this.
    renderPanel([dueItemAt(0, 15)]);
    expect(screen.getByText('12:15 AM')).toBeTruthy();
  });

  it('renders 12:05 PM for a due item just after noon', () => {
    renderPanel([dueItemAt(12, 5)]);
    expect(screen.getByText('12:05 PM')).toBeTruthy();
  });

  it('renders an untitled event without printing null', () => {
    const item = eventItem('placeholder');
    if (item.kind === 'event') item.event.summary = null;
    renderPanel([item]);
    expect(screen.queryByText('null')).toBeNull();
  });
});
