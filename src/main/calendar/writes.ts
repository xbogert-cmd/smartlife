import type Database from 'better-sqlite3';
import * as api from './api';
import type { GoogleEventInput } from './api';
import {
  GoogleAuthError,
  GoogleConflictError,
  GoogleNetworkError,
  GoogleNotFoundError,
  GoogleRateLimitError,
} from './errors';
import { getEvent } from './queries';
import { deleteEventRow, syncOneCalendar, upsertEvent } from './sync';

export interface EventDraft {
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  /** RFC3339 for timed events, YYYY-MM-DD when isAllDay is true. */
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  attendees?: string[];
}

export interface WriteResult {
  ok: boolean;
  error?: string;
  eventId?: string;
}

export function toGoogleInput(draft: EventDraft): GoogleEventInput {
  // Google distinguishes all-day from timed purely by which key is present.
  // Sending dateTime for an all-day event stores a midnight timed event.
  const start = draft.isAllDay ? { date: draft.startAt } : { dateTime: draft.startAt };
  const end = draft.isAllDay ? { date: draft.endAt } : { dateTime: draft.endAt };
  const input: GoogleEventInput = { summary: draft.summary.trim(), start, end };
  if (draft.description !== undefined) input.description = draft.description;
  if (draft.location !== undefined) input.location = draft.location;
  if (draft.attendees !== undefined && draft.attendees.length > 0) {
    input.attendees = draft.attendees.map((email) => ({ email }));
  }
  return input;
}

function validate(draft: EventDraft): string | null {
  if (draft.summary.trim().length === 0) return 'The event needs a title.';
  if (draft.calendarId.trim().length === 0) return 'Pick a calendar for the event.';
  if (draft.endAt <= draft.startAt) return 'The end time has to be after the start time.';
  return null;
}

/** Turns a thrown Google error into a sentence both the UI and the AI can show. */
function describeError(error: unknown): string {
  if (error instanceof GoogleNetworkError) return "You're offline — this change wasn't saved.";
  if (error instanceof GoogleAuthError) return 'Google Calendar needs to be reconnected in Settings.';
  if (error instanceof GoogleRateLimitError) return 'Google is rate limiting right now. Try again in a minute.';
  if (error instanceof GoogleConflictError) {
    return 'This event was changed somewhere else. Refreshed it — take a look and try again.';
  }
  if (error instanceof GoogleNotFoundError) return 'That event no longer exists on Google Calendar.';
  return error instanceof Error ? error.message : String(error);
}

/**
 * Best-effort refresh of one calendar after a write. Swallows its own errors:
 * the write already succeeded, and failing the whole operation because the
 * follow-up read failed would be misleading.
 */
async function resync(db: Database.Database, calendarId: string, now: Date): Promise<void> {
  try {
    await syncOneCalendar(db, calendarId, now);
  } catch {
    // The next scheduled sync will pick it up.
  }
}

export async function createCalendarEvent(
  db: Database.Database,
  draft: EventDraft,
  now: Date = new Date()
): Promise<WriteResult> {
  const invalid = validate(draft);
  if (invalid !== null) return { ok: false, error: invalid };

  try {
    const created = await api.createEvent(db, draft.calendarId, toGoogleInput(draft));
    // Upsert the API's own response directly first: it's already the
    // authoritative, fully-normalized record, so the local mirror reflects
    // the write immediately even if the event falls outside the rolling
    // sync window that `resync` refetches (e.g. an event months out).
    upsertEvent(db, draft.calendarId, created, now.toISOString());
    await resync(db, draft.calendarId, now);
    return { ok: true, eventId: created.id };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

export async function updateCalendarEvent(
  db: Database.Database,
  eventId: string,
  draft: EventDraft,
  now: Date = new Date()
): Promise<WriteResult> {
  const invalid = validate(draft);
  if (invalid !== null) return { ok: false, error: invalid };

  const existing = getEvent(db, draft.calendarId, eventId);
  if (existing === null) {
    return { ok: false, error: 'That event is not in the local calendar. Try refreshing first.' };
  }

  try {
    // If-Match with the stored etag: without it, this overwrites whatever
    // another client (a phone, the web UI) wrote since the last sync.
    const updated = await api.updateEvent(
      db,
      draft.calendarId,
      eventId,
      toGoogleInput(draft),
      existing.etag ?? undefined
    );
    // Same reasoning as create: upsert the authoritative response directly
    // so a move to a date outside the sync window still shows up locally.
    upsertEvent(db, draft.calendarId, updated, now.toISOString());
    await resync(db, draft.calendarId, now);
    return { ok: true, eventId };
  } catch (error) {
    // A conflict means someone else's change is the newer truth. Pull it in
    // so the user can see what happened before deciding to retry.
    if (error instanceof GoogleConflictError) await resync(db, draft.calendarId, now);
    return { ok: false, error: describeError(error) };
  }
}

export async function deleteCalendarEvent(
  db: Database.Database,
  calendarId: string,
  eventId: string,
  now: Date = new Date()
): Promise<WriteResult> {
  try {
    await api.deleteEvent(db, calendarId, eventId);
  } catch (error) {
    // Already gone is the outcome the user asked for.
    if (!(error instanceof GoogleNotFoundError)) {
      return { ok: false, error: describeError(error) };
    }
  }
  // Remove the row directly rather than relying solely on the window
  // resync: an event outside the sync window would never be touched by
  // resync's delete-and-reinsert, and would appear to still exist locally.
  deleteEventRow(db, calendarId, eventId);
  await resync(db, calendarId, now);
  return { ok: true };
}
