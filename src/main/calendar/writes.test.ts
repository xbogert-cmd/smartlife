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

import { createEvent, deleteEvent, listEvents, updateEvent } from './api';

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
  db.prepare("insert into google_calendars (id, summary) values ('cal-1','Personal')").run();
  return db;
}

const DRAFT = {
  calendarId: 'cal-1',
  summary: 'Study block',
  startAt: '2026-08-21T14:00:00.000Z',
  endAt: '2026-08-21T16:00:00.000Z',
  isAllDay: false,
};

beforeEach(() => {
  vi.mocked(createEvent).mockReset();
  vi.mocked(updateEvent).mockReset();
  vi.mocked(deleteEvent).mockReset();
  vi.mocked(listEvents).mockReset();
  vi.mocked(listEvents).mockResolvedValue([] as never);
  vi.mocked(createEvent).mockResolvedValue({ id: 'new-1' } as never);
  vi.mocked(updateEvent).mockResolvedValue({ id: 'evt-1' } as never);
  vi.mocked(deleteEvent).mockResolvedValue(undefined as never);
});

describe('toGoogleInput', () => {
  it('uses dateTime for a timed event', async () => {
    const { toGoogleInput } = await import('./writes');
    expect(toGoogleInput(DRAFT)).toEqual({
      summary: 'Study block',
      start: { dateTime: '2026-08-21T14:00:00.000Z' },
      end: { dateTime: '2026-08-21T16:00:00.000Z' },
    });
  });

  it('uses date for an all-day event', async () => {
    const { toGoogleInput } = await import('./writes');
    const result = toGoogleInput({
      ...DRAFT,
      isAllDay: true,
      startAt: '2026-08-21',
      endAt: '2026-08-22',
    });
    // Sending dateTime for an all-day event makes Google store it as a timed
    // event at midnight, which is not the same thing.
    expect(result.start).toEqual({ date: '2026-08-21' });
    expect(result.end).toEqual({ date: '2026-08-22' });
  });

  it('includes attendees when supplied', async () => {
    const { toGoogleInput } = await import('./writes');
    const result = toGoogleInput({ ...DRAFT, attendees: ['a@example.com', 'b@example.com'] });
    expect(result.attendees).toEqual([{ email: 'a@example.com' }, { email: 'b@example.com' }]);
  });
});

describe('createCalendarEvent', () => {
  it('creates the event and resyncs that calendar', async () => {
    const { createCalendarEvent } = await import('./writes');
    const db = makeDb();

    const result = await createCalendarEvent(db, DRAFT, NOW);

    expect(result).toEqual({ ok: true, eventId: 'new-1' });
    expect(createEvent).toHaveBeenCalledTimes(1);
    // The resync is what makes the new event appear in the UI with Google's
    // own normalization applied.
    expect(listEvents).toHaveBeenCalledTimes(1);
  });

  it('rejects a blank summary without calling Google', async () => {
    const { createCalendarEvent } = await import('./writes');
    const result = await createCalendarEvent(makeDb(), { ...DRAFT, summary: '   ' }, NOW);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('title');
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('rejects an end that is not after the start', async () => {
    const { createCalendarEvent } = await import('./writes');
    const result = await createCalendarEvent(
      makeDb(),
      { ...DRAFT, endAt: '2026-08-21T14:00:00.000Z' },
      NOW
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('end');
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('reports being offline in plain language', async () => {
    const { createCalendarEvent } = await import('./writes');
    const { GoogleNetworkError } = await import('./errors');
    vi.mocked(createEvent).mockRejectedValue(new GoogleNetworkError());

    const result = await createCalendarEvent(makeDb(), DRAFT, NOW);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("offline");
  });

  it('reports a dead token as needing reconnection', async () => {
    const { createCalendarEvent } = await import('./writes');
    const { GoogleAuthError } = await import('./errors');
    vi.mocked(createEvent).mockRejectedValue(new GoogleAuthError());

    const result = await createCalendarEvent(makeDb(), DRAFT, NOW);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('reconnect');
  });
});

describe('updateCalendarEvent', () => {
  function seedEvent(db: Database.Database, etag: string | null): void {
    db.prepare(
      `insert into google_events (calendar_id, id, summary, start_at, end_at, etag)
       values ('cal-1','evt-1','Old','2026-08-21T14:00:00Z','2026-08-21T15:00:00Z', ?)`
    ).run(etag);
  }

  it('sends the stored etag as the precondition', async () => {
    const { updateCalendarEvent } = await import('./writes');
    const db = makeDb();
    seedEvent(db, '"etag-1"');

    const result = await updateCalendarEvent(db, 'evt-1', DRAFT, NOW);

    expect(result.ok).toBe(true);
    // Without If-Match this call silently overwrites whatever another client
    // wrote since the last sync.
    expect(vi.mocked(updateEvent).mock.calls[0][4]).toBe('"etag-1"');
  });

  it('reports a conflict and refreshes rather than overwriting', async () => {
    const { updateCalendarEvent } = await import('./writes');
    const { GoogleConflictError } = await import('./errors');
    const db = makeDb();
    seedEvent(db, '"etag-1"');
    vi.mocked(updateEvent).mockRejectedValue(new GoogleConflictError());

    const result = await updateCalendarEvent(db, 'evt-1', DRAFT, NOW);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('changed');
    // Refreshed so the user sees the other change before retrying.
    expect(listEvents).toHaveBeenCalledTimes(1);
  });

  it('reports an event that no longer exists', async () => {
    const { updateCalendarEvent } = await import('./writes');
    const { GoogleNotFoundError } = await import('./errors');
    const db = makeDb();
    seedEvent(db, '"etag-1"');
    vi.mocked(updateEvent).mockRejectedValue(new GoogleNotFoundError());

    const result = await updateCalendarEvent(db, 'evt-1', DRAFT, NOW);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('no longer exists');
  });

  it('fails when the event is not in the local mirror', async () => {
    const { updateCalendarEvent } = await import('./writes');
    const result = await updateCalendarEvent(makeDb(), 'ghost', DRAFT, NOW);

    expect(result.ok).toBe(false);
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('does not send an attendees key when the draft has none', async () => {
    const { updateCalendarEvent } = await import('./writes');
    const db = makeDb();
    seedEvent(db, '"etag-1"');

    await updateCalendarEvent(db, 'evt-1', DRAFT, NOW);

    // A future accidental revert of updateEvent to full-replace (PUT)
    // semantics would silently wipe attendees/description on Google's side
    // for every draft that doesn't carry them -- this must fail loudly.
    const body = vi.mocked(updateEvent).mock.calls[0][3];
    expect(body).not.toHaveProperty('attendees');
  });
});

describe('deleteCalendarEvent', () => {
  it('deletes and resyncs', async () => {
    const { deleteCalendarEvent } = await import('./writes');
    const result = await deleteCalendarEvent(makeDb(), 'cal-1', 'evt-1', NOW);

    expect(result).toEqual({ ok: true });
    expect(deleteEvent).toHaveBeenCalledWith(expect.anything(), 'cal-1', 'evt-1');
    expect(listEvents).toHaveBeenCalledTimes(1);
  });

  it('treats an already-deleted event as success', async () => {
    const { deleteCalendarEvent } = await import('./writes');
    const { GoogleNotFoundError } = await import('./errors');
    vi.mocked(deleteEvent).mockRejectedValue(new GoogleNotFoundError());

    // The user asked for it gone and it is gone; surfacing an error here would
    // be pedantic and confusing.
    const result = await deleteCalendarEvent(makeDb(), 'cal-1', 'evt-1', NOW);
    expect(result.ok).toBe(true);
  });

  it('removes the row directly, not only via the window resync', async () => {
    const { deleteCalendarEvent } = await import('./writes');
    const db = makeDb();
    // 300 days out -- outside the sync window, so the window-based
    // delete-and-reinsert in replaceWindow would never touch this row.
    db.prepare(
      `insert into google_events (calendar_id, id, summary, start_at, end_at)
       values ('cal-1','future-evt','Future','2027-06-16T10:00:00Z','2027-06-16T11:00:00Z')`
    ).run();

    await deleteCalendarEvent(db, 'cal-1', 'future-evt', NOW);

    const row = db.prepare('select 1 from google_events where id = ?').get('future-evt');
    expect(row).toBeUndefined();
  });
});

describe('out-of-window writes still land in the local mirror', () => {
  const FAR_FUTURE_START = '2027-06-16T10:00:00.000Z'; // ~300 days past NOW
  const FAR_FUTURE_END = '2027-06-16T11:00:00.000Z';

  it('createCalendarEvent upserts the new event even though the sync window would miss it', async () => {
    const { createCalendarEvent } = await import('./writes');
    const db = makeDb();
    vi.mocked(createEvent).mockResolvedValue({
      id: 'future-1',
      summary: 'Far future event',
      start: { dateTime: FAR_FUTURE_START },
      end: { dateTime: FAR_FUTURE_END },
    } as never);
    // The post-write resync's window fetch legitimately finds nothing this
    // far out -- it must not be the only path that gets the event stored.
    vi.mocked(listEvents).mockResolvedValue([] as never);

    const result = await createCalendarEvent(
      db,
      { ...DRAFT, startAt: FAR_FUTURE_START, endAt: FAR_FUTURE_END },
      NOW
    );

    expect(result.ok).toBe(true);
    const row = db.prepare('select summary from google_events where id = ?').get('future-1') as
      | { summary: string }
      | undefined;
    expect(row?.summary).toBe('Far future event');
  });

  it('updateCalendarEvent upserts the moved event even though the sync window would miss it', async () => {
    const { updateCalendarEvent } = await import('./writes');
    const db = makeDb();
    db.prepare(
      `insert into google_events (calendar_id, id, summary, start_at, end_at, etag)
       values ('cal-1','evt-1','Old','2026-08-21T14:00:00Z','2026-08-21T15:00:00Z','"etag-1"')`
    ).run();
    vi.mocked(updateEvent).mockResolvedValue({
      id: 'evt-1',
      summary: 'Moved way out',
      start: { dateTime: FAR_FUTURE_START },
      end: { dateTime: FAR_FUTURE_END },
    } as never);
    vi.mocked(listEvents).mockResolvedValue([] as never);

    const result = await updateCalendarEvent(
      db,
      'evt-1',
      { ...DRAFT, startAt: FAR_FUTURE_START, endAt: FAR_FUTURE_END },
      NOW
    );

    expect(result.ok).toBe(true);
    const row = db.prepare('select summary, start_at from google_events where id = ?').get('evt-1') as
      | { summary: string; start_at: string }
      | undefined;
    expect(row?.summary).toBe('Moved way out');
    expect(row?.start_at).toBe(FAR_FUTURE_START);
  });
});
