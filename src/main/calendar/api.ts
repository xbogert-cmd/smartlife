import type Database from 'better-sqlite3';
import { googleFetchAll, googleRequest } from './client';

export interface GoogleCalendarListEntry {
  id: string;
  summary?: string;
  timeZone?: string;
  backgroundColor?: string;
  accessRole?: string;
  primary?: boolean;
}

/** Google sends `dateTime` for timed events and `date` for all-day ones. */
export interface GoogleEventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
  status?: string;
  htmlLink?: string;
  organizer?: { email?: string };
  attendees?: Array<{ email?: string; self?: boolean }>;
  recurringEventId?: string;
  etag?: string;
  updated?: string;
}

/** The subset of Google's event body this app writes. */
export interface GoogleEventInput {
  summary: string;
  description?: string;
  location?: string;
  start: GoogleEventDateTime;
  end: GoogleEventDateTime;
  attendees?: Array<{ email: string }>;
}

export function listCalendars(db: Database.Database): Promise<GoogleCalendarListEntry[]> {
  return googleFetchAll<GoogleCalendarListEntry>(db, '/users/me/calendarList', { maxResults: 250 });
}

/**
 * singleEvents=true makes Google expand recurring events into concrete
 * instances server-side. That is the entire reason this app needs no RRULE
 * engine, so it must not be removed.
 */
export function listEvents(
  db: Database.Database,
  calendarId: string,
  timeMin: string,
  timeMax: string
): Promise<GoogleEvent[]> {
  return googleFetchAll<GoogleEvent>(db, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
    showDeleted: false,
    timeMin,
    timeMax,
  });
}

export async function createEvent(
  db: Database.Database,
  calendarId: string,
  event: GoogleEventInput
): Promise<GoogleEvent> {
  const created = await googleRequest<GoogleEvent>(
    db,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    { method: 'POST', body: event }
  );
  if (created === null) throw new Error('Google returned no event.');
  return created;
}

export async function updateEvent(
  db: Database.Database,
  calendarId: string,
  eventId: string,
  event: GoogleEventInput,
  etag?: string
): Promise<GoogleEvent> {
  const updated = await googleRequest<GoogleEvent>(
    db,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'PUT', body: event, etag }
  );
  if (updated === null) throw new Error('Google returned no event.');
  return updated;
}

export async function deleteEvent(
  db: Database.Database,
  calendarId: string,
  eventId: string
): Promise<void> {
  await googleRequest(
    db,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' }
  );
}
