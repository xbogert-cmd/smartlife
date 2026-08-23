import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useCalendar } from '../calendar/useCalendar';
import { AgendaPanel } from '../calendar/AgendaPanel';
import { AllDayStrip } from '../calendar/AllDayStrip';
import { ConnectBanner } from '../calendar/ConnectBanner';
import { EventDialog } from '../calendar/EventDialog';
import { WeekGrid } from '../calendar/WeekGrid';
import { formatRelative } from '../calendar/formatters';
import { formatDayHeader } from '../calendar/formatters';
import type { CalendarEvent } from '../calendar/types';

export function Calendar(): React.JSX.Element {
  const { status, calendars, events, assignments, weekDates, syncing, shiftWeek, goToToday, refresh, reload } =
    useCalendar();
  const [showAssignments, setShowAssignments] = useState(true);
  const [dialog, setDialog] = useState<
    { mode: 'create'; slotStart: Date } | { mode: 'edit'; event: CalendarEvent } | null
  >(null);
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();

  // The AI's ambient view context (useViewContext.ts) reads this ?event= id
  // to tell the model which event the user is currently looking at -- it has
  // no other way to see Calendar's local dialog state. replace: true keeps
  // the browser back button from stepping through every event click.
  function openEventDialog(event: CalendarEvent): void {
    setDialog({ mode: 'edit', event });
    setSearchParams({ event: event.id }, { replace: true });
  }

  function closeEventDialog(): void {
    setDialog(null);
    setSearchParams({}, { replace: true });
  }

  // null (loading) and "not connected" render the same prompt so there is no
  // flash of an empty grid before status resolves.
  const connected = status !== null && status.connected;

  if (!connected) {
    return (
      <div className="flex flex-col items-start gap-4 p-8">
        <h1 className="text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
          Calendar
        </h1>
        <p style={{ color: 'var(--color-text-muted)' }}>
          Connect Google Calendar to see your week, add events, and let the assistant schedule things
          for you.
        </p>
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="rounded-md px-3 py-1.5 text-sm"
          style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
        >
          Go to Settings
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
          Calendar
        </h1>
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={showAssignments}
              onChange={(e) => setShowAssignments(e.target.checked)}
            />
            Canvas due dates
          </label>
          <span>Synced {formatRelative(status.lastSyncedAt)}</span>
          <button type="button" onClick={() => void refresh()} disabled={syncing} className="rounded px-2 py-1" style={{ border: '1px solid var(--color-border)' }}>
            {syncing ? 'Syncing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <ConnectBanner status={status} />

      <div className="flex items-center gap-2">
        <button type="button" aria-label="Previous week" onClick={() => shiftWeek(-1)} className="rounded px-2 py-1 text-sm" style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
          ‹
        </button>
        <button type="button" onClick={goToToday} className="rounded px-2 py-1 text-sm" style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
          Today
        </button>
        <button type="button" aria-label="Next week" onClick={() => shiftWeek(1)} className="rounded px-2 py-1 text-sm" style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
          ›
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            className="grid"
            style={{ gridTemplateColumns: '3.5rem repeat(7, minmax(0, 1fr))' }}
          >
            <div />
            {weekDates.map((day) => (
              <div key={day.toISOString()} className="px-1 pb-1 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {formatDayHeader(day)}
              </div>
            ))}
          </div>
          <AllDayStrip
            days={weekDates}
            events={events}
            onSelectEvent={openEventDialog}
          />
          <WeekGrid
            days={weekDates}
            events={events}
            assignments={assignments}
            showAssignments={showAssignments}
            onSelectEvent={openEventDialog}
            onSelectSlot={(slotStart) => setDialog({ mode: 'create', slotStart })}
          />
        </div>
        <AgendaPanel
          days={weekDates}
          events={events}
          assignments={assignments}
          showAssignments={showAssignments}
          onSelectEvent={openEventDialog}
        />
      </div>

      {dialog !== null && (
        <EventDialog
          calendars={calendars}
          event={dialog.mode === 'edit' ? dialog.event : undefined}
          slotStart={dialog.mode === 'create' ? dialog.slotStart : undefined}
          onClose={closeEventDialog}
          onSaved={() => {
            closeEventDialog();
            void reload();
          }}
        />
      )}
    </div>
  );
}
