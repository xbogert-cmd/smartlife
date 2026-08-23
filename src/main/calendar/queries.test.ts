import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

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
  db.prepare(
    "insert into google_calendars (id, summary, background_color, is_primary) values ('me@example.com','Personal','#3B82F6',1)"
  ).run();
  db.prepare(
    "insert into google_calendars (id, summary, is_primary, enabled) values ('other','Other',0,0)"
  ).run();
  return db;
}

function addEvent(db: Database.Database, values: Record<string, unknown>): void {
  db.prepare(
    `insert into google_events (calendar_id, id, summary, start_at, end_at, is_all_day, has_guests, guest_count, etag)
     values (@calendar_id, @id, @summary, @start_at, @end_at, @is_all_day, @has_guests, @guest_count, @etag)`
  ).run({
    calendar_id: 'me@example.com',
    summary: 'Event',
    is_all_day: 0,
    has_guests: 0,
    guest_count: 0,
    etag: null,
    ...values,
  });
}

describe('getCalendarStatus', () => {
  it('reports nothing configured on a fresh database', async () => {
    const { getCalendarStatus } = await import('./queries');
    const status = getCalendarStatus(makeDb());

    expect(status.clientConfigured).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.accountEmail).toBeNull();
    expect(status.tokenInvalid).toBe(false);
  });

  it('reports connected once a client config and refresh token exist', async () => {
    const { getCalendarStatus } = await import('./queries');
    const { setGoogleClientConfig, setGoogleRefreshToken, setGoogleAccountEmail } = await import('./token');
    const db = makeDb();
    setGoogleClientConfig(db, 'client', 'secret');
    setGoogleRefreshToken(db, 'rt');
    setGoogleAccountEmail(db, 'me@example.com');

    const status = getCalendarStatus(db);
    expect(status.clientConfigured).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.accountEmail).toBe('me@example.com');
  });

  it('surfaces the token-invalid flag', async () => {
    const { getCalendarStatus } = await import('./queries');
    const { setSyncState, SYNC_KEY_TOKEN_INVALID } = await import('./sync');
    const db = makeDb();
    setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');

    expect(getCalendarStatus(db).tokenInvalid).toBe(true);
  });
});

describe('listCalendarRows and setCalendarEnabled', () => {
  it('lists calendars with the primary first and reports enabled state', async () => {
    const { listCalendarRows } = await import('./queries');
    const rows = listCalendarRows(makeDb());

    expect(rows).toEqual([
      { id: 'me@example.com', summary: 'Personal', backgroundColor: '#3B82F6', isPrimary: true, enabled: true },
      { id: 'other', summary: 'Other', backgroundColor: null, isPrimary: false, enabled: false },
    ]);
  });

  it('toggles a calendar on and off', async () => {
    const { listCalendarRows, setCalendarEnabled } = await import('./queries');
    const db = makeDb();

    setCalendarEnabled(db, 'other', true);
    expect(listCalendarRows(db).find((c) => c.id === 'other')?.enabled).toBe(true);

    setCalendarEnabled(db, 'other', false);
    expect(listCalendarRows(db).find((c) => c.id === 'other')?.enabled).toBe(false);
  });
});

describe('getEventsInRange', () => {
  it('returns timed events inside the range, ordered by start', async () => {
    const { getEventsInRange } = await import('./queries');
    const db = makeDb();
    addEvent(db, { id: 'b', start_at: '2026-08-21T15:00:00Z', end_at: '2026-08-21T16:00:00Z' });
    addEvent(db, { id: 'a', start_at: '2026-08-21T09:00:00Z', end_at: '2026-08-21T10:00:00Z' });

    const rows = getEventsInRange(db, '2026-08-17', '2026-08-23');
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('includes all-day events stored as bare dates', async () => {
    const { getEventsInRange } = await import('./queries');
    const db = makeDb();
    addEvent(db, { id: 'allday', start_at: '2026-08-21', end_at: '2026-08-22', is_all_day: 1 });

    const rows = getEventsInRange(db, '2026-08-17', '2026-08-23');
    expect(rows).toHaveLength(1);
    // The raw date must survive the round trip untouched.
    expect(rows[0].startAt).toBe('2026-08-21');
    expect(rows[0].isAllDay).toBe(true);
  });

  it('includes a multi-day event that started before the range', async () => {
    const { getEventsInRange } = await import('./queries');
    const db = makeDb();
    addEvent(db, { id: 'trip', start_at: '2026-08-15', end_at: '2026-08-20', is_all_day: 1 });

    // A week view that dropped an in-progress vacation would be plainly wrong.
    expect(getEventsInRange(db, '2026-08-17', '2026-08-23')).toHaveLength(1);
  });

  it('excludes events from disabled calendars', async () => {
    const { getEventsInRange } = await import('./queries');
    const db = makeDb();
    addEvent(db, { id: 'hidden', calendar_id: 'other', start_at: '2026-08-21T09:00:00Z', end_at: '2026-08-21T10:00:00Z' });

    expect(getEventsInRange(db, '2026-08-17', '2026-08-23')).toHaveLength(0);
  });

  it('excludes events outside the range', async () => {
    const { getEventsInRange } = await import('./queries');
    const db = makeDb();
    addEvent(db, { id: 'far', start_at: '2026-10-01T09:00:00Z', end_at: '2026-10-01T10:00:00Z' });

    expect(getEventsInRange(db, '2026-08-17', '2026-08-23')).toHaveLength(0);
  });

  it('finds a local evening event that plain SQLite date() would bucket into tomorrow', async () => {
    // 9pm Eastern on the 21st is 2026-08-22T01:00:00Z -- date(start_at) with
    // no modifier normalizes to UTC and would misfile this under the 22nd.
    // A same-day query for the 21st must still find it.
    const { getEventsInRange } = await import('./queries');
    const db = makeDb();
    addEvent(db, {
      id: 'evening',
      start_at: '2026-08-21T21:00:00-04:00',
      end_at: '2026-08-21T22:00:00-04:00',
    });

    const rows = getEventsInRange(db, '2026-08-21', '2026-08-21');
    expect(rows.map((r) => r.id)).toEqual(['evening']);
  });

  it('does not shift an all-day event back a day under the local-time comparison', async () => {
    // is_all_day rows store a bare local date with no timezone. Applying
    // 'localtime' to them (treating the bare date as UTC midnight, then
    // converting to the OS zone) would shift them a day earlier for any
    // user east of UTC-0 -- exactly what the is_all_day branch must avoid.
    const { getEventsInRange } = await import('./queries');
    const db = makeDb();
    addEvent(db, { id: 'allday', start_at: '2026-08-21', end_at: '2026-08-22', is_all_day: 1 });

    const rows = getEventsInRange(db, '2026-08-21', '2026-08-21');
    expect(rows.map((r) => r.id)).toEqual(['allday']);
  });
});

describe('getEvent', () => {
  it('returns a single event with its etag, or null', async () => {
    const { getEvent } = await import('./queries');
    const db = makeDb();
    addEvent(db, {
      id: 'e1',
      start_at: '2026-08-21T09:00:00Z',
      end_at: '2026-08-21T10:00:00Z',
      etag: '"tag"',
      has_guests: 1,
      guest_count: 3,
    });

    const row = getEvent(db, 'me@example.com', 'e1');
    expect(row?.etag).toBe('"tag"');
    expect(row?.hasGuests).toBe(true);
    expect(row?.guestCount).toBe(3);
    expect(getEvent(db, 'me@example.com', 'missing')).toBeNull();
  });
});

describe('getAssignmentDueDates', () => {
  it('returns Canvas assignments inside the range', async () => {
    const { getAssignmentDueDates } = await import('./queries');
    const db = makeDb();
    db.prepare("insert into canvas_courses (id, name) values (1, 'BIO 101')").run();
    db.prepare(
      "insert into canvas_assignments (id, course_id, name, due_at) values (10, 1, 'Lab 3', '2026-08-21T23:59:00Z')"
    ).run();
    db.prepare(
      "insert into canvas_assignments (id, course_id, name, due_at) values (11, 1, 'Later', '2026-10-01T23:59:00Z')"
    ).run();

    const rows = getAssignmentDueDates(db, '2026-08-17', '2026-08-23');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Lab 3');
    expect(rows[0].courseName).toBe('BIO 101');
  });

  it('returns nothing when Canvas is not connected', async () => {
    const { getAssignmentDueDates } = await import('./queries');
    // Calendar must be fully usable without Canvas; empty tables, not an error.
    expect(getAssignmentDueDates(makeDb(), '2026-08-17', '2026-08-23')).toEqual([]);
  });

  it('finds an assignment due late Eastern evening that UTC due_at would bucket into tomorrow', async () => {
    // Canvas due_at is always UTC. 9pm Eastern on the 21st is
    // 2026-08-22T01:00:00Z -- plain date(due_at) normalizes to UTC and would
    // misfile this under the 22nd, outside a same-day query for the 21st.
    const { getAssignmentDueDates } = await import('./queries');
    const db = makeDb();
    db.prepare("insert into canvas_courses (id, name) values (1, 'BIO 101')").run();
    db.prepare(
      "insert into canvas_assignments (id, course_id, name, due_at) values (10, 1, 'Late Lab', '2026-08-22T01:00:00Z')"
    ).run();

    const rows = getAssignmentDueDates(db, '2026-08-21', '2026-08-21');
    expect(rows.map((r) => r.name)).toEqual(['Late Lab']);
  });
});
