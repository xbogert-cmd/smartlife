import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const handlers = new Map<string, (event: unknown, ...args: never[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: never[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

vi.mock('./submit', () => ({ submitAssignment: vi.fn() }));

import { dialog } from 'electron';
import { submitAssignment } from './submit';
import { registerCanvasIpcHandlers } from './ipc';
import { getDraft } from './drafts';

const SCHEMA = `
create table settings (key text primary key, value text not null);
create table canvas_courses (
  id integer primary key, name text not null, course_code text, term_name text,
  current_score real, current_grade text, synced_at text not null default (datetime('now'))
);
create table canvas_assignments (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  name text not null, description text, due_at text, points_possible real, html_url text,
  submission_types text, has_submitted integer not null default 0, submitted_at text,
  score real, grade text, workflow_state text, synced_at text not null default (datetime('now'))
);
create table canvas_discussion_topics (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  assignment_id integer, title text, require_initial_post integer not null default 0,
  synced_at text not null default (datetime('now'))
);
create table assignment_drafts (
  assignment_id integer primary key references canvas_assignments(id) on delete cascade,
  body text not null, updated_at text not null default (datetime('now'))
);
`;

function setup() {
  handlers.clear();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare("insert into canvas_courses (id, name) values (1, 'ACG')").run();
  db.prepare(
    `insert into canvas_assignments (id, course_id, name, submission_types)
     values (10, 1, 'Ch 4', '["online_text_entry"]')`
  ).run();
  db.prepare("insert into settings (key, value) values ('canvas_base_url', 'https://uncw.instructure.com')").run();
  db.prepare("insert into settings (key, value) values ('canvas_token_encrypted', ?)").run(
    Buffer.from('enc:tok').toString('base64')
  );

  const runExclusive = vi.fn(async (fn: () => unknown) => fn());
  const scheduler = { syncNow: vi.fn(), runExclusive } as never;
  registerCanvasIpcHandlers(db, () => null, scheduler);
  return { db, runExclusive };
}

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({}, ...(args as never[]));
}

beforeEach(() => {
  vi.mocked(submitAssignment).mockReset().mockResolvedValue({
    ok: true,
    verified: true,
    submittedAt: '2026-08-22T12:00:00Z',
    message: 'Submitted and confirmed by Canvas.',
  });
});

describe('canvas:get-assignment', () => {
  it('returns the detail with its resolved path', async () => {
    setup();
    const detail = (await invoke('canvas:get-assignment', 10)) as { path: unknown; name: string };
    expect(detail.name).toBe('Ch 4');
    expect(detail.path).toEqual({ kind: 'text' });
  });

  it('returns null for an unknown assignment', async () => {
    setup();
    await expect(invoke('canvas:get-assignment', 999)).resolves.toBeNull();
  });
});

describe('draft channels', () => {
  it('saves and clears a draft', async () => {
    const { db } = setup();
    await invoke('canvas:save-draft', 10, 'work in progress');
    expect(getDraft(db, 10)).toBe('work in progress');
    await invoke('canvas:clear-draft', 10);
    expect(getDraft(db, 10)).toBeNull();
  });
});

describe('canvas:submit', () => {
  it('runs the submission inside the scheduler exclusivity guard', async () => {
    const { runExclusive } = setup();
    await invoke('canvas:submit', 10, { kind: 'text', body: 'x' });
    expect(runExclusive).toHaveBeenCalled();
    expect(submitAssignment).toHaveBeenCalled();
  });

  it('refuses when a sync is already in flight rather than submitting anyway', async () => {
    handlers.clear();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    db.prepare("insert into settings (key, value) values ('canvas_base_url', 'https://uncw.instructure.com')").run();
    db.prepare("insert into settings (key, value) values ('canvas_token_encrypted', ?)").run(
      Buffer.from('enc:tok').toString('base64')
    );
    // runExclusive returns null when it is already busy — the same contract
    // canvas:sync-course relies on.
    const scheduler = { syncNow: vi.fn(), runExclusive: vi.fn(async () => null) } as never;
    registerCanvasIpcHandlers(db, () => null, scheduler);

    const result = (await invoke('canvas:submit', 10, { kind: 'text', body: 'x' })) as {
      ok: boolean;
      message: string;
    };
    expect(result.ok).toBe(false);
    expect(result.message).toContain('already in progress');
    expect(submitAssignment).not.toHaveBeenCalled();
  });

  it('refuses when Canvas is not connected', async () => {
    handlers.clear();
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const scheduler = { syncNow: vi.fn(), runExclusive: vi.fn(async (fn: () => unknown) => fn()) } as never;
    registerCanvasIpcHandlers(db, () => null, scheduler);

    const result = (await invoke('canvas:submit', 10, { kind: 'text', body: 'x' })) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(submitAssignment).not.toHaveBeenCalled();
  });
});

describe('canvas:pick-file', () => {
  it('returns null when the user cancels', async () => {
    setup();
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] } as never);
    await expect(invoke('canvas:pick-file')).resolves.toBeNull();
  });

  it('returns null when the dialog returns no path', async () => {
    setup();
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [] } as never);
    await expect(invoke('canvas:pick-file')).resolves.toBeNull();
  });
});
