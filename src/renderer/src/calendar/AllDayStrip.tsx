import { eventDayKeys, toDateKey } from './layout';
import { CALENDAR_ACCENT, type CalendarEvent } from './types';

export function AllDayStrip({
  days,
  events,
  onSelectEvent,
}: {
  days: Date[];
  events: CalendarEvent[];
  onSelectEvent: (event: CalendarEvent) => void;
}): React.JSX.Element {
  const allDay = events.filter((event) => event.isAllDay);

  return (
    <div
      data-testid="all-day-strip"
      className="grid border-b"
      style={{ gridTemplateColumns: '3.5rem repeat(7, minmax(0, 1fr))', borderColor: 'var(--color-border)' }}
    >
      <div className="px-1 py-1 text-right text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
        all day
      </div>
      {days.map((day) => {
        const key = toDateKey(day);
        // A multi-day event appears in every column it spans, which is why
        // eventDayKeys returns a list rather than a single day.
        const dayEvents = allDay.filter((event) => eventDayKeys(event).includes(key));
        return (
          <div key={key} className="min-h-[1.75rem] px-0.5 py-0.5">
            {dayEvents.map((event) => (
              <button
                key={`${event.calendarId}:${event.id}`}
                type="button"
                onClick={() => onSelectEvent(event)}
                className="mb-0.5 block w-full truncate rounded px-1 py-0.5 text-left text-[11px]"
                style={{ backgroundColor: CALENDAR_ACCENT, color: '#FFFFFF' }}
              >
                {event.summary ?? 'Untitled'}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
