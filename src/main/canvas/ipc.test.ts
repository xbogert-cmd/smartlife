import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const { openExternal, handlers } = vi.hoisted(() => ({
  openExternal: vi.fn().mockResolvedValue(undefined),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
  shell: { openExternal },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

import { registerCanvasIpcHandlers } from './ipc';
import { getSyncState, setSyncState, SYNC_KEY_TOKEN_INVALID } from './sync';

const SCHEMA = `
create table settings (key text primary key, value text not null);
create table canvas_sync_state (key text primary key, value text not null);
create table canvas_courses (
  id integer primary key, name text not null, course_code text, term_name text,
  current_score real, current_grade text, synced_at text not null default (datetime('now'))
);
create table canvas_assignments (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  name text not null, description text, due_at text, points_possible real, html_url text,
  submission_types text, has_submitted integer not null default 0, submitted_at text,
  score real, grade text, workflow_state text,
  synced_at text not null default (datetime('now'))
);
`;

let db: Database.Database;

describe('canvas:open-external protocol allowlist', () => {
  beforeEach(() => {
    handlers.clear();
    openExternal.mockClear();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    registerCanvasIpcHandlers(
      db,
      () => null,
      {} as never
    );
  });

  function invoke(url: string): Promise<{ ok: boolean; error?: string }> {
    const handler = handlers.get('canvas:open-external');
    if (!handler) throw new Error('canvas:open-external was not registered');
    return handler({}, url) as Promise<{ ok: boolean; error?: string }>;
  }

  it('opens an https URL', async () => {
    const result = await invoke('https://example.edu/stats');
    expect(result).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith('https://example.edu/stats');
  });

  it('opens an http URL', async () => {
    const result = await invoke('http://example.edu/stats');
    expect(result).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith('http://example.edu/stats');
  });

  it('rejects a file: URL without calling shell.openExternal', async () => {
    const result = await invoke('file:///etc/passwd');
    expect(result.ok).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects a javascript: URL without calling shell.openExternal', async () => {
    const result = await invoke('javascript:alert(1)');
    expect(result.ok).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects a custom app-registered scheme without calling shell.openExternal', async () => {
    const result = await invoke('smartlife-evil://payload');
    expect(result.ok).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects a malformed URL without throwing', async () => {
    const result = await invoke('not a url');
    expect(result.ok).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('canvas:get-overdue', () => {
  beforeEach(() => {
    handlers.clear();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    registerCanvasIpcHandlers(
      db,
      () => null,
      {} as never
    );
  });

  it('registers canvas:get-overdue and returns past-due assignments', async () => {
    const handler = handlers.get('canvas:get-overdue');
    expect(handler).toBeTypeOf('function');

    db.prepare("insert into canvas_courses (id, name) values (7, 'Weather and Climate')").run();
    db.prepare(
      `insert into canvas_assignments (id, course_id, name, due_at, submission_types, has_submitted)
       values (70, 7, 'Lab 3', ?, '["online_upload"]', 0)`
    ).run(new Date(Date.now() - 2 * 86_400_000).toISOString());

    const rows = (await handler!({}, 14)) as Array<{ id: number; name: string }>;
    expect(rows.map((row) => row.name)).toContain('Lab 3');
  });
});

describe('canvas:set-token', () => {
  beforeEach(() => {
    handlers.clear();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    registerCanvasIpcHandlers(db, () => null, {} as never);
  });

  it('clears a previously-known-invalid token flag so the scheduler gives the new token a fresh chance', async () => {
    setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');

    await handlers.get('canvas:set-token')?.({}, 'a-fresh-token');

    expect(getSyncState(db, SYNC_KEY_TOKEN_INVALID)).toBeNull();
  });

  it('is a no-op on the flag when nothing was invalid to begin with', async () => {
    await handlers.get('canvas:set-token')?.({}, 'a-fresh-token');
    expect(getSyncState(db, SYNC_KEY_TOKEN_INVALID)).toBeNull();
  });
});
