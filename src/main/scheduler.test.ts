import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listeners = new Map<string, () => void>();

vi.mock('electron', () => ({
  app: { on: (event: string, cb: () => void) => listeners.set(event, cb) },
}));

beforeEach(() => {
  listeners.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createScheduler', () => {
  it('runs once on start', async () => {
    const { createScheduler } = await import('./scheduler');
    const run = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler({ intervalMs: 1000, focusThrottleMs: 500, run });

    await vi.runOnlyPendingTimersAsync();

    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('runs again after the interval elapses', async () => {
    const { createScheduler } = await import('./scheduler');
    const run = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler({ intervalMs: 1000, focusThrottleMs: 500, run });
    await vi.runOnlyPendingTimersAsync();

    await vi.advanceTimersByTimeAsync(1000);

    expect(run).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('never runs two tasks concurrently', async () => {
    const { createScheduler } = await import('./scheduler');
    let inFlight = 0;
    let maxInFlight = 0;
    const run = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 50));
      inFlight -= 1;
    });
    const scheduler = createScheduler({ intervalMs: 100_000, focusThrottleMs: 500, run });

    const a = scheduler.runNow();
    const b = scheduler.runNow();
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([a, b]);

    expect(maxInFlight).toBe(1);
    scheduler.stop();
  });

  it('runExclusive returns null while a task is in flight', async () => {
    const { createScheduler } = await import('./scheduler');
    const run = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const scheduler = createScheduler({ intervalMs: 100_000, focusThrottleMs: 500, run });

    const background = scheduler.runNow();
    const blocked = scheduler.runExclusive(async () => 'value');
    await vi.advanceTimersByTimeAsync(200);
    const [, blockedResult] = await Promise.all([background, blocked]);

    expect(blockedResult).toBeNull();
    scheduler.stop();
  });

  it('runExclusive returns the value when nothing is in flight', async () => {
    const { createScheduler } = await import('./scheduler');
    const scheduler = createScheduler({
      intervalMs: 100_000,
      focusThrottleMs: 500,
      run: vi.fn().mockResolvedValue(undefined),
    });
    await vi.runOnlyPendingTimersAsync();

    await expect(scheduler.runExclusive(async () => 'value')).resolves.toBe('value');
    scheduler.stop();
  });

  it('throttles focus-triggered runs', async () => {
    const { createScheduler } = await import('./scheduler');
    const run = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler({ intervalMs: 100_000, focusThrottleMs: 5000, run });
    await vi.runOnlyPendingTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);

    const onFocus = listeners.get('browser-window-focus');
    onFocus?.();
    onFocus?.();
    // Settle promises without advancing the clock -- runOnlyPendingTimersAsync
    // would jump to the pending interval timer and falsely move time forward.
    await vi.advanceTimersByTimeAsync(0);
    // Seeded to "now" on start, so an immediate focus is inside the throttle.
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6000);
    onFocus?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it('stops scheduling after stop()', async () => {
    const { createScheduler } = await import('./scheduler');
    const run = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler({ intervalMs: 1000, focusThrottleMs: 500, run });
    await vi.runOnlyPendingTimersAsync();
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('survives a task that throws without wedging the guard', async () => {
    const { createScheduler } = await import('./scheduler');
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const scheduler = createScheduler({ intervalMs: 100_000, focusThrottleMs: 500, run });
    await vi.runOnlyPendingTimersAsync();

    await scheduler.runNow();

    expect(run).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
});
