import { useCallback, useEffect, useState } from 'react';
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

  const load = useCallback(async (): Promise<void> => {
    const [nextStatus, nextUpcoming, nextGrades, nextAnnouncements] = await Promise.all([
      window.smartlife.canvas.getStatus(),
      window.smartlife.canvas.getUpcoming(UPCOMING_WINDOW_DAYS),
      window.smartlife.canvas.getGrades(),
      window.smartlife.canvas.getAnnouncements(ANNOUNCEMENT_LIMIT),
    ]);
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
