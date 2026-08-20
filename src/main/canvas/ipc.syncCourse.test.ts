import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const { handlers, sendMock } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sendMock: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

vi.mock('./sync', async () => {
  const actual = await vi.importActual<typeof import('./sync')>('./sync');
  return { ...actual, syncCourseContent: vi.fn() };
});

import { registerCanvasIpcHandlers } from './ipc';
import { syncCourseContent } from './sync';
import { setCanvasBaseUrl, setCanvasToken } from './token';
import type { CanvasScheduler } from './scheduler';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null)');
  db.exec('create table canvas_sync_state (key text primary key, value text not null)');
  setCanvasBaseUrl(db, 'uncw.instructure.com');
  setCanvasToken(db, 'test-token');
  return db;
}

function invokeSyncCourse(courseId: number): Promise<unknown> {
  const handler = handlers.get('canvas:sync-course');
  if (!handler) throw new Error('canvas:sync-course was not registered');
  return handler({}, courseId) as Promise<unknown>;
}

describe('canvas:sync-course routes through the scheduler guard', () => {
  beforeEach(() => {
    handlers.clear();
    sendMock.mockClear();
    vi.mocked(syncCourseContent).mockReset();
  });

  it('calls syncCourseContent via scheduler.runExclusive, not directly', async () => {
    vi.mocked(syncCourseContent).mockResolvedValue({ ok: true, tokenInvalid: false, errors: [] });
    const runExclusive = vi.fn(<T,>(fn: () => Promise<T>) => fn());
    const scheduler = { syncNow: vi.fn(), runExclusive, stop: vi.fn() } as unknown as CanvasScheduler;

    registerCanvasIpcHandlers(makeDb(), () => ({ webContents: { send: sendMock } }) as never, scheduler);
    const result = await invokeSyncCourse(42);

    expect(runExclusive).toHaveBeenCalledTimes(1);
    expect(syncCourseContent).toHaveBeenCalledWith(expect.anything(), expect.anything(), 42);
    expect(result).toEqual({ ok: true, tokenInvalid: false, errors: [] });
    expect(sendMock).toHaveBeenCalledWith('canvas:sync-changed');
  });

  it('reports a busy result instead of syncing when the scheduler is already in flight', async () => {
    const runExclusive = vi.fn(async () => null);
    const scheduler = { syncNow: vi.fn(), runExclusive, stop: vi.fn() } as unknown as CanvasScheduler;

    registerCanvasIpcHandlers(makeDb(), () => ({ webContents: { send: sendMock } }) as never, scheduler);
    const result = await invokeSyncCourse(42);

    expect(syncCourseContent).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false });
  });
});
