import { useCallback, useEffect, useMemo, useState } from 'react';
import { startOfWeek, toDateKey, weekDays } from './layout';
import type { AssignmentDue, CalendarEvent, CalendarRow, CalendarStatus } from './types';

export function useCalendar(): {
  status: CalendarStatus | null;
  calendars: CalendarRow[];
  events: CalendarEvent[];
  assignments: AssignmentDue[];
  weekStart: Date;
  weekDates: Date[];
  syncing: boolean;
  shiftWeek: (delta: number) => void;
  goToToday: () => void;
  refresh: () => Promise<void>;
  reload: () => Promise<void>;
} {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [calendars, setCalendars] = useState<CalendarRow[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [assignments, setAssignments] = useState<AssignmentDue[]>([]);
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [syncing, setSyncing] = useState(false);

  const weekDates = useMemo(() => weekDays(weekStart), [weekStart]);
  const fromDate = toDateKey(weekDates[0]);
  const toDate = toDateKey(weekDates[6]);

  const load = useCallback(async (): Promise<void> => {
    // Promise.all is fine here: these are local IPC reads against SQLite, not
    // Google API calls.
    const [nextStatus, nextCalendars, nextEvents, nextAssignments] = await Promise.all([
      window.smartlife.calendar.getStatus(),
      window.smartlife.calendar.listCalendars(),
      window.smartlife.calendar.getEvents(fromDate, toDate),
      window.smartlife.calendar.getAssignments(fromDate, toDate),
    ]);
    setStatus(nextStatus as CalendarStatus);
    setCalendars(nextCalendars as CalendarRow[]);
    setEvents(nextEvents as CalendarEvent[]);
    setAssignments(nextAssignments as AssignmentDue[]);
  }, [fromDate, toDate]);

  useEffect(() => {
    void load().catch(() => {});
    return window.smartlife.calendar.onSyncChanged(() => {
      void load().catch(() => {});
    });
  }, [load]);

  const refresh = useCallback(async (): Promise<void> => {
    setSyncing(true);
    try {
      await window.smartlife.calendar.syncNow();
      await load();
    } catch {
      // The status line already surfaces staleness; a failed manual refresh
      // does not warrant a modal.
    } finally {
      setSyncing(false);
    }
  }, [load]);

  const shiftWeek = useCallback((delta: number): void => {
    setWeekStart((current) => {
      const next = new Date(current);
      next.setDate(next.getDate() + delta * 7);
      return next;
    });
  }, []);

  const goToToday = useCallback((): void => {
    setWeekStart(startOfWeek(new Date()));
  }, []);

  return {
    status,
    calendars,
    events,
    assignments,
    weekStart,
    weekDates,
    syncing,
    shiftWeek,
    goToToday,
    refresh,
    reload: load,
  };
}
