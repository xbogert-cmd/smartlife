import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

vi.mock('./oauth', () => ({
  runOAuthFlow: vi.fn(),
  GOOGLE_CALENDAR_SCOPE: 'scope',
}));

vi.mock('./sync', async () => {
  const actual = await vi.importActual<typeof import('./sync')>('./sync');
  return { ...actual, syncAll: vi.fn().mockResolvedValue({ ok: true, calendarsSynced: 0, eventsSynced: 0, tokenInvalid: false, errors: [] }) };
});

import { runOAuthFlow } from './oauth';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    create table settings (key text primary key, value text not null);
    create table google_calendars (
      id text primary key, summary text not null, time_zone text, background_color text,
      access_role text, is_primary integer not null default 0, enabled integer not null default 1,
      synced_at text not null default (datetime('now'))
    );
    create table google_events (
      calendar_id text not null references google_calendars(id) on delete cascade,
      id text not null, summary text, description text, location text,
      start_at text not null, end_at text not null, is_all_day integer not null default 0,
      status text, html_link text, organizer_email text,
      has_guests integer not null default 0, guest_count integer not null default 0,
      recurring_event_id text, etag text, updated_at text,
      synced_at text not null default (datetime('now')),
      primary key (calendar_id, id)
    );
    create table calendar_sync_state (key text primary key, value text not null);
    create table canvas_courses (id integer primary key, name text not null);
    create table canvas_assignments (
      id integer primary key, course_id integer not null references canvas_courses(id) on delete cascade,
      name text not null, due_at text, html_url text, has_submitted integer not null default 0
    );
  `);
  return db;
}

const fakeScheduler = {
  syncNow: vi.fn().mockResolvedValue(undefined),
  runExclusive: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  stop: vi.fn(),
};

async function register(db: Database.Database): Promise<void> {
  const { registerCalendarIpcHandlers } = await import('./ipc');
  registerCalendarIpcHandlers(db, () => null, fakeScheduler as never);
}

beforeEach(() => {
  handlers.clear();
  vi.mocked(runOAuthFlow).mockReset();
  fakeScheduler.syncNow.mockClear();
});

describe('registerCalendarIpcHandlers', () => {
  it('registers every channel the preload bridge calls', async () => {
    await register(makeDb());

    for (const channel of [
      'calendar:get-status',
      'calendar:set-client-config',
      'calendar:connect',
      'calendar:disconnect',
      'calendar:sync-now',
      'calendar:list-calendars',
      'calendar:set-calendar-enabled',
      'calendar:get-events',
      'calendar:get-assignments',
      'calendar:create-event',
      'calendar:update-event',
      'calendar:delete-event',
    ]) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  it('refuses to connect before the client config is saved', async () => {
    await register(makeDb());

    const result = await handlers.get('calendar:connect')?.({});

    expect(result).toEqual({ ok: false, error: expect.stringContaining('Client ID') });
    expect(runOAuthFlow).not.toHaveBeenCalled();
  });

  it('stores the refresh token and syncs after a successful connect', async () => {
    const db = makeDb();
    await register(db);
    const { setGoogleClientConfig, getGoogleRefreshToken } = await import('./token');
    setGoogleClientConfig(db, 'client', 'secret');
    vi.mocked(runOAuthFlow).mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt-new',
      expiresIn: 3599,
    } as never);

    const result = await handlers.get('calendar:connect')?.({});

    expect(result).toEqual({ ok: true });
    expect(getGoogleRefreshToken(db)).toBe('rt-new');
    expect(fakeScheduler.syncNow).toHaveBeenCalledTimes(1);
  });

  it('reports a connect that returns no refresh token', async () => {
    const db = makeDb();
    await register(db);
    const { setGoogleClientConfig } = await import('./token');
    setGoogleClientConfig(db, 'client', 'secret');
    // Without access_type=offline / prompt=consent Google does this, and the
    // app would otherwise look connected while being unable to sync.
    vi.mocked(runOAuthFlow).mockResolvedValue({
      accessToken: 'at',
      refreshToken: null,
      expiresIn: 3599,
    } as never);

    const result = (await handlers.get('calendar:connect')?.({})) as { ok: boolean };
    expect(result.ok).toBe(false);
  });

  it('disconnect clears the token but keeps the client config', async () => {
    const db = makeDb();
    await register(db);
    const { setGoogleClientConfig, setGoogleRefreshToken, getGoogleClientConfig, hasGoogleAuth } =
      await import('./token');
    setGoogleClientConfig(db, 'client', 'secret');
    setGoogleRefreshToken(db, 'rt');

    await handlers.get('calendar:disconnect')?.({});

    expect(hasGoogleAuth(db)).toBe(false);
    expect(getGoogleClientConfig(db)).not.toBeNull();
  });

  it('returns events and assignments for a date range', async () => {
    const db = makeDb();
    await register(db);
    db.prepare("insert into google_calendars (id, summary) values ('cal-1','Personal')").run();
    db.prepare(
      `insert into google_events (calendar_id, id, summary, start_at, end_at)
       values ('cal-1','e1','Lecture','2026-08-21T14:00:00Z','2026-08-21T15:00:00Z')`
    ).run();
    db.prepare("insert into canvas_courses (id, name) values (1,'BIO 101')").run();
    db.prepare(
      "insert into canvas_assignments (id, course_id, name, due_at) values (5,1,'Lab','2026-08-21T23:59:00Z')"
    ).run();

    const events = (await handlers.get('calendar:get-events')?.({}, '2026-08-17', '2026-08-23')) as unknown[];
    const assignments = (await handlers.get('calendar:get-assignments')?.(
      {},
      '2026-08-17',
      '2026-08-23'
    )) as unknown[];

    expect(events).toHaveLength(1);
    expect(assignments).toHaveLength(1);
  });

  it('toggles a calendar and triggers a sync', async () => {
    const db = makeDb();
    await register(db);
    db.prepare("insert into google_calendars (id, summary, enabled) values ('cal-1','Personal',0)").run();

    await handlers.get('calendar:set-calendar-enabled')?.({}, 'cal-1', true);

    const row = db.prepare('select enabled from google_calendars where id = ?').get('cal-1') as {
      enabled: number;
    };
    expect(row.enabled).toBe(1);
    // Enabling a calendar with no locally cached events must fetch them, or
    // the user toggles it on and sees nothing.
    expect(fakeScheduler.syncNow).toHaveBeenCalledTimes(1);
  });
});
