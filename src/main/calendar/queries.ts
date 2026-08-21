import type Database from 'better-sqlite3';
import { getGoogleAccountEmail, getGoogleClientConfig, hasGoogleAuth } from './token';
import { getSyncState, SYNC_KEY_LAST_SYNC, SYNC_KEY_TOKEN_INVALID } from './sync';

export interface CalendarStatus {
  clientConfigured: boolean;
  connected: boolean;
  accountEmail: string | null;
  lastSyncedAt: string | null;
  tokenInvalid: boolean;
}

export interface CalendarRow {
  id: string;
  summary: string;
  backgroundColor: string | null;
  isPrimary: boolean;
  enabled: boolean;
}

export interface EventRow {
  calendarId: string;
  id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  htmlLink: string | null;
  hasGuests: boolean;
  guestCount: number;
  etag: string | null;
}

export interface AssignmentDueRow {
  id: number;
  courseId: number;
  courseName: string;
  name: string;
  dueAt: string;
}

interface RawEventRow {
  calendar_id: string;
  id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  start_at: string;
  end_at: string;
  is_all_day: number;
  html_link: string | null;
  has_guests: number;
  guest_count: number;
  etag: string | null;
}

const EVENT_COLUMNS = `calendar_id, id, summary, description, location, start_at, end_at,
  is_all_day, html_link, has_guests, guest_count, etag`;

function toEventRow(row: RawEventRow): EventRow {
  return {
    calendarId: row.calendar_id,
    id: row.id,
    summary: row.summary,
    description: row.description,
    location: row.location,
    startAt: row.start_at,
    endAt: row.end_at,
    isAllDay: row.is_all_day === 1,
    htmlLink: row.html_link,
    hasGuests: row.has_guests === 1,
    guestCount: row.guest_count,
    etag: row.etag,
  };
}

export function getCalendarStatus(db: Database.Database): CalendarStatus {
  return {
    clientConfigured: getGoogleClientConfig(db) !== null,
    connected: hasGoogleAuth(db),
    accountEmail: getGoogleAccountEmail(db),
    lastSyncedAt: getSyncState(db, SYNC_KEY_LAST_SYNC),
    tokenInvalid: getSyncState(db, SYNC_KEY_TOKEN_INVALID) === '1',
  };
}

export function listCalendarRows(db: Database.Database): CalendarRow[] {
  const rows = db
    .prepare(
      `select id, summary, background_color, is_primary, enabled
       from google_calendars order by is_primary desc, summary collate nocase`
    )
    .all() as Array<{
    id: string;
    summary: string;
    background_color: string | null;
    is_primary: number;
    enabled: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    summary: row.summary,
    backgroundColor: row.background_color,
    isPrimary: row.is_primary === 1,
    enabled: row.enabled === 1,
  }));
}

export function setCalendarEnabled(
  db: Database.Database,
  calendarId: string,
  enabled: boolean
): void {
  db.prepare('update google_calendars set enabled = ? where id = ?').run(enabled ? 1 : 0, calendarId);
}

/**
 * Events overlapping [fromDate, toDate], both date-only strings.
 *
 * `date()` normalizes both stored formats -- date('2026-08-21') and
 * date('2026-08-21T14:00:00Z') are both '2026-08-21' -- so one comparison
 * covers timed and all-day events with no branching. Testing overlap rather
 * than start-within-range is what keeps a multi-day event visible during the
 * days it spans.
 */
export function getEventsInRange(
  db: Database.Database,
  fromDate: string,
  toDate: string
): EventRow[] {
  const rows = db
    .prepare(
      `select ${EVENT_COLUMNS} from google_events
       where calendar_id in (select id from google_calendars where enabled = 1)
         and date(start_at) <= ?
         and date(end_at) >= ?
       order by start_at, id`
    )
    .all(toDate, fromDate) as RawEventRow[];
  return rows.map(toEventRow);
}

export function getEvent(
  db: Database.Database,
  calendarId: string,
  eventId: string
): EventRow | null {
  const row = db
    .prepare(`select ${EVENT_COLUMNS} from google_events where calendar_id = ? and id = ?`)
    .get(calendarId, eventId) as RawEventRow | undefined;
  return row === undefined ? null : toEventRow(row);
}

/**
 * Canvas assignment deadlines for the calendar overlay. Reads Phase 3's tables
 * directly -- no network, and no dependency on Canvas being connected: with no
 * Canvas token the tables are simply empty.
 */
export function getAssignmentDueDates(
  db: Database.Database,
  fromDate: string,
  toDate: string
): AssignmentDueRow[] {
  const rows = db
    .prepare(
      `select a.id, a.course_id, c.name as course_name, a.name, a.due_at
       from canvas_assignments a
       join canvas_courses c on c.id = a.course_id
       where a.due_at is not null and date(a.due_at) >= ? and date(a.due_at) <= ?
       order by a.due_at, a.id`
    )
    .all(fromDate, toDate) as Array<{
    id: number;
    course_id: number;
    course_name: string;
    name: string;
    due_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    courseId: row.course_id,
    courseName: row.course_name,
    name: row.name,
    dueAt: row.due_at,
  }));
}
