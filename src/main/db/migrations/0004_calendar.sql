create table google_calendars (
  id text primary key,
  summary text not null,
  time_zone text,
  background_color text,
  access_role text,
  is_primary integer not null default 0,
  enabled integer not null default 1,
  synced_at text not null default (datetime('now'))
);

-- Composite PK: Google event IDs are unique within a calendar, not across
-- calendars, and the same event can appear in two calendars the user owns.
create table google_events (
  calendar_id text not null references google_calendars(id) on delete cascade,
  id text not null,
  summary text,
  description text,
  location text,
  -- For timed events these are RFC3339 timestamps. For all-day events they
  -- are Google's raw date strings ("2026-08-20") and must never be parsed as
  -- timestamps -- doing so renders the event on the wrong day west of UTC.
  start_at text not null,
  end_at text not null,
  is_all_day integer not null default 0,
  status text,
  html_link text,
  organizer_email text,
  -- Two columns instead of an attendees table: has_guests drives the
  -- CONSEQUENTIAL tier escalation, guest_count renders in the UI, and
  -- nothing in this phase reads individual attendees.
  has_guests integer not null default 0,
  guest_count integer not null default 0,
  recurring_event_id text,
  etag text,
  updated_at text,
  synced_at text not null default (datetime('now')),
  primary key (calendar_id, id)
);

create index google_events_start_idx on google_events(start_at);
create index google_events_calendar_start_idx on google_events(calendar_id, start_at);

create table calendar_sync_state (
  key text primary key,
  value text not null
);
