import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnnouncementRow, CanvasSyncStatus, CourseGrade, UpcomingAssignment } from './types';

const UPCOMING_WINDOW_DAYS = 14;
const ANNOUNCEMENT_LIMIT = 5;

export function useCanvas(): {
  status: CanvasSyncStatus | null;
  upcoming: UpcomingAssignment[];
  grades: CourseGrade[];
  announcements: AnnouncementRow[];
  syncing: boolean;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<CanvasSyncStatus | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingAssignment[]>([]);
  const [grades, setGrades] = useState<CourseGrade[]>([]);
  const [announcements, setAnnouncements] = useState<AnnouncementRow[]>([]);
  const [syncing, setSyncing] = useState(false);
  // canvas:sync-now broadcasts canvas:sync-changed before it resolves, so a
  // single refresh() can have two loads racing in flight at once (the
  // onSyncChanged listener's load and refresh()'s own). A generation counter
  // discards a load's result if a newer load already started, so a slow,
  // stale load (e.g. a background scheduled sync landing concurrently) can
  // never overwrite fresher state. Same fix as home/useHome.ts.
  const generationRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    const [nextStatus, nextUpcoming, nextGrades, nextAnnouncements] = await Promise.all([
      window.smartlife.canvas.getStatus(),
      window.smartlife.canvas.getUpcoming(UPCOMING_WINDOW_DAYS),
      window.smartlife.canvas.getGrades(),
      window.smartlife.canvas.getAnnouncements(ANNOUNCEMENT_LIMIT),
    ]);

    if (generation !== generationRef.current) return;

    setStatus(nextStatus as CanvasSyncStatus);
    setUpcoming(nextUpcoming as UpcomingAssignment[]);
    setGrades(nextGrades as CourseGrade[]);
    setAnnouncements(nextAnnouncements as AnnouncementRow[]);
  }, []);

  useEffect(() => {
    void load().catch(() => {});
    return window.smartlife.canvas.onSyncChanged(() => {
      void load().catch(() => {});
    });
  }, [load]);

  const refresh = useCallback(async (): Promise<void> => {
    setSyncing(true);
    try {
      await window.smartlife.canvas.syncNow();
      await load();
    } catch {
      // The status row surfaces staleness; a failed manual refresh needs no modal.
    } finally {
      setSyncing(false);
    }
  }, [load]);

  return { status, upcoming, grades, announcements, syncing, refresh };
}
