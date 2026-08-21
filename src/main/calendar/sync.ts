import type Database from 'better-sqlite3';
import * as api from './api';
import type { GoogleCalendarListEntry, GoogleEvent } from './api';
import { GoogleAuthError, GoogleRateLimitError } from './errors';
import { setGoogleAccountEmail } from './token';

export const SYNC_KEY_LAST_SYNC = 'last_sync';
export const SYNC_KEY_TOKEN_INVALID = 'token_invalid';

const WINDOW_BACK_DAYS = 60;
const WINDOW_FORWARD_DAYS = 180;
const MS_PER_DAY = 86_400_000;

export interface CalendarSyncResult {
  ok: boolean;
  calendarsSynced: number;
  eventsSynced: number;
  tokenInvalid: boolean;
  errors: string[];
}

export function getSyncState(db: Database.Database, key: string): string | null {
  const row = db.prepare('select value from calendar_sync_state where key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setSyncState(db: Database.Database, key: string, value: string): void {
  db.prepare(
    'insert into calendar_sync_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
  ).run(key, value);
}

export function clearSyncState(db: Database.Database, key: string): void {
  db.prepare('delete from calendar_sync_state where key = ?').run(key);
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The rolling sync window.
 *
 * `timeMin`/`timeMax` are RFC3339 and go to Google. `deleteMin`/`deleteMax`
 * are DATE-ONLY and are used for the local delete-and-reinsert, because
 * `google_events.start_at` holds two formats: RFC3339 for timed events and a
 * bare `YYYY-MM-DD` for all-day ones. Lexicographically a bare date sorts
 * BEFORE a same-day timestamp ("2026-06-21" < "2026-06-21T00:00:00.000Z"), so
 * an all-day event on the window's first day would escape a timestamp lower
 * bound and be orphaned forever. `deleteMax` is the day after `timeMax` so the
 * upper comparison can stay exclusive and still include that final day.
 */
export function syncWindow(now: Date = new Date()): {
  timeMin: string;
  timeMax: string;
  deleteMin: string;
  deleteMax: string;
} {
  const min = new Date(now.getTime() - WINDOW_BACK_DAYS * MS_PER_DAY);
  const max = new Date(now.getTime() + WINDOW_FORWARD_DAYS * MS_PER_DAY);
  return {
    timeMin: min.toISOString(),
    timeMax: max.toISOString(),
    deleteMin: dateOnly(min),
    deleteMax: dateOnly(new Date(max.getTime() + MS_PER_DAY)),
  };
}

interface EventRowValues {
  calendar_id: string;
  id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  start_at: string;
  end_at: string;
  is_all_day: number;
  status: string | null;
  html_link: string | null;
  organizer_email: string | null;
  has_guests: number;
  guest_count: number;
  recurring_event_id: string | null;
  etag: string | null;
  updated_at: string | null;
  synced_at: string;
}

/**
 * Returns null for anything unusable: a cancelled event, or one with neither a
 * dateTime nor a date. Both are cheaper to skip than to represent.
 */
function normalizeEvent(
  calendarId: string,
  event: GoogleEvent,
  syncedAt: string
): EventRowValues | null {
  if (event.status === 'cancelled') return null;

  const startDate = event.start?.date ?? null;
  const endDate = event.end?.date ?? null;
  const startTime = event.start?.dateTime ?? null;
  const endTime = event.end?.dateTime ?? null;

  const isAllDay = startDate !== null;
  // All-day events keep Google's raw date string. Converting to a timestamp
  // here shifts the event to the previous day for any user west of UTC.
  const startAt = isAllDay ? startDate : startTime;
  const endAt = isAllDay ? (endDate ?? startDate) : (endTime ?? startTime);
  if (startAt === null || endAt === null) return null;

  // Only OTHER people count as guests. An event whose sole attendee is the
  // user is a solo event, and escalating it to CONSEQUENTIAL would make the
  // assistant ask permission for nothing.
  const guests = (event.attendees ?? []).filter((attendee) => attendee.self !== true);

  return {
    calendar_id: calendarId,
    id: event.id,
    summary: event.summary ?? null,
    description: event.description ?? null,
    location: event.location ?? null,
    start_at: startAt,
    end_at: endAt,
    is_all_day: isAllDay ? 1 : 0,
    status: event.status ?? null,
    html_link: event.htmlLink ?? null,
    organizer_email: event.organizer?.email ?? null,
    has_guests: guests.length > 0 ? 1 : 0,
    guest_count: guests.length,
    recurring_event_id: event.recurringEventId ?? null,
    etag: event.etag ?? null,
    updated_at: event.updated ?? null,
    synced_at: syncedAt,
  };
}

function upsertCalendars(
  db: Database.Database,
  calendars: GoogleCalendarListEntry[],
  syncedAt: string
): void {
  // `enabled` is deliberately absent from the update clause: it is user state,
  // not Google state, and a resync must never flip it back on.
  const upsert = db.prepare(
    `insert into google_calendars (id, summary, time_zone, background_color, access_role, is_primary, synced_at)
     values (@id, @summary, @time_zone, @background_color, @access_role, @is_primary, @synced_at)
     on conflict(id) do update set
       summary = excluded.summary, time_zone = excluded.time_zone,
       background_color = excluded.background_color, access_role = excluded.access_role,
       is_primary = excluded.is_primary, synced_at = excluded.synced_at`
  );

  const run = db.transaction((rows: GoogleCalendarListEntry[]) => {
    for (const calendar of rows) {
      upsert.run({
        id: calendar.id,
        summary: calendar.summary ?? calendar.id,
        time_zone: calendar.timeZone ?? null,
        background_color: calendar.backgroundColor ?? null,
        access_role: calendar.accessRole ?? null,
        is_primary: calendar.primary === true ? 1 : 0,
        synced_at: syncedAt,
      });
    }
    // Calendars the user removed in Google should disappear here too; events
    // cascade via the foreign key.
    const ids = rows.map((calendar) => calendar.id);
    const placeholders = ids.map(() => '?').join(',');
    if (ids.length === 0) {
      db.prepare('delete from google_calendars').run();
    } else {
      db.prepare(`delete from google_calendars where id not in (${placeholders})`).run(...ids);
    }
  });

  run(calendars);
}

function replaceWindow(
  db: Database.Database,
  calendarId: string,
  rows: EventRowValues[],
  deleteMin: string,
  deleteMax: string
): void {
  const insert = db.prepare(
    `insert into google_events (
       calendar_id, id, summary, description, location, start_at, end_at, is_all_day,
       status, html_link, organizer_email, has_guests, guest_count, recurring_event_id,
       etag, updated_at, synced_at
     ) values (
       @calendar_id, @id, @summary, @description, @location, @start_at, @end_at, @is_all_day,
       @status, @html_link, @organizer_email, @has_guests, @guest_count, @recurring_event_id,
       @etag, @updated_at, @synced_at
     )`
  );

  // Delete-then-insert instead of diffing: an event deleted in Google is
  // simply absent from the response, so it disappears here with no tombstone
  // bookkeeping. Correct by construction. Rows outside the window survive.
  const run = db.transaction((events: EventRowValues[]) => {
    db.prepare(
      'delete from google_events where calendar_id = ? and start_at >= ? and start_at < ?'
    ).run(calendarId, deleteMin, deleteMax);
    for (const event of events) insert.run(event);
  });

  run(rows);
}

async function syncCalendarEvents(
  db: Database.Database,
  calendarId: string,
  now: Date
): Promise<number> {
  const { timeMin, timeMax, deleteMin, deleteMax } = syncWindow(now);
  const events = await api.listEvents(db, calendarId, timeMin, timeMax);
  const syncedAt = now.toISOString();
  const rows = events
    .map((event) => normalizeEvent(calendarId, event, syncedAt))
    .filter((row): row is EventRowValues => row !== null);
  replaceWindow(db, calendarId, rows, deleteMin, deleteMax);
  return rows.length;
}

/** Refetch a single calendar's window. Used right after a write lands. */
export async function syncOneCalendar(
  db: Database.Database,
  calendarId: string,
  now: Date = new Date()
): Promise<void> {
  await syncCalendarEvents(db, calendarId, now);
}

/**
 * Full sync: calendar list, then each enabled calendar's events, strictly
 * one request chain at a time.
 */
export async function syncAll(
  db: Database.Database,
  now: Date = new Date()
): Promise<CalendarSyncResult> {
  const result: CalendarSyncResult = {
    ok: true,
    calendarsSynced: 0,
    eventsSynced: 0,
    tokenInvalid: false,
    errors: [],
  };

  let calendars: GoogleCalendarListEntry[];
  try {
    calendars = await api.listCalendars(db);
  } catch (error) {
    if (error instanceof GoogleAuthError) {
      setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');
      return { ...result, ok: false, tokenInvalid: true, errors: ['Google rejected the credentials.'] };
    }
    return { ...result, ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }

  upsertCalendars(db, calendars, now.toISOString());

  // The primary calendar's id is the account's email address, so the account
  // name comes free with the list and needs no extra scope.
  const primary = calendars.find((calendar) => calendar.primary === true);
  if (primary !== undefined) setGoogleAccountEmail(db, primary.id);

  const enabled = db
    .prepare('select id from google_calendars where enabled = 1 order by is_primary desc, id')
    .all() as Array<{ id: string }>;

  // Serial by construction. Google advises against concurrent request chains,
  // and this must never become a Promise.all fan-out.
  for (const calendar of enabled) {
    try {
      result.eventsSynced += await syncCalendarEvents(db, calendar.id, now);
      result.calendarsSynced += 1;
    } catch (error) {
      result.ok = false;
      if (error instanceof GoogleAuthError) {
        setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');
        return { ...result, tokenInvalid: true, errors: [...result.errors, 'Google rejected the credentials.'] };
      }
      if (error instanceof GoogleRateLimitError) {
        // Back off for this cycle instead of burning the remaining quota on
        // calendars that will be throttled too.
        result.errors.push('Google is rate limiting; skipped the rest of this sync.');
        return result;
      }
      // One broken calendar must not cost the user the others.
      result.errors.push(`${calendar.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (result.ok) {
    clearSyncState(db, SYNC_KEY_TOKEN_INVALID);
  }
  setSyncState(db, SYNC_KEY_LAST_SYNC, now.toISOString());
  return result;
}
