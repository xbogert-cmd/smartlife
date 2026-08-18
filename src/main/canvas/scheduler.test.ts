import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const listeners = new Map<string, () => void>();

vi.mock('electron', () => ({
  app: { on: (event: string, cb: () => void) => listeners.set(event, cb) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

vi.mock('./sync', async () => {
  const actual = await vi.importActual<typeof import('./sync')>('./sync');
  return { ...actual, syncCore: vi.fn() };
});

import { syncCore } from './sync';
import { startCanvasScheduler } from './scheduler';
import { setCanvasBaseUrl, setCanvasToken } from './token';

function makeDb(withCreds: boolean): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null)');
  db.exec('create table canvas_sync_state (key text primary key, value text not null)');
  if (withCreds) {
    setCanvasBaseUrl(db, 'uncw.instructure.com');
    setCanvasToken(db, 'test-token');
  }
  return db;
}

beforeEach(() => {
  listeners.clear();
  vi.mocked(syncCore).mockReset();
  vi.mocked(syncCore).mockResolvedValue({ ok: true, coursesSynced: 0, tokenInvalid: false, errors: [] });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startCanvasScheduler', () => {
  it('syncs once on start when credentials exist', async () => {
    const scheduler = startCanvasScheduler(makeDb(true), () => null);
    await vi.runOnlyPendingTimersAsync();
    expect(syncCore).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('does not sync when credentials are missing', async () => {
    const scheduler = startCanvasScheduler(makeDb(false), () => null);
    await vi.runOnlyPendingTimersAsync();
    expect(syncCore).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('never runs two syncs concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(syncCore).mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 50));
      inFlight -= 1;
      return { ok: true, coursesSynced: 0, tokenInvalid: false, errors: [] };
    });
    const scheduler = startCanvasScheduler(makeDb(true), () => null);

    const first = scheduler.syncNow();
    const second = scheduler.syncNow();
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([first, second]);

    expect(maxInFlight).toBe(1);
    scheduler.stop();
  });

  it('syncs again after the background interval elapses', async () => {
    const scheduler = startCanvasScheduler(makeDb(true), () => null);
    await vi.runOnlyPendingTimersAsync();
    expect(syncCore).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(syncCore).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('throttles focus-triggered syncs to once per five minutes', async () => {
    const scheduler = startCanvasScheduler(makeDb(true), () => null);
    await vi.runOnlyPendingTimersAsync();
    expect(syncCore).toHaveBeenCalledTimes(1);

    const onFocus = listeners.get('browser-window-focus');
    expect(onFocus).toBeDefined();

    onFocus?.();
    onFocus?.();
    // Flush pending microtasks only — NOT vi.runOnlyPendingTimersAsync(),
    // which fast-forwards the fake clock to whatever timer is next pending
    // (vitest's runToLastAsync jumps straight to it regardless of its
    // delay). The scheduler's own 30-minute background timer is pending
    // here, so an unbounded "run pending timers" call would fire it early
    // and falsely advance the clock — advanceTimersByTimeAsync(0) settles
    // promises without moving time forward.
    await vi.advanceTimersByTimeAsync(0);
    expect(syncCore).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
    onFocus?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(syncCore).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it('stops scheduling after stop() is called', async () => {
    const scheduler = startCanvasScheduler(makeDb(true), () => null);
    await vi.runOnlyPendingTimersAsync();
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(syncCore).toHaveBeenCalledTimes(1);
  });

  it('notifies the renderer after a sync completes', async () => {
    const send = vi.fn();
    const scheduler = startCanvasScheduler(makeDb(true), () => ({ webContents: { send } }) as never);
    await vi.runOnlyPendingTimersAsync();

    expect(send).toHaveBeenCalledWith('canvas:sync-changed');
    scheduler.stop();
  });

  it('survives a sync that throws without wedging the in-flight guard', async () => {
    vi.mocked(syncCore).mockRejectedValueOnce(new Error('boom'));
    const scheduler = startCanvasScheduler(makeDb(true), () => null);
    await vi.runOnlyPendingTimersAsync();

    vi.mocked(syncCore).mockResolvedValue({ ok: true, coursesSynced: 1, tokenInvalid: false, errors: [] });
    await scheduler.syncNow();

    expect(syncCore).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
});
