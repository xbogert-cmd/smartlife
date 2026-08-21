import { formatHourLabel } from './formatters';
import { GRID_END_HOUR, GRID_START_HOUR, layoutDayEvents, minutesToPercent, toDateKey } from './layout';
import { CALENDAR_ACCENT, SCHOOL_ACCENT_OVERLAY, type AssignmentDue, type CalendarEvent } from './types';

const HOURS = Array.from(
  { length: GRID_END_HOUR - GRID_START_HOUR },
  (_unused, index) => GRID_START_HOUR + index
);

export function WeekGrid({
  days,
  events,
  assignments,
  showAssignments,
  onSelectEvent,
  onSelectSlot,
  now = new Date(),
}: {
  days: Date[];
  events: CalendarEvent[];
  assignments: AssignmentDue[];
  showAssignments: boolean;
  onSelectEvent: (event: CalendarEvent) => void;
  onSelectSlot: (start: Date) => void;
  now?: Date;
}): React.JSX.Element {
  const todayKey = toDateKey(now);
  const nowPct = minutesToPercent(now.getHours() * 60 + now.getMinutes());

  return (
    <div
      data-testid="week-grid"
      className="grid flex-1 overflow-auto"
      style={{ gridTemplateColumns: '3.5rem repeat(7, minmax(0, 1fr))' }}
    >
      <div className="relative" style={{ height: `${HOURS.length * 3}rem` }}>
        {HOURS.map((hour, index) => (
          <div
            key={hour}
            className="absolute right-1 -translate-y-1/2 text-[10px]"
            style={{ top: `${(index / HOURS.length) * 100}%`, color: 'var(--color-text-muted)' }}
          >
            {formatHourLabel(hour)}
          </div>
        ))}
      </div>

      {days.map((day) => {
        const key = toDateKey(day);
        const dayEvents = events.filter(
          (event) => !event.isAllDay && toDateKey(new Date(event.startAt)) === key
        );
        const positioned = layoutDayEvents(dayEvents);
        const dayAssignments = showAssignments
          ? assignments.filter((item) => toDateKey(new Date(item.dueAt)) === key)
          : [];

        return (
          <div
            key={key}
            data-day-column={key}
            className="relative border-l"
            style={{ height: `${HOURS.length * 3}rem`, borderColor: 'var(--color-border)' }}
          >
            {HOURS.map((hour, index) => (
              <button
                key={hour}
                type="button"
                aria-label={`Add event ${key} ${formatHourLabel(hour)}`}
                onClick={() => {
                  const slot = new Date(day);
                  slot.setHours(hour, 0, 0, 0);
                  onSelectSlot(slot);
                }}
                className="absolute left-0 w-full border-t"
                style={{
                  top: `${(index / HOURS.length) * 100}%`,
                  height: `${(1 / HOURS.length) * 100}%`,
                  borderColor: 'var(--color-border)',
                }}
              />
            ))}

            {key === todayKey && (
              <div
                className="pointer-events-none absolute left-0 z-10 h-px w-full"
                style={{ top: `${nowPct}%`, backgroundColor: '#EF4444' }}
              />
            )}

            {positioned.map((item) => (
              <button
                key={`${item.event.calendarId}:${item.event.id}`}
                type="button"
                onClick={() => onSelectEvent(item.event)}
                className="absolute overflow-hidden rounded px-1 py-0.5 text-left text-[11px] leading-tight"
                style={{
                  top: `${item.topPct}%`,
                  height: `${item.heightPct}%`,
                  left: `${(item.columnIndex / item.columnCount) * 100}%`,
                  width: `${(1 / item.columnCount) * 100}%`,
                  backgroundColor: CALENDAR_ACCENT,
                  color: '#FFFFFF',
                }}
              >
                {item.event.summary ?? 'Untitled'}
              </button>
            ))}

            {dayAssignments.map((item) => (
              <div
                key={item.id}
                data-testid={`assignment-chip-${item.id}`}
                title={`${item.courseName}: ${item.name}`}
                className="absolute left-0 w-full truncate rounded px-1 text-[10px]"
                style={{
                  top: `${minutesToPercent(new Date(item.dueAt).getHours() * 60 + new Date(item.dueAt).getMinutes())}%`,
                  // Dashed and translucent so a due date never reads as a real
                  // calendar event you could drag or delete.
                  border: `1px dashed ${SCHOOL_ACCENT_OVERLAY}`,
                  color: SCHOOL_ACCENT_OVERLAY,
                  backgroundColor: 'var(--color-surface)',
                }}
              >
                {item.name}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
