import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { upsertDiscussionTopics } from './sync';

const SCHEMA = `
create table canvas_courses (id integer primary key, name text not null);
create table canvas_discussion_topics (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  assignment_id integer,
  title text,
  require_initial_post integer not null default 0,
  synced_at text not null default (datetime('now'))
);
create index canvas_discussion_topics_assignment_idx on canvas_discussion_topics(assignment_id);
`;

function setup(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare("insert into canvas_courses (id, name) values (1, 'C')").run();
  db.prepare("insert into canvas_courses (id, name) values (2, 'D')").run();
  return db;
}

const AT = '2026-08-22T00:00:00.000Z';

describe('upsertDiscussionTopics', () => {
  it('stores the assignment link, which is the only direction Canvas exposes', () => {
    const db = setup();
    upsertDiscussionTopics(db, 1, [{ id: 5, title: 'Week 1', assignment_id: 10 }], AT);

    const row = db
      .prepare('select id, course_id, assignment_id, title from canvas_discussion_topics where id = 5')
      .get() as Record<string, unknown>;
    expect(row).toEqual({ id: 5, course_id: 1, assignment_id: 10, title: 'Week 1' });
  });

  it('stores ungraded topics with a null assignment_id', () => {
    const db = setup();
    upsertDiscussionTopics(db, 1, [{ id: 6, title: 'Watercooler', assignment_id: null }], AT);
    const row = db.prepare('select assignment_id from canvas_discussion_topics where id = 6').get() as {
      assignment_id: number | null;
    };
    expect(row.assignment_id).toBeNull();
  });

  it('normalises require_initial_post to 0/1', () => {
    const db = setup();
    upsertDiscussionTopics(db, 1, [
      { id: 7, require_initial_post: true },
      { id: 8, require_initial_post: false },
      { id: 9 },
    ], AT);
    const rows = db
      .prepare('select id, require_initial_post from canvas_discussion_topics order by id')
      .all() as Array<{ id: number; require_initial_post: number }>;
    expect(rows).toEqual([
      { id: 7, require_initial_post: 1 },
      { id: 8, require_initial_post: 0 },
      { id: 9, require_initial_post: 0 },
    ]);
  });

  it('updates an existing topic rather than duplicating it', () => {
    const db = setup();
    upsertDiscussionTopics(db, 1, [{ id: 5, title: 'Old', assignment_id: 10 }], AT);
    upsertDiscussionTopics(db, 1, [{ id: 5, title: 'New', assignment_id: 10 }], AT);
    const rows = db.prepare('select title from canvas_discussion_topics').all() as Array<{ title: string }>;
    expect(rows).toEqual([{ title: 'New' }]);
  });

  it('removes topics the course no longer returns', () => {
    const db = setup();
    upsertDiscussionTopics(db, 1, [{ id: 5 }, { id: 6 }], AT);
    upsertDiscussionTopics(db, 1, [{ id: 5 }], AT);
    const ids = (db.prepare('select id from canvas_discussion_topics order by id').all() as Array<{ id: number }>).map(
      (r) => r.id
    );
    expect(ids).toEqual([5]);
  });

  it('does not touch another course when clearing', () => {
    const db = setup();
    upsertDiscussionTopics(db, 1, [{ id: 5 }], AT);
    upsertDiscussionTopics(db, 2, [{ id: 20 }], AT);
    upsertDiscussionTopics(db, 1, [], AT);

    const ids = (db.prepare('select id from canvas_discussion_topics order by id').all() as Array<{ id: number }>).map(
      (r) => r.id
    );
    expect(ids).toEqual([20]);
  });
});
