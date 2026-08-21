import { formatDayHeader, formatEventTime } from './formatters';
import { toDateKey } from './layout';
import { SCHOOL_ACCENT_OVERLAY, type AssignmentDue, type CalendarEvent } from './types';

export function AgendaPanel({
  days,
  events,
  assignments,
  showAssignments,
  onSelectEvent,
}: {
  days: Date[];
  events: CalendarEvent[];
  assignments: AssignmentDue[];
  showAssignments: boolean;
  onSelectEvent: (event: CalendarEvent) => void;
}): React.JSX.Element {
  return (
    <aside
      data-testid="agenda-panel"
      className="flex w-64 shrink-0 flex-col gap-3 overflow-auto border-l p-3"
      style={{ borderColor: 'var(--color-border)' }}
    >
      {days.map((day) => {
        const key = toDateKey(day);
        const dayEvents = events.filter((event) =>
          event.isAllDay ? event.startAt <= key && key < event.endAt : toDateKey(new Date(event.startAt)) === key
        );
        const dayAssignments = showAssignments
          ? assignments.filter((item) => toDateKey(new Date(item.dueAt)) === key)
          : [];
        if (dayEvents.length === 0 && dayAssignments.length === 0) return null;

        return (
          <section key={key} className="flex flex-col gap-1">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
              {formatDayHeader(day)}
            </h3>
            {dayEvents.map((event) => (
              <button
                key={`${event.calendarId}:${event.id}`}
                type="button"
                onClick={() => onSelectEvent(event)}
                className="rounded-md px-2 py-1 text-left text-xs"
                style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
              >
                <span className="block truncate" style={{ color: 'var(--color-text)' }}>
                  {event.summary ?? 'Untitled'}
                </span>
                <span style={{ color: 'var(--color-text-muted)' }}>{formatEventTime(event)}</span>
              </button>
            ))}
            {dayAssignments.map((item) => (
              <div
                key={item.id}
                className="rounded-md px-2 py-1 text-xs"
                style={{ border: `1px dashed ${SCHOOL_ACCENT_OVERLAY}`, color: SCHOOL_ACCENT_OVERLAY }}
              >
                <span className="block truncate">{item.name}</span>
                <span className="opacity-80">{item.courseName} · due</span>
              </div>
            ))}
          </section>
        );
      })}
    </aside>
  );
}
