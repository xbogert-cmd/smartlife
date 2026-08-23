import type { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { getSyncState, syncCore, SYNC_KEY_TOKEN_INVALID } from './sync';
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
      // A Canvas personal access token doesn't intermittently recover -- once
      // Canvas has 401'd it, it stays dead until the user replaces it, which
      // clears this flag immediately (see canvas/ipc.ts's canvas:set-token).
      // Without this, the background/focus scheduler kept retrying the same
      // dead token against Canvas's server every 30 minutes forever.
      if (getSyncState(db, SYNC_KEY_TOKEN_INVALID) === '1') return;
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
