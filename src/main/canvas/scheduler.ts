import type { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { syncCore } from './sync';
import { getCanvasCredentials } from './token';
import { createScheduler } from '../scheduler';

const BACKGROUND_INTERVAL_MS = 30 * 60 * 1000;
const FOCUS_THROTTLE_MS = 5 * 60 * 1000;

export interface CanvasScheduler {
  syncNow(): Promise<void>;
  // Runs fn() under the same in-flight guard as the background/focus syncs,
  // so a manual per-course sync (canvas:sync-course) can never overlap a
  // scheduled one. Returns null, without calling fn, if something is
  // already syncing.
  runExclusive<T>(fn: () => Promise<T>): Promise<T | null>;
  stop(): void;
}

export function startCanvasScheduler(
  db: Database.Database,
  getWindow: () => BrowserWindow | null
): CanvasScheduler {
  const scheduler = createScheduler({
    intervalMs: BACKGROUND_INTERVAL_MS,
    focusThrottleMs: FOCUS_THROTTLE_MS,
    run: async () => {
      const creds = getCanvasCredentials(db);
      if (creds === null) return;
      await syncCore(db, creds);
      // Deliberately after the await: a failed sync throws past this line, so
      // the renderer is only told to refetch when there is new data.
      getWindow()?.webContents.send('canvas:sync-changed');
    },
  });

  return {
    syncNow: () => scheduler.runNow(),
    runExclusive: (fn) => scheduler.runExclusive(fn),
    stop: () => scheduler.stop(),
  };
}
