import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EventDialog } from './EventDialog';
import type { CalendarEvent, CalendarRow } from './types';

const calendar = {
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
};

const CALENDARS: CalendarRow[] = [
  { id: 'cal-1', summary: 'Personal', backgroundColor: null, isPrimary: true, enabled: true },
];

function existing(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    calendarId: 'cal-1',
    id: 'evt-1',
    summary: 'Standup',
    description: null,
    location: null,
    startAt: new Date(2026, 7, 21, 9, 0).toISOString(),
    endAt: new Date(2026, 7, 21, 9, 30).toISOString(),
    isAllDay: false,
    htmlLink: null,
    hasGuests: false,
    guestCount: 0,
    etag: '"tag"',
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'smartlife', {
    value: { calendar },
    writable: true,
    configurable: true,
  });
  // Reset call history too, not just the resolved value: the mocks are
  // module-scoped and shared across every test in this file, so without a
  // reset a later test's mock.calls[0] would silently read an earlier test's
  // call.
  calendar.createEvent.mockReset().mockResolvedValue({ ok: true, eventId: 'new-1' });
  calendar.updateEvent.mockReset().mockResolvedValue({ ok: true });
  calendar.deleteEvent.mockReset().mockResolvedValue({ ok: true });
});

describe('EventDialog create mode', () => {
  it('creates an event from the form values', async () => {
    const onSaved = vi.fn();
    render(
      <EventDialog
        calendars={CALENDARS}
        slotStart={new Date(2026, 7, 21, 14, 0)}
        onClose={() => {}}
        onSaved={onSaved}
      />
    );

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Study block' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calendar.createEvent).toHaveBeenCalledTimes(1));
    const draft = calendar.createEvent.mock.calls[0][0];
    expect(draft.summary).toBe('Study block');
    expect(draft.calendarId).toBe('cal-1');
    expect(draft.isAllDay).toBe(false);
    expect(onSaved).toHaveBeenCalled();
  });

  it('switches to bare dates when all-day is checked', async () => {
    render(
      <EventDialog
        calendars={CALENDARS}
        slotStart={new Date(2026, 7, 21, 14, 0)}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Holiday' } });
    fireEvent.click(screen.getByLabelText('All day'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calendar.createEvent).toHaveBeenCalled());
    const draft = calendar.createEvent.mock.calls[0][0];
    expect(draft.isAllDay).toBe(true);
    // Sending a timestamp here would make Google store a midnight timed event.
    expect(draft.startAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('shows the error the main process returned instead of closing', async () => {
    calendar.createEvent.mockResolvedValue({ ok: false, error: "You're offline — this change wasn't saved." });
    const onSaved = vi.fn();
    render(
      <EventDialog calendars={CALENDARS} slotStart={new Date()} onClose={() => {}} onSaved={onSaved} />
    );

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/offline/i);
    // Closing on failure would make the user think the event saved.
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('EventDialog edit mode', () => {
  it('prefills from the event and updates it', async () => {
    render(
      <EventDialog calendars={CALENDARS} event={existing()} onClose={() => {}} onSaved={() => {}} />
    );

    expect(screen.getByLabelText('Title')).toHaveValue('Standup');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Standup (moved)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calendar.updateEvent).toHaveBeenCalledTimes(1));
    expect(calendar.updateEvent.mock.calls[0][0]).toBe('evt-1');
    expect(calendar.updateEvent.mock.calls[0][1].summary).toBe('Standup (moved)');
  });

  it('warns before deleting an event with guests', async () => {
    render(
      <EventDialog
        calendars={CALENDARS}
        event={existing({ hasGuests: true, guestCount: 3 })}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    // Deleting a shared event emails everyone on it; that has to be said out
    // loud before it happens.
    expect(screen.getByTestId('delete-confirm')).toHaveTextContent('3 guests');
    fireEvent.click(screen.getByRole('button', { name: 'Delete event' }));
    await waitFor(() => expect(calendar.deleteEvent).toHaveBeenCalledWith('cal-1', 'evt-1'));
  });

  it('does not offer delete in create mode', () => {
    render(
      <EventDialog calendars={CALENDARS} slotStart={new Date()} onClose={() => {}} onSaved={() => {}} />
    );
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});
