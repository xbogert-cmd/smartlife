import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('./api', () => ({
  listCourses: vi.fn(),
  listAssignments: vi.fn(),
  listAnnouncements: vi.fn(),
  listModules: vi.fn(),
  listModuleItems: vi.fn(),
  listFiles: vi.fn(),
  getPage: vi.fn(),
  getFile: vi.fn(),
  getSelf: vi.fn(),
}));

import * as api from './api';
import { CanvasAuthError, CanvasNetworkError } from './errors';
import { syncCore, getSyncState, SYNC_KEY_TOKEN_INVALID, SYNC_KEY_LAST_CORE } from './sync';

const CREDS = { baseUrl: 'https://uncw.instructure.com', token: 'test-token' };

const SCHEMA = `
create table canvas_courses (
  id integer primary key, name text not null, course_code text, term_name text,
  current_score real, current_grade text, synced_at text not null default (datetime('now'))
);
create table canvas_assignments (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  name text not null, description text, due_at text, points_possible real, html_url text,
  submission_types text, has_submitted integer not null default 0, submitted_at text,
  score real, grade text, workflow_state text,
  synced_at text not null default (datetime('now'))
);
create table canvas_announcements (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  title text, message text, posted_at text, html_url text,
  synced_at text not null default (datetime('now'))
);
create table canvas_sync_state (key text primary key, value text not null);
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

beforeEach(() => {
  vi.mocked(api.listCourses).mockReset();
  vi.mocked(api.listAssignments).mockReset();
  vi.mocked(api.listAnnouncements).mockReset();
  vi.mocked(api.listAnnouncements).mockResolvedValue([]);
});

describe('syncCore', () => {
  it('stores courses with the grade taken from the student enrollment', async () => {
    vi.mocked(api.listCourses).mockResolvedValue([
      {
        id: 101,
        name: 'Statistics',
        course_code: 'STT 215',
        term: { name: 'Fall 2026' },
        enrollments: [{ type: 'student', computed_current_score: 91.5, computed_current_grade: 'A-' }],
      },
    ]);
    vi.mocked(api.listAssignments).mockResolvedValue([]);
    const db = makeDb();

    const result = await syncCore(db, CREDS);

    expect(result.ok).toBe(true);
    expect(result.coursesSynced).toBe(1);
    const row = db.prepare('select * from canvas_courses where id = 101').get() as Record<string, unknown>;
    expect(row.name).toBe('Statistics');
    expect(row.term_name).toBe('Fall 2026');
    expect(row.current_score).toBe(91.5);
    expect(row.current_grade).toBe('A-');
  });

  it('flattens the submission into assignment columns', async () => {
    vi.mocked(api.listCourses).mockResolvedValue([{ id: 101, name: 'Statistics' }]);
    vi.mocked(api.listAssignments).mockResolvedValue([
      {
        id: 555,
        name: 'Problem Set 3',
        due_at: '2026-09-01T03:59:59Z',
        points_possible: 20,
        submission_types: ['online_upload'],
        submission: { submitted_at: '2026-08-30T12:00:00Z', score: 18, grade: '18', workflow_state: 'graded' },
      },
    ]);
    const db = makeDb();

    await syncCore(db, CREDS);

    const row = db.prepare('select * from canvas_assignments where id = 555').get() as Record<string, unknown>;
    expect(row.course_id).toBe(101);
    expect(row.has_submitted).toBe(1);
    expect(row.score).toBe(18);
    expect(row.workflow_state).toBe('graded');
    expect(JSON.parse(row.submission_types as string)).toEqual(['online_upload']);
  });

  it('marks an assignment unsubmitted when Canvas returns no submission', async () => {
    vi.mocked(api.listCourses).mockResolvedValue([{ id: 101, name: 'Statistics' }]);
    vi.mocked(api.listAssignments).mockResolvedValue([
      { id: 556, name: 'Essay', due_at: '2026-09-05T03:59:59Z', submission: null },
    ]);
    const db = makeDb();

    await syncCore(db, CREDS);

    const row = db.prepare('select has_submitted, submitted_at from canvas_assignments where id = 556').get() as {
      has_submitted: number;
      submitted_at: string | null;
    };
    expect(row.has_submitted).toBe(0);
    expect(row.submitted_at).toBeNull();
  });

  it('is idempotent — syncing twice leaves one row per record', async () => {
    vi.mocked(api.listCourses).mockResolvedValue([{ id: 101, name: 'Statistics' }]);
    vi.mocked(api.listAssignments).mockResolvedValue([{ id: 555, name: 'Problem Set 3' }]);
    const db = makeDb();

    await syncCore(db, CREDS);
    await syncCore(db, CREDS);

    const courses = db.prepare('select count(*) as c from canvas_courses').get() as { c: number };
    const assignments = db.prepare('select count(*) as c from canvas_assignments').get() as { c: number };
    expect(courses.c).toBe(1);
    expect(assignments.c).toBe(1);
  });

  it('updates a changed grade on re-sync rather than inserting a duplicate', async () => {
    vi.mocked(api.listAssignments).mockResolvedValue([]);
    const db = makeDb();

    vi.mocked(api.listCourses).mockResolvedValue([
      { id: 101, name: 'Statistics', enrollments: [{ type: 'student', computed_current_score: 80 }] },
    ]);
    await syncCore(db, CREDS);

    vi.mocked(api.listCourses).mockResolvedValue([
      { id: 101, name: 'Statistics', enrollments: [{ type: 'student', computed_current_score: 95 }] },
    ]);
    await syncCore(db, CREDS);

    const row = db.prepare('select current_score from canvas_courses where id = 101').get() as { current_score: number };
    expect(row.current_score).toBe(95);
  });

  it('deletes courses that disappeared from Canvas, cascading their assignments', async () => {
    vi.mocked(api.listAssignments).mockResolvedValue([{ id: 555, name: 'Problem Set 3' }]);
    const db = makeDb();

    vi.mocked(api.listCourses).mockResolvedValue([{ id: 101, name: 'Statistics' }]);
    await syncCore(db, CREDS);

    vi.mocked(api.listCourses).mockResolvedValue([{ id: 202, name: 'Chemistry' }]);
    await syncCore(db, CREDS);

    const courses = db.prepare('select id from canvas_courses').all() as { id: number }[];
    expect(courses.map((c) => c.id)).toEqual([202]);
    const orphans = db.prepare('select count(*) as c from canvas_assignments where course_id = 101').get() as { c: number };
    expect(orphans.c).toBe(0);
  });

  it('removes assignments deleted from a course that still exists', async () => {
    vi.mocked(api.listCourses).mockResolvedValue([{ id: 101, name: 'Statistics' }]);
    const db = makeDb();

    vi.mocked(api.listAssignments).mockResolvedValue([
      { id: 555, name: 'Problem Set 3' },
      { id: 556, name: 'Essay' },
    ]);
    await syncCore(db, CREDS);

    vi.mocked(api.listAssignments).mockResolvedValue([{ id: 555, name: 'Problem Set 3' }]);
    await syncCore(db, CREDS);

    const ids = (db.prepare('select id from canvas_assignments order by id').all() as { id: number }[]).map((r) => r.id);
    expect(ids).toEqual([555]);
  });

  it('stores announcements against the course parsed from context_code', async () => {
    vi.mocked(api.listCourses).mockResolvedValue([{ id: 101, name: 'Statistics' }]);
    vi.mocked(api.listAssignments).mockResolvedValue([]);
    vi.mocked(api.listAnnouncements).mockResolvedValue([
      { id: 900, title: 'Exam moved', message: '<p>Now Friday</p>', posted_at: '2026-08-17T10:00:00Z', context_code: 'course_101' },
    ]);
    const db = makeDb();

    await syncCore(db, CREDS);

    const row = db.prepare('select course_id, title from canvas_announcements where id = 900').get() as {
      course_id: number;
      title: string;
    };
    expect(row.course_id).toBe(101);
    expect(row.title).toBe('Exam moved');
  });

  it('drops an announcement whose context_code names an unknown course', async () => {
    vi.mocked(api.listCourses).mockResolvedValue([{ id: 101, name: 'Statistics' }]);
    vi.mocked(api.listAssignments).mockResolvedValue([]);
    vi.mocked(api.listAnnouncements).mockResolvedValue([
      { id: 901, title: 'Stale', context_code: 'course_999' },
    ]);
    const db = makeDb();

    const result = await syncCore(db, CREDS);

    expect(result.ok).toBe(true);
    const count = db.prepare('select count(*) as c from canvas_announcements').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('requests courses one at a time, never concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(api.listCourses).mockResolvedValue([
      { id: 101, name: 'Statistics' },
      { id: 202, name: 'Chemistry' },
      { id: 303, name: 'History' },
    ]);
    vi.mocked(api.listAssignments).mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return [];
    });
    const db = makeDb();

    await syncCore(db, CREDS);

    expect(maxInFlight).toBe(1);
  });

  it('records a failing course and still syncs the others', async () => {
    vi.mocked(api.listCourses).mockResolvedValue([
      { id: 101, name: 'Statistics' },
      { id: 202, name: 'Chemistry' },
    ]);
    vi.mocked(api.listAssignments).mockImplementation(async (_creds, courseId: number) => {
      if (courseId === 101) throw new CanvasNetworkError('boom');
      return [{ id: 777, name: 'Lab 1' }];
    });
    const db = makeDb();

    const result = await syncCore(db, CREDS);

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Statistics');
    const kept = db.prepare('select count(*) as c from canvas_assignments where course_id = 202').get() as { c: number };
    expect(kept.c).toBe(1);
  });

  it('sets the token-invalid flag on auth failure and does not throw', async () => {
    vi.mocked(api.listCourses).mockRejectedValue(new CanvasAuthError());
    const db = makeDb();

    const result = await syncCore(db, CREDS);

    expect(result.ok).toBe(false);
    expect(result.tokenInvalid).toBe(true);
    expect(getSyncState(db, SYNC_KEY_TOKEN_INVALID)).toBe('1');
  });

  it('clears a previously set token-invalid flag after a successful sync', async () => {
    const db = makeDb();
    vi.mocked(api.listCourses).mockRejectedValue(new CanvasAuthError());
    await syncCore(db, CREDS);
    expect(getSyncState(db, SYNC_KEY_TOKEN_INVALID)).toBe('1');

    vi.mocked(api.listCourses).mockResolvedValue([{ id: 101, name: 'Statistics' }]);
    vi.mocked(api.listAssignments).mockResolvedValue([]);
    await syncCore(db, CREDS);

    expect(getSyncState(db, SYNC_KEY_TOKEN_INVALID)).toBeNull();
  });

  it('keeps cached rows when the token goes invalid', async () => {
    const db = makeDb();
    vi.mocked(api.listCourses).mockResolvedValue([{ id: 101, name: 'Statistics' }]);
    vi.mocked(api.listAssignments).mockResolvedValue([{ id: 555, name: 'Problem Set 3' }]);
    await syncCore(db, CREDS);

    vi.mocked(api.listCourses).mockRejectedValue(new CanvasAuthError());
    await syncCore(db, CREDS);

    const count = db.prepare('select count(*) as c from canvas_assignments').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('records the sync timestamp on success', async () => {
    vi.mocked(api.listCourses).mockResolvedValue([]);
    const db = makeDb();

    await syncCore(db, CREDS, new Date('2026-08-18T12:00:00Z'));

    expect(getSyncState(db, SYNC_KEY_LAST_CORE)).toBe('2026-08-18T12:00:00.000Z');
  });

  it('does not record a sync timestamp when the run failed on auth', async () => {
    vi.mocked(api.listCourses).mockRejectedValue(new CanvasAuthError());
    const db = makeDb();

    await syncCore(db, CREDS, new Date('2026-08-18T12:00:00Z'));

    expect(getSyncState(db, SYNC_KEY_LAST_CORE)).toBeNull();
  });
});
