import { useState } from 'react';
import { fromDateTimeInputValue, toDateInputValue, toDateTimeInputValue } from './inputs';
import type { CalendarEvent, CalendarRow, EventDraft } from './types';

const HOUR_MS = 3_600_000;

function nextDay(dateValue: string): string {
  const [year, month, day] = dateValue.split('-').map(Number);
  const date = new Date(year, month - 1, day + 1);
  return toDateInputValue(date.toISOString());
}

export function EventDialog({
  calendars,
  event,
  slotStart,
  onClose,
  onSaved,
}: {
  calendars: CalendarRow[];
  event?: CalendarEvent;
  slotStart?: Date;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const isEdit = event !== undefined;
  const defaultStart = slotStart ?? new Date();
  const defaultEnd = new Date(defaultStart.getTime() + HOUR_MS);

  const [calendarId, setCalendarId] = useState(
    event?.calendarId ?? calendars.find((c) => c.isPrimary)?.id ?? calendars[0]?.id ?? ''
  );
  const [summary, setSummary] = useState(event?.summary ?? '');
  const [location, setLocation] = useState(event?.location ?? '');
  const [isAllDay, setIsAllDay] = useState(event?.isAllDay ?? false);
  const [startValue, setStartValue] = useState(
    event ? toDateTimeInputValue(event.isAllDay ? `${event.startAt}T00:00` : event.startAt)
          : toDateTimeInputValue(defaultStart.toISOString())
  );
  const [endValue, setEndValue] = useState(
    event ? toDateTimeInputValue(event.isAllDay ? `${event.endAt}T00:00` : event.endAt)
          : toDateTimeInputValue(defaultEnd.toISOString())
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function buildDraft(): EventDraft {
    if (isAllDay) {
      const startDate = toDateInputValue(startValue);
      const endDate = toDateInputValue(endValue);
      return {
        calendarId,
        summary,
        location: location.length > 0 ? location : undefined,
        isAllDay: true,
        startAt: startDate,
        // Google's all-day end is exclusive, so a single-day event ends the
        // following day.
        endAt: endDate > startDate ? endDate : nextDay(startDate),
      };
    }
    return {
      calendarId,
      summary,
      location: location.length > 0 ? location : undefined,
      isAllDay: false,
      startAt: fromDateTimeInputValue(startValue),
      endAt: fromDateTimeInputValue(endValue),
    };
  }

  async function handleSave(): Promise<void> {
    setError('');
    setSaving(true);
    try {
      const draft = buildDraft();
      const result = isEdit
        ? await window.smartlife.calendar.updateEvent(event.id, draft)
        : await window.smartlife.calendar.createEvent(draft);
      if (!result.ok) {
        // Staying open on failure is deliberate: closing would read as success.
        setError(result.error ?? 'Could not save the event.');
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setError('');
    setSaving(true);
    try {
      const result = await window.smartlife.calendar.deleteEvent(event!.calendarId, event!.id);
      if (!result.ok) {
        setError(result.error ?? 'Could not delete the event.');
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  const fieldStyle = {
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-text)',
    border: '1px solid var(--color-border)',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
      <div
        role="dialog"
        aria-label={isEdit ? 'Edit event' : 'New event'}
        className="flex w-96 flex-col gap-3 rounded-lg p-4"
        style={{ backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
      >
        <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Title
          <input value={summary} onChange={(e) => setSummary(e.target.value)} className="rounded-md px-2 py-1 text-sm" style={fieldStyle} />
        </label>

        <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Calendar
          <select value={calendarId} onChange={(e) => setCalendarId(e.target.value)} className="rounded-md px-2 py-1 text-sm" style={fieldStyle}>
            {calendars.map((row) => (
              <option key={row.id} value={row.id}>{row.summary}</option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <input type="checkbox" checked={isAllDay} onChange={(e) => setIsAllDay(e.target.checked)} />
          All day
        </label>

        <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Starts
          <input type={isAllDay ? 'date' : 'datetime-local'} value={isAllDay ? toDateInputValue(startValue) : startValue} onChange={(e) => setStartValue(e.target.value)} className="rounded-md px-2 py-1 text-sm" style={fieldStyle} />
        </label>

        <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Ends
          <input type={isAllDay ? 'date' : 'datetime-local'} value={isAllDay ? toDateInputValue(endValue) : endValue} onChange={(e) => setEndValue(e.target.value)} className="rounded-md px-2 py-1 text-sm" style={fieldStyle} />
        </label>

        <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Location
          <input value={location} onChange={(e) => setLocation(e.target.value)} className="rounded-md px-2 py-1 text-sm" style={fieldStyle} />
        </label>

        {error.length > 0 && (
          <p role="alert" className="text-xs" style={{ color: '#EF4444' }}>{error}</p>
        )}

        {confirmingDelete && (
          <div data-testid="delete-confirm" className="rounded-md px-2 py-1.5 text-xs" style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
            {event!.hasGuests
              ? `Delete this event? ${event!.guestCount} guests will be notified.`
              : 'Delete this event?'}
            <div className="mt-1.5 flex gap-2">
              <button type="button" onClick={() => void handleDelete()} className="rounded px-2 py-1" style={{ backgroundColor: '#EF4444', color: '#FFFFFF' }}>
                Delete event
              </button>
              <button type="button" onClick={() => setConfirmingDelete(false)} className="rounded px-2 py-1" style={{ border: '1px solid var(--color-border)' }}>
                Keep it
              </button>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          {isEdit && !confirmingDelete ? (
            <button type="button" onClick={() => setConfirmingDelete(true)} className="rounded px-2 py-1 text-sm" style={{ color: '#EF4444', border: '1px solid var(--color-border)' }}>
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded px-2 py-1 text-sm" style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
              Cancel
            </button>
            <button type="button" disabled={saving} onClick={() => void handleSave()} className="rounded px-3 py-1 text-sm" style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)' }}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
