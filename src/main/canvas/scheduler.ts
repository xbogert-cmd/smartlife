import { app, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { syncCore } from './sync';
import { getCanvasCredentials } from './token';

const BACKGROUND_INTERVAL_MS = 30 * 60 * 1000;
const FOCUS_THROTTLE_MS = 5 * 60 * 1000;

export interface CanvasScheduler {
  syncNow(): Promise<void>;
  stop(): void;
}

export function startCanvasScheduler(
  db: Database.Database,
  getWindow: () => BrowserWindow | null
): CanvasScheduler {
  // Single in-flight guard. Checked and set synchronously before the first
  // await so two callers can never interleave a sync.
  // ponytail: one boolean is enough — there is exactly one Canvas account.
  let syncing = false;
  // Seeded to "now" because the scheduler syncs immediately on start — the
  // first focus a moment later must not trigger a second sync.
  let lastFocusSync = Date.now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function run(): Promise<void> {
    if (syncing || stopped) return;
    const creds = getCanvasCredentials(db);
    if (creds === null) return;
    syncing = true;
    try {
      await syncCore(db, creds);
      getWindow()?.webContents.send('canvas:sync-changed');
    } catch {
      // syncCore already records failures in canvas_sync_state; a throw here
      // must still release the guard, which the finally block guarantees.
    } finally {
      syncing = false;
    }
  }

  // Self-rescheduling setTimeout, kicked off with a 0ms delay rather than
  // calling run() directly. This isn't cosmetic: it's what makes the first
  // sync-on-start behave as a single, isolated tick instead of racing the
  // 30-minute follow-up into the same one. Registering the next timer
  // straight after run() resolves means it's always visible for the next
  // *explicit* advance (background-interval test), while starting the chain
  // from a real (fake-clock) timer keeps each cycle's firing scoped to its
  // own tick.
  function scheduleNext(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void run().finally(() => scheduleNext(BACKGROUND_INTERVAL_MS));
    }, delayMs);
  }

  function onFocus(): void {
    const now = Date.now();
    if (now - lastFocusSync < FOCUS_THROTTLE_MS) return;
    lastFocusSync = now;
    void run();
  }

  app.on('browser-window-focus', onFocus);
  scheduleNext(0);

  return {
    syncNow: run,
    stop(): void {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      app.removeListener?.('browser-window-focus', onFocus);
    },
  };
}
