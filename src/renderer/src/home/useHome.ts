import { useCallback, useEffect, useRef, useState } from 'react';
import { toDateKey } from '../calendar/layout';
import type { CalendarEvent, CalendarStatus } from '../calendar/types';
import type {
  AnnouncementRow,
  CanvasSyncStatus,
  CourseGrade,
  UpcomingAssignment,
} from '../school/types';

const UPCOMING_DAYS = 7;
const OVERDUE_DAYS = 14;
const ANNOUNCEMENT_LIMIT = 3;

export interface HomeState {
  canvasStatus: CanvasSyncStatus | null;
  calendarStatus: CalendarStatus | null;
  upcoming: UpcomingAssignment[];
  overdue: UpcomingAssignment[];
  grades: CourseGrade[];
  announcements: AnnouncementRow[];
  events: CalendarEvent[];
  loaded: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
}

/**
 * Each source resolves independently: a disconnected Google account must
 * leave the Canvas half of the dashboard intact, and vice versa.
 */
async function safeRead<T>(read: () => Promise<unknown>, fallback: T): Promise<T> {
  try {
    return (await read()) as T;
  } catch {
    return fallback;
  }
}

export function useHome(): HomeState {
  const [canvasStatus, setCanvasStatus] = useState<CanvasSyncStatus | null>(null);
  const [calendarStatus, setCalendarStatus] = useState<CalendarStatus | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingAssignment[]>([]);
  const [overdue, setOverdue] = useState<UpcomingAssignment[]>([]);
  const [grades, setGrades] = useState<CourseGrade[]>([]);
  const [announcements, setAnnouncements] = useState<AnnouncementRow[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // canvas:sync-now and calendar:sync-now each broadcast their own
  // *:sync-changed event before syncNow() resolves back to the renderer, so a
  // single refresh() can have three load() calls racing in flight at once. A
  // generation counter discards a load's results if a newer load already
  // started, so a slow, stale load can never overwrite fresher state.
  const generationRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    // Resolved per load, not per mount: an app left open overnight should
    // roll over to the new day on its next sync, not keep showing yesterday.
    const today = toDateKey(new Date());
    const api = window.smartlife;

    const [
      nextCanvasStatus,
      nextCalendarStatus,
      nextUpcoming,
      nextOverdue,
      nextGrades,
      nextAnnouncements,
      nextEvents,
    ] = await Promise.all([
      safeRead<CanvasSyncStatus | null>(() => api.canvas.getStatus(), null),
      safeRead<CalendarStatus | null>(() => api.calendar.getStatus(), null),
      safeRead<UpcomingAssignment[]>(() => api.canvas.getUpcoming(UPCOMING_DAYS), []),
      safeRead<UpcomingAssignment[]>(() => api.canvas.getOverdue(OVERDUE_DAYS), []),
      safeRead<CourseGrade[]>(() => api.canvas.getGrades(), []),
      safeRead<AnnouncementRow[]>(() => api.canvas.getAnnouncements(ANNOUNCEMENT_LIMIT), []),
      safeRead<CalendarEvent[]>(() => api.calendar.getEvents(today, today), []),
    ]);

    // A newer load already started while this one was in flight — its
    // result will win, so don't let this stale one overwrite it.
    if (generation !== generationRef.current) return;

    setCanvasStatus(nextCanvasStatus);
    setCalendarStatus(nextCalendarStatus);
    setUpcoming(nextUpcoming);
    setOverdue(nextOverdue);
    setGrades(nextGrades);
    setAnnouncements(nextAnnouncements);
    setEvents(nextEvents);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load().catch(() => setLoaded(true));
    const stopCanvas = window.smartlife.canvas.onSyncChanged(() => {
      void load().catch(() => {});
    });
    const stopCalendar = window.smartlife.calendar.onSyncChanged(() => {
      void load().catch(() => {});
    });
    return () => {
      // Isolated: stopCanvas throwing must not skip stopCalendar and leak
      // its listener.
      try {
        stopCanvas();
      } finally {
        stopCalendar();
      }
    };
  }, [load]);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      // allSettled, not all: a Google outage must not block a Canvas refresh.
      await Promise.allSettled([
        window.smartlife.canvas.syncNow(),
        window.smartlife.calendar.syncNow(),
      ]);
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  return {
    canvasStatus,
    calendarStatus,
    upcoming,
    overdue,
    grades,
    announcements,
    events,
    loaded,
    refreshing,
    refresh,
  };
}
