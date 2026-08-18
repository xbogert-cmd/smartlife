create table canvas_courses (
  id integer primary key,
  name text not null,
  course_code text,
  term_name text,
  current_score real,
  current_grade text,
  synced_at text not null default (datetime('now'))
);

create table canvas_assignments (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  name text not null,
  description text,
  due_at text,
  points_possible real,
  html_url text,
  submission_types text,
  has_submitted integer not null default 0,
  submitted_at text,
  score real,
  grade text,
  workflow_state text,
  synced_at text not null default (datetime('now'))
);

create index canvas_assignments_course_idx on canvas_assignments(course_id);
create index canvas_assignments_due_idx on canvas_assignments(due_at);

create table canvas_announcements (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  title text,
  message text,
  posted_at text,
  html_url text,
  synced_at text not null default (datetime('now'))
);

create index canvas_announcements_posted_idx on canvas_announcements(posted_at);

create table canvas_modules (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  name text,
  position integer,
  synced_at text not null default (datetime('now'))
);

create index canvas_modules_course_idx on canvas_modules(course_id, position);

create table canvas_module_items (
  id integer primary key,
  module_id integer not null references canvas_modules(id) on delete cascade,
  course_id integer not null,
  title text,
  type text,
  content_id integer,
  page_url text,
  html_url text,
  external_url text,
  position integer
);

create index canvas_module_items_module_idx on canvas_module_items(module_id, position);

create table canvas_files (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  display_name text,
  filename text,
  content_type text,
  size integer,
  updated_at text,
  synced_at text not null default (datetime('now'))
);

create index canvas_files_course_idx on canvas_files(course_id);

create table canvas_pages (
  course_id integer not null references canvas_courses(id) on delete cascade,
  url text not null,
  title text,
  body text,
  updated_at text,
  synced_at text not null default (datetime('now')),
  primary key (course_id, url)
);

create table canvas_sync_state (
  key text primary key,
  value text not null
);
