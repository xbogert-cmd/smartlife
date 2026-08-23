import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Calendar } from './Calendar';

const calendar = {
  getStatus: vi.fn(),
  listCalendars: vi.fn(),
  getEvents: vi.fn(),
  getAssignments: vi.fn(),
  syncNow: vi.fn(),
  setCalendarEnabled: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  onSyncChanged: vi.fn().mockReturnValue(() => {}),
};

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientConfigured: true,
    connected: true,
    accountEmail: 'me@example.com',
    lastSyncedAt: new Date().toISOString(),
    tokenInvalid: false,
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const start = new Date();
  start.setHours(10, 0, 0, 0);
  const end = new Date(start);
  end.setHours(11, 0, 0, 0);
  return {
    calendarId: 'cal-1',
    id: 'e1',
    summary: 'Physics lecture',
    description: null,
    location: null,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    isAllDay: false,
    htmlLink: null,
    hasGuests: false,
    guestCount: 0,
    etag: null,
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'smartlife', {
    value: { calendar },
    writable: true,
    configurable: true,
  });
  calendar.getStatus.mockResolvedValue(status());
  calendar.listCalendars.mockResolvedValue([]);
  calendar.getEvents.mockResolvedValue([]);
  calendar.getAssignments.mockResolvedValue([]);
});

function renderCalendar(): void {
  render(
    <MemoryRouter>
      <Calendar />
    </MemoryRouter>
  );
}

function LocationProbe({ onChange }: { onChange: (search: string) => void }): null {
  onChange(useLocation().search);
  return null;
}

function renderCalendarWithLocationProbe(onChange: (search: string) => void): void {
  render(
    <MemoryRouter>
      <Calendar />
      <LocationProbe onChange={onChange} />
    </MemoryRouter>
  );
}

describe('Calendar', () => {
  it('shows the connect prompt while status is still loading', () => {
    renderCalendar();
    // Same prompt as the not-connected state, so there is no flash of an
    // empty grid before status resolves.
    expect(screen.getByText(/connect google calendar/i)).toBeInTheDocument();
  });

  it('shows the connect prompt when not connected', async () => {
    calendar.getStatus.mockResolvedValue(status({ connected: false }));
    renderCalendar();
    expect(await screen.findByText(/connect google calendar/i)).toBeInTheDocument();
  });

  it('renders the seven day columns once connected', async () => {
    renderCalendar();
    await screen.findByRole('button', { name: /today/i });
    expect(screen.getByTestId('week-grid').querySelectorAll('[data-day-column]')).toHaveLength(7);
  });

  it('renders a timed event in the grid', async () => {
    calendar.getEvents.mockResolvedValue([event()]);
    renderCalendar();
    // The same event also appears in the agenda panel, so scope the query to
    // the week grid rather than asserting a single match document-wide.
    const grid = await screen.findByTestId('week-grid');
    expect(await within(grid).findByText('Physics lecture')).toBeInTheDocument();
  });

  it('renders an all-day event in the all-day strip, not the timed grid', async () => {
    const today = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const key = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const nextKey = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
    calendar.getEvents.mockResolvedValue([
      event({ id: 'a1', summary: 'Holiday', isAllDay: true, startAt: key, endAt: nextKey }),
    ]);

    renderCalendar();

    const strip = await screen.findByTestId('all-day-strip');
    expect(strip).toHaveTextContent('Holiday');
    expect(screen.getByTestId('week-grid')).not.toHaveTextContent('Holiday');
  });

  it('renders Canvas due dates as a distinct overlay', async () => {
    const due = new Date();
    due.setHours(23, 59, 0, 0);
    calendar.getAssignments.mockResolvedValue([
      { id: 5, courseId: 1, courseName: 'BIO 101', name: 'Lab 3', dueAt: due.toISOString() },
    ]);

    renderCalendar();

    const chip = await screen.findByTestId('assignment-chip-5');
    expect(chip).toHaveTextContent('Lab 3');
  });

  it('works with Canvas disconnected', async () => {
    calendar.getAssignments.mockResolvedValue([]);
    calendar.getEvents.mockResolvedValue([event()]);
    renderCalendar();
    // Calendar must not depend on Canvas at runtime. The event legitimately
    // renders in both the grid and the agenda panel, so assert at least one.
    expect((await screen.findAllByText('Physics lecture')).length).toBeGreaterThan(0);
  });

  it('shows the reconnect banner when the token is invalid', async () => {
    calendar.getStatus.mockResolvedValue(status({ tokenInvalid: true }));
    calendar.getEvents.mockResolvedValue([event()]);
    renderCalendar();

    expect(await screen.findByRole('alert')).toHaveTextContent(/reconnect/i);
    // A dead token means stale data, never a blank screen. The event
    // legitimately renders in both the grid and the agenda panel.
    expect(screen.getAllByText('Physics lecture').length).toBeGreaterThan(0);
  });

  it('lists upcoming items in the agenda panel', async () => {
    calendar.getEvents.mockResolvedValue([event()]);
    renderCalendar();

    const agenda = await screen.findByTestId('agenda-panel');
    expect(agenda).toHaveTextContent('Physics lecture');
  });

  it('refetches when the week changes', async () => {
    renderCalendar();
    await screen.findByRole('button', { name: /today/i });
    const before = calendar.getEvents.mock.calls.length;

    screen.getByRole('button', { name: /next week/i }).click();

    await vi.waitFor(() => {
      expect(calendar.getEvents.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it('puts the selected event id in the URL so useViewContext can see it', async () => {
    calendar.getEvents.mockResolvedValue([event({ id: 'e1' })]);
    let search = '';
    renderCalendarWithLocationProbe((value) => {
      search = value;
    });

    const grid = await screen.findByTestId('week-grid');
    (await within(grid).findByRole('button', { name: /physics lecture/i })).click();

    await vi.waitFor(() => expect(search).toBe('?event=e1'));
  });

  it('clears the event id from the URL when the dialog is closed', async () => {
    calendar.getEvents.mockResolvedValue([event({ id: 'e1' })]);
    let search = '';
    renderCalendarWithLocationProbe((value) => {
      search = value;
    });

    const grid = await screen.findByTestId('week-grid');
    (await within(grid).findByRole('button', { name: /physics lecture/i })).click();
    await vi.waitFor(() => expect(search).toBe('?event=e1'));

    screen.getByRole('button', { name: /^cancel$/i }).click();

    await vi.waitFor(() => expect(search).toBe(''));
  });
});
