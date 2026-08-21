import { app } from 'electron';

export interface Scheduler {
  /** Run the task now, subject to the in-flight guard. */
  runNow(): Promise<void>;
  /**
   * Run fn() under the same in-flight guard as the scheduled task, so a
   * user-triggered sync can never overlap a background one. Returns null
   * without calling fn if something is already running -- matching the
   * guard's "skip, don't queue" behavior rather than adding a queue.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T | null>;
  stop(): void;
}

export interface SchedulerOptions {
  intervalMs: number;
  focusThrottleMs: number;
  run: () => Promise<void>;
}

/**
 * Self-rescheduling background task runner shared by the Canvas and Calendar
 * sync engines: run on start, run again a fixed delay after each completion,
 * run on window focus (throttled), and never run two at once.
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const { intervalMs, focusThrottleMs, run: runTask } = options;

  // Single in-flight guard. Checked and set synchronously before the first
  // await so two callers can never interleave a run.
  let running = false;
  // Seeded to "now" because the scheduler runs immediately on start -- the
  // first focus a moment later must not trigger a second run.
  let lastFocusRun = Date.now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function runExclusive<T>(fn: () => Promise<T>): Promise<T | null> {
    if (running) return null;
    running = true;
    try {
      return await fn();
    } finally {
      running = false;
    }
  }

  async function runNow(): Promise<void> {
    if (stopped) return;
    await runExclusive(async () => {
      try {
        await runTask();
      } catch {
        // A throwing task must still release the guard (runExclusive's
        // finally guarantees that) and must not break the reschedule chain.
      }
    });
  }

  // Self-rescheduling setTimeout, kicked off with a 0ms delay rather than
  // calling runNow() directly. This isn't cosmetic: it's what makes the first
  // run-on-start behave as a single, isolated tick instead of racing the
  // follow-up interval into the same one. Registering the next timer straight
  // after runNow() resolves means it's always visible for the next *explicit*
  // advance (the background-interval test), while starting the chain from a
  // real (fake-clock) timer keeps each cycle's firing scoped to its own tick.
  function scheduleNext(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void runNow().finally(() => scheduleNext(intervalMs));
    }, delayMs);
  }

  function onFocus(): void {
    const now = Date.now();
    if (now - lastFocusRun < focusThrottleMs) return;
    lastFocusRun = now;
    void runNow();
  }

  app.on('browser-window-focus', onFocus);
  scheduleNext(0);

  return {
    runNow,
    runExclusive,
    stop(): void {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      app.removeListener?.('browser-window-focus', onFocus);
    },
  };
}
