import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getAssignmentDetail } from './queries';

const SCHEMA = `
create table canvas_courses (
  id integer primary key, name text not null, course_code text,
  term_name text, current_score real, current_grade text,
  synced_at text not null default (datetime('now'))
);
create table canvas_assignments (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  name text not null, description text, due_at text, points_possible real,
  html_url text, submission_types text, has_submitted integer not null default 0,
  submitted_at text, score real, grade text, workflow_state text,
  synced_at text not null default (datetime('now'))
);
create table canvas_discussion_topics (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  assignment_id integer, title text,
  require_initial_post integer not null default 0,
  synced_at text not null default (datetime('now'))
);
create table assignment_drafts (
  assignment_id integer primary key references canvas_assignments(id) on delete cascade,
  body text not null,
  updated_at text not null default (datetime('now'))
);
`;

function setup(submissionTypes: string): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare("insert into canvas_courses (id, name, course_code) values (1, 'Financial Accounting', 'ACG-201')").run();
  db.prepare(
    `insert into canvas_assignments
       (id, course_id, name, description, due_at, points_possible, html_url, submission_types, has_submitted)
     values (10, 1, 'Chapter 4', '<p>Read it</p>', '2026-08-25T04:00:00Z', 20, 'https://uncw.instructure.com/courses/1/assignments/10', ?, 0)`
  ).run(submissionTypes);
  return db;
}

describe('getAssignmentDetail', () => {
  it('returns null for an unknown assignment', () => {
    expect(getAssignmentDetail(setup('["online_upload"]'), 999)).toBeNull();
  });

  it('joins the course name', () => {
    const detail = getAssignmentDetail(setup('["online_upload"]'), 10);
    expect(detail?.courseName).toBe('Financial Accounting');
  });

  it('carries the raw fields through', () => {
    const detail = getAssignmentDetail(setup('["online_upload"]'), 10);
    expect(detail).toMatchObject({
      id: 10,
      courseId: 1,
      name: 'Chapter 4',
      description: '<p>Read it</p>',
      dueAt: '2026-08-25T04:00:00Z',
      pointsPossible: 20,
      hasSubmitted: false,
    });
  });

  it('resolves the submission path', () => {
    expect(getAssignmentDetail(setup('["online_upload"]'), 10)?.path).toEqual({ kind: 'file' });
  });

  it('resolves an external tool to a handoff', () => {
    expect(getAssignmentDetail(setup('["external_tool"]'), 10)?.path).toEqual({
      kind: 'handoff',
      reason: 'external_tool',
    });
  });

  it('resolves a discussion to its topic id', () => {
    const db = setup('["discussion_topic"]');
    db.prepare(
      "insert into canvas_discussion_topics (id, course_id, assignment_id, title) values (55, 1, 10, 'W1')"
    ).run();
    expect(getAssignmentDetail(db, 10)?.path).toEqual({ kind: 'discussion', topicId: 55 });
  });

  it('degrades a discussion whose topic has not synced to a handoff', () => {
    const db = setup('["discussion_topic"]');
    expect(getAssignmentDetail(db, 10)?.path).toEqual({
      kind: 'handoff',
      reason: 'unresolved_discussion',
    });
  });

  it('does not match a topic belonging to a different assignment', () => {
    const db = setup('["discussion_topic"]');
    db.prepare(
      "insert into canvas_discussion_topics (id, course_id, assignment_id, title) values (55, 1, 99, 'Other')"
    ).run();
    expect(getAssignmentDetail(db, 10)?.path).toEqual({
      kind: 'handoff',
      reason: 'unresolved_discussion',
    });
  });

  it('includes a saved draft', () => {
    const db = setup('["online_text_entry"]');
    db.prepare("insert into assignment_drafts (assignment_id, body) values (10, 'in progress')").run();
    expect(getAssignmentDetail(db, 10)?.draft).toBe('in progress');
  });

  it('reports a null draft when none is saved', () => {
    expect(getAssignmentDetail(setup('["online_text_entry"]'), 10)?.draft).toBeNull();
  });

  it('reflects a submitted assignment', () => {
    const db = setup('["online_upload"]');
    db.prepare(
      "update canvas_assignments set has_submitted = 1, submitted_at = '2026-08-20T10:00:00Z', score = 18, grade = 'B', workflow_state = 'graded' where id = 10"
    ).run();
    expect(getAssignmentDetail(db, 10)).toMatchObject({
      hasSubmitted: true,
      submittedAt: '2026-08-20T10:00:00Z',
      score: 18,
      grade: 'B',
      workflowState: 'graded',
    });
  });
});
