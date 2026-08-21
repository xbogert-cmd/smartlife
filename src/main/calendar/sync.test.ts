import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

vi.mock('./api', () => ({
  listCalendars: vi.fn(),
  listEvents: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
}));

import { listCalendars, listEvents } from './api';

const NOW = new Date('2026-08-20T12:00:00.000Z');

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
  `);
  return db;
}

const PRIMARY = {
  id: 'me@example.com',
  summary: 'Personal',
  timeZone: 'America/New_York',
  backgroundColor: '#3B82F6',
  accessRole: 'owner',
  primary: true,
};

function timedEvent(id: string, startIso: string, endIso: string, extra = {}): unknown {
  return {
    id,
    summary: `Event ${id}`,
    start: { dateTime: startIso },
    end: { dateTime: endIso },
    etag: `"etag-${id}"`,
    htmlLink: `https://calendar.google.com/${id}`,
    ...extra,
  };
}

beforeEach(() => {
  vi.mocked(listCalendars).mockReset();
  vi.mocked(listEvents).mockReset();
  vi.mocked(listCalendars).mockResolvedValue([PRIMARY] as never);
  vi.mocked(listEvents).mockResolvedValue([] as never);
});

describe('syncWindow', () => {
  it('spans 60 days back and 180 forward, with date-only delete bounds', async () => {
    const { syncWindow } = await import('./sync');
    const w = syncWindow(NOW);

    expect(w.timeMin).toBe('2026-06-21T12:00:00.000Z');
    expect(w.timeMax).toBe('2027-02-16T12:00:00.000Z');
    // Date-only, and the upper bound is the day AFTER timeMax's date, so an
    // all-day event stored as "2027-02-16" still falls inside a `< deleteMax`
    // comparison.
    expect(w.deleteMin).toBe('2026-06-21');
    expect(w.deleteMax).toBe('2027-02-17');
  });
});

describe('syncAll', () => {
  it('stores calendars and marks the primary one', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();

    await syncAll(db, NOW);

    const row = db.prepare('select * from google_calendars').get() as Record<string, unknown>;
    expect(row.id).toBe('me@example.com');
    expect(row.summary).toBe('Personal');
    expect(row.is_primary).toBe(1);
    expect(row.enabled).toBe(1);
  });

  it('never overwrites the user enabled flag on resync', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    await syncAll(db, NOW);

    db.prepare('update google_calendars set enabled = 0 where id = ?').run('me@example.com');
    await syncAll(db, NOW);

    const row = db.prepare('select enabled from google_calendars').get() as { enabled: number };
    // A resync silently re-enabling a calendar the user switched off would be
    // maddening and near-impossible to diagnose.
    expect(row.enabled).toBe(0);
  });

  it('skips fetching events for disabled calendars', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    await syncAll(db, NOW);
    db.prepare('update google_calendars set enabled = 0').run();

    vi.mocked(listEvents).mockClear();
    await syncAll(db, NOW);

    expect(listEvents).not.toHaveBeenCalled();
  });

  it('keeps a disabled calendar rows rather than deleting them', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    vi.mocked(listEvents).mockResolvedValue([
      timedEvent('e1', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z'),
    ] as never);
    await syncAll(db, NOW);
    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 1 });

    db.prepare('update google_calendars set enabled = 0').run();
    await syncAll(db, NOW);

    // Rows survive so re-enabling is instant instead of waiting for a refetch.
    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 1 });
  });

  it('stores a timed event with is_all_day = 0', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    vi.mocked(listEvents).mockResolvedValue([
      timedEvent('e1', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z', { location: 'Room 5' }),
    ] as never);

    await syncAll(db, NOW);

    const row = db.prepare('select * from google_events').get() as Record<string, unknown>;
    expect(row.start_at).toBe('2026-08-21T14:00:00Z');
    expect(row.end_at).toBe('2026-08-21T15:00:00Z');
    expect(row.is_all_day).toBe(0);
    expect(row.location).toBe('Room 5');
    expect(row.etag).toBe('"etag-e1"');
  });

  it('stores an all-day event as a raw date string, never a timestamp', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    vi.mocked(listEvents).mockResolvedValue([
      { id: 'a1', summary: 'Holiday', start: { date: '2026-08-25' }, end: { date: '2026-08-26' } },
    ] as never);

    await syncAll(db, NOW);

    const row = db.prepare('select * from google_events').get() as Record<string, unknown>;
    expect(row.is_all_day).toBe(1);
    // Storing "2026-08-25T00:00:00Z" here is the classic all-day bug: it
    // renders on the 24th for anyone west of UTC.
    expect(row.start_at).toBe('2026-08-25');
    expect(row.end_at).toBe('2026-08-26');
  });

  it('counts only other people as guests, not the user themselves', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    vi.mocked(listEvents).mockResolvedValue([
      timedEvent('solo', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z', {
        attendees: [{ email: 'me@example.com', self: true }],
      }),
      timedEvent('group', '2026-08-22T14:00:00Z', '2026-08-22T15:00:00Z', {
        attendees: [
          { email: 'me@example.com', self: true },
          { email: 'a@example.com' },
          { email: 'b@example.com' },
        ],
      }),
    ] as never);

    await syncAll(db, NOW);

    const rows = db
      .prepare('select id, has_guests, guest_count from google_events order by id')
      .all() as Array<{ id: string; has_guests: number; guest_count: number }>;
    // An event whose only "attendee" is you is a solo event -- treating it as
    // having guests would escalate it to CONSEQUENTIAL for no reason.
    expect(rows).toEqual([
      { id: 'group', has_guests: 1, guest_count: 2 },
      { id: 'solo', has_guests: 0, guest_count: 0 },
    ]);
  });

  it('removes events that vanished from Google', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    vi.mocked(listEvents).mockResolvedValue([
      timedEvent('e1', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z'),
      timedEvent('e2', '2026-08-22T14:00:00Z', '2026-08-22T15:00:00Z'),
    ] as never);
    await syncAll(db, NOW);

    vi.mocked(listEvents).mockResolvedValue([
      timedEvent('e1', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z'),
    ] as never);
    // A real second sync always runs at a later clock reading than the
    // first -- syncAll(db, NOW) twice with the identical NOW is not a
    // pattern any real caller produces (see the strict `synced_at <`
    // comparison in replaceWindow).
    await syncAll(db, new Date(NOW.getTime() + 60_000));

    const ids = db.prepare('select id from google_events').all() as Array<{ id: string }>;
    expect(ids).toEqual([{ id: 'e1' }]);
  });

  it('deletes an all-day event sitting exactly on the window boundary', async () => {
    const { syncAll, syncWindow } = await import('./sync');
    const db = makeDb();
    const boundary = syncWindow(NOW).deleteMin;
    vi.mocked(listEvents).mockResolvedValue([
      { id: 'edge', summary: 'Edge', start: { date: boundary }, end: { date: '2026-06-22' } },
    ] as never);
    await syncAll(db, NOW);
    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 1 });

    vi.mocked(listEvents).mockResolvedValue([] as never);
    // A real second sync always runs at a later clock reading than the
    // first -- see the note in the "vanished from Google" test above.
    await syncAll(db, new Date(NOW.getTime() + 60_000));

    // A bare date compares lexicographically BEFORE a same-day timestamp, so
    // a timestamp lower bound would leave this row orphaned forever.
    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 0 });
  });

  it('is idempotent across repeated syncs', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    vi.mocked(listEvents).mockResolvedValue([
      timedEvent('e1', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z'),
    ] as never);

    await syncAll(db, NOW);
    await syncAll(db, NOW);

    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 1 });
  });

  it('does not delete a row when its synced_at equals the sync timestamp (tie-breaks correctly with <, not <=)', async () => {
    // Regression test for https://github.com/...
    // A sync running at the exact same timestamp as an existing row must not
    // delete that row, even if the sync's fetch hasn't yet caught up with the
    // event. The fix: replaceWindow's delete must use synced_at < ? (strict),
    // never synced_at <= ?. With <=, a row stamped at t could be deleted by a
    // sync also at t, silently undoing the write that just landed.
    const { syncAll } = await import('./sync');
    const db = makeDb();
    const TIE_TIME = '2026-08-20T12:00:00.000Z';

    // Seed a row with synced_at exactly equal to the sync's own timestamp.
    // This simulates a direct write (e.g., upsertEvent) and its immediate
    // follow-up resync both using the same 'now' timestamp.
    db.prepare("insert into google_calendars (id, summary) values (?, ?)").run(
      'me@example.com',
      'Personal'
    );
    db.prepare(
      `insert into google_events (calendar_id, id, summary, start_at, end_at, is_all_day, synced_at)
       values (?, ?, ?, ?, ?, ?, ?)`
    ).run('me@example.com', 'seeded', 'Seeded Event', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z', 0, TIE_TIME);

    // Verify it's there before the sync.
    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 1 });

    // Mock the sync's fetch to return nothing (simulating Google's response not
    // yet reflecting the event that was just written).
    vi.mocked(listEvents).mockResolvedValue([] as never);

    // Run syncAll with the exact same timestamp as the seeded row.
    await syncAll(db, new Date(TIE_TIME));

    // The row must survive. With synced_at < ? this passes (the condition is
    // false: TIE_TIME is not less than TIE_TIME). With synced_at <= ? it fails
    // (the condition is true, and the row gets deleted).
    const rows = db.prepare('select id from google_events').all() as Array<{ id: string }>;
    expect(rows).toEqual([{ id: 'seeded' }]);
  });

  it('drops calendars Google no longer returns, cascading their events', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    vi.mocked(listCalendars).mockResolvedValue([PRIMARY, { id: 'other', summary: 'Other' }] as never);
    vi.mocked(listEvents).mockResolvedValue([
      timedEvent('e1', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z'),
    ] as never);
    await syncAll(db, NOW);
    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 2 });

    vi.mocked(listCalendars).mockResolvedValue([PRIMARY] as never);
    await syncAll(db, NOW);

    expect(db.prepare('select count(*) as n from google_calendars').get()).toEqual({ n: 1 });
    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 1 });
  });

  it('records the account email from the primary calendar', async () => {
    const { syncAll } = await import('./sync');
    const { getGoogleAccountEmail } = await import('./token');
    const db = makeDb();

    await syncAll(db, NOW);

    // The primary calendar's id IS the account email, so this costs nothing
    // and avoids requesting a userinfo scope the app does not otherwise need.
    expect(getGoogleAccountEmail(db)).toBe('me@example.com');
  });

  it('keeps syncing other calendars when one fails', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    vi.mocked(listCalendars).mockResolvedValue([PRIMARY, { id: 'other', summary: 'Other' }] as never);
    vi.mocked(listEvents).mockImplementation(async (_db, calendarId) => {
      if (calendarId === 'other') throw new Error('boom');
      return [timedEvent('e1', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z')] as never;
    });

    const result = await syncAll(db, NOW);

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    // One broken calendar must not cost the user the others.
    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 1 });
  });

  it('flags an invalid token and stops, leaving existing rows intact', async () => {
    const { syncAll, getSyncState, SYNC_KEY_TOKEN_INVALID } = await import('./sync');
    const { GoogleAuthError } = await import('./errors');
    const db = makeDb();
    vi.mocked(listEvents).mockResolvedValue([
      timedEvent('e1', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z'),
    ] as never);
    await syncAll(db, NOW);

    vi.mocked(listCalendars).mockRejectedValue(new GoogleAuthError());
    const result = await syncAll(db, NOW);

    expect(result.tokenInvalid).toBe(true);
    expect(getSyncState(db, SYNC_KEY_TOKEN_INVALID)).toBe('1');
    // A dead token means stale data, never a blank screen.
    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 1 });
  });

  it('clears the token-invalid flag after a successful sync', async () => {
    const { syncAll, getSyncState, setSyncState, SYNC_KEY_TOKEN_INVALID } = await import('./sync');
    const db = makeDb();
    setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');

    await syncAll(db, NOW);

    expect(getSyncState(db, SYNC_KEY_TOKEN_INVALID)).toBeNull();
  });

  it('aborts the run on a rate limit rather than hammering', async () => {
    const { syncAll } = await import('./sync');
    const { GoogleRateLimitError } = await import('./errors');
    const db = makeDb();
    vi.mocked(listCalendars).mockResolvedValue([PRIMARY, { id: 'other', summary: 'Other' }] as never);
    vi.mocked(listEvents).mockRejectedValue(new GoogleRateLimitError());

    const result = await syncAll(db, NOW);

    expect(result.ok).toBe(false);
    // Stops after the first 429 instead of burning the remaining quota.
    expect(vi.mocked(listEvents)).toHaveBeenCalledTimes(1);
  });

  it('records the last sync timestamp', async () => {
    const { syncAll, getSyncState, SYNC_KEY_LAST_SYNC } = await import('./sync');
    const db = makeDb();

    await syncAll(db, NOW);

    expect(getSyncState(db, SYNC_KEY_LAST_SYNC)).toBe(NOW.toISOString());
  });
});

describe('stale-sync race protection', () => {
  it('does not delete a row a newer concurrent write already landed while this sync was in flight', async () => {
    const { syncOneCalendar } = await import('./sync');
    const db = makeDb();
    db.prepare("insert into google_calendars (id, summary) values ('cal-1','Personal')").run();

    const STALE_NOW = new Date('2026-08-20T12:00:00.000Z');
    // A write that landed (via the single-event upsert) after this sync's own
    // syncedAt stamp -- simulating a write racing ahead of an in-flight sync
    // that started earlier but resolves later.
    const NEWER_SYNCED_AT = '2026-08-20T12:05:00.000Z';
    db.prepare(
      `insert into google_events (calendar_id, id, summary, start_at, end_at, synced_at)
       values ('cal-1','concurrent','Written mid-sync','2026-08-25T10:00:00Z','2026-08-25T11:00:00Z', ?)`
    ).run(NEWER_SYNCED_AT);

    // The stale sync's fetch reflects Google's state before the concurrent
    // write, so it does not include the new event.
    vi.mocked(listEvents).mockResolvedValue([] as never);

    await syncOneCalendar(db, 'cal-1', STALE_NOW);

    const row = db.prepare('select id from google_events where id = ?').get('concurrent');
    expect(row).toBeDefined();
  });
});

describe('syncOneCalendar', () => {
  it('refetches only the named calendar', async () => {
    const { syncAll, syncOneCalendar } = await import('./sync');
    const db = makeDb();
    vi.mocked(listCalendars).mockResolvedValue([PRIMARY, { id: 'other', summary: 'Other' }] as never);
    await syncAll(db, NOW);

    vi.mocked(listEvents).mockClear();
    vi.mocked(listEvents).mockResolvedValue([
      timedEvent('new', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z'),
    ] as never);
    await syncOneCalendar(db, 'other', NOW);

    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listEvents).mock.calls[0][1]).toBe('other');
    const row = db.prepare('select calendar_id from google_events').get() as { calendar_id: string };
    expect(row.calendar_id).toBe('other');
  });
});
