import type { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { createScheduler } from '../scheduler';
import { syncAll } from './sync';
import { hasGoogleAuth } from './token';

const BACKGROUND_INTERVAL_MS = 30 * 60 * 1000;
const FOCUS_THROTTLE_MS = 5 * 60 * 1000;

export interface CalendarScheduler {
  syncNow(): Promise<void>;
  runExclusive<T>(fn: () => Promise<T>): Promise<T | null>;
  stop(): void;
}

export function startCalendarScheduler(
  db: Database.Database,
  getWindow: () => BrowserWindow | null
): CalendarScheduler {
  const scheduler = createScheduler({
    intervalMs: BACKGROUND_INTERVAL_MS,
    focusThrottleMs: FOCUS_THROTTLE_MS,
    run: async () => {
      if (!hasGoogleAuth(db)) return;
      await syncAll(db);
      getWindow()?.webContents.send('calendar:sync-changed');
    },
  });

  return {
    syncNow: () => scheduler.runNow(),
    runExclusive: (fn) => scheduler.runExclusive(fn),
    stop: () => scheduler.stop(),
  };
}
