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

export interface CalendarEvent {
  calendarId: string;
  id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  /** RFC3339 for timed events, YYYY-MM-DD when isAllDay is true. */
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  htmlLink: string | null;
  hasGuests: boolean;
  guestCount: number;
  etag: string | null;
}

export interface AssignmentDue {
  id: number;
  courseId: number;
  courseName: string;
  name: string;
  dueAt: string;
}

export interface EventDraft {
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  attendees?: string[];
}

/** The calendar section's own accent, copied from nav/sectionThemes.ts. */
export const CALENDAR_ACCENT = '#FB923C';

/**
 * Canvas due dates are drawn in School's blue so they read unmistakably as
 * "from School", not as calendar events you can drag around.
 */
export const SCHOOL_ACCENT_OVERLAY = '#3B82F6';
