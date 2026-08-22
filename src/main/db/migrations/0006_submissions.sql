-- Local scratch for in-progress text and discussion submissions. Never synced
-- anywhere; cleared once Canvas confirms a submission carrying the text.
create table assignment_drafts (
  assignment_id integer primary key
    references canvas_assignments(id) on delete cascade,
  body text not null,
  updated_at text not null default (datetime('now'))
);

-- Canvas assignments do not expose their discussion topic; the link only runs
-- the other way, via DiscussionTopic.assignment_id. This table is what makes
-- assignment -> topic resolvable at submit time.
create table canvas_discussion_topics (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  assignment_id integer,
  title text,
  require_initial_post integer not null default 0,
  synced_at text not null default (datetime('now'))
);

create index canvas_discussion_topics_assignment_idx
  on canvas_discussion_topics(assignment_id);
