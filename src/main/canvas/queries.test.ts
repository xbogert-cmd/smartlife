import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

import { getUpcomingAssignments, getCourseGrades, getRecentAnnouncements, getSyncStatus } from './queries';

const SCHEMA = `
create table settings (key text primary key, value text not null);
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
  db.prepare('insert into canvas_courses (id, name, course_code, current_score, current_grade) values (?,?,?,?,?)').run(
    101, 'Statistics', 'STT 215', 91.5, 'A-'
  );
  db.prepare('insert into canvas_courses (id, name, course_code, current_score, current_grade) values (?,?,?,?,?)').run(
    202, 'Chemistry', 'CHM 101', 78, 'C+'
  );
  return db;
}

function addAssignment(db: Database.Database, fields: Record<string, unknown>): void {
  db.prepare(
    `insert into canvas_assignments (id, course_id, name, due_at, points_possible, has_submitted)
     values (@id, @course_id, @name, @due_at, @points_possible, @has_submitted)`
  ).run({ points_possible: 10, has_submitted: 0, due_at: null, ...fields });
}

const NOW = new Date('2026-08-18T00:00:00Z');

describe('getUpcomingAssignments', () => {
  it('returns only assignments inside the window, in due order', () => {
    const db = makeDb();
    addAssignment(db, { id: 1, course_id: 101, name: 'Later', due_at: '2026-08-25T00:00:00Z' });
    addAssignment(db, { id: 2, course_id: 101, name: 'Sooner', due_at: '2026-08-20T00:00:00Z' });
    addAssignment(db, { id: 3, course_id: 101, name: 'Beyond window', due_at: '2026-10-01T00:00:00Z' });

    const rows = getUpcomingAssignments(db, 14, NOW);

    expect(rows.map((r) => r.name)).toEqual(['Sooner', 'Later']);
  });

  it('excludes assignments already past due', () => {
    const db = makeDb();
    addAssignment(db, { id: 1, course_id: 101, name: 'Yesterday', due_at: '2026-08-17T00:00:00Z' });

    expect(getUpcomingAssignments(db, 14, NOW)).toHaveLength(0);
  });

  it('excludes assignments with no due date', () => {
    const db = makeDb();
    addAssignment(db, { id: 1, course_id: 101, name: 'Undated', due_at: null });

    expect(getUpcomingAssignments(db, 14, NOW)).toHaveLength(0);
  });

  it('includes the course name and submitted flag', () => {
    const db = makeDb();
    addAssignment(db, { id: 1, course_id: 202, name: 'Lab 1', due_at: '2026-08-20T00:00:00Z', has_submitted: 1 });

    const [row] = getUpcomingAssignments(db, 14, NOW);

    expect(row.courseName).toBe('Chemistry');
    expect(row.hasSubmitted).toBe(true);
  });

  it('breaks same-instant ties deterministically by id', () => {
    const db = makeDb();
    addAssignment(db, { id: 9, course_id: 101, name: 'B', due_at: '2026-08-20T00:00:00Z' });
    addAssignment(db, { id: 4, course_id: 101, name: 'A', due_at: '2026-08-20T00:00:00Z' });

    expect(getUpcomingAssignments(db, 14, NOW).map((r) => r.id)).toEqual([4, 9]);
  });
});

describe('getCourseGrades', () => {
  it('returns every course ordered by name', () => {
    const rows = getCourseGrades(makeDb());
    expect(rows.map((r) => r.name)).toEqual(['Chemistry', 'Statistics']);
    expect(rows[1].currentScore).toBe(91.5);
    expect(rows[1].currentGrade).toBe('A-');
  });
});

describe('getRecentAnnouncements', () => {
  it('returns newest first and respects the limit', () => {
    const db = makeDb();
    const insert = db.prepare(
      'insert into canvas_announcements (id, course_id, title, posted_at) values (?,?,?,?)'
    );
    insert.run(1, 101, 'Oldest', '2026-08-01T00:00:00Z');
    insert.run(2, 101, 'Newest', '2026-08-17T00:00:00Z');
    insert.run(3, 202, 'Middle', '2026-08-10T00:00:00Z');

    const rows = getRecentAnnouncements(db, 2);

    expect(rows.map((r) => r.title)).toEqual(['Newest', 'Middle']);
    expect(rows[0].courseName).toBe('Statistics');
  });
});

describe('getSyncStatus', () => {
  it('reports unconfigured when nothing is stored', () => {
    const status = getSyncStatus(makeDb(), NOW);
    expect(status.tokenConfigured).toBe(false);
    expect(status.baseUrlConfigured).toBe(false);
    expect(status.lastSyncedAt).toBeNull();
    expect(status.tokenInvalid).toBe(false);
    expect(status.tokenExpiringSoon).toBe(false);
  });

  it('reports configured state, last sync, and the invalid flag', () => {
    const db = makeDb();
    db.prepare('insert into settings (key, value) values (?, ?)').run('canvas_base_url', 'https://uncw.instructure.com');
    db.prepare('insert into settings (key, value) values (?, ?)').run('canvas_token_encrypted', 'ZW5jOnQ=');
    db.prepare('insert into canvas_sync_state (key, value) values (?, ?)').run('last_core_sync', '2026-08-18T00:00:00.000Z');
    db.prepare('insert into canvas_sync_state (key, value) values (?, ?)').run('token_invalid', '1');

    const status = getSyncStatus(db, NOW);

    expect(status.tokenConfigured).toBe(true);
    expect(status.baseUrlConfigured).toBe(true);
    expect(status.lastSyncedAt).toBe('2026-08-18T00:00:00.000Z');
    expect(status.tokenInvalid).toBe(true);
  });

  it('flags a token past the warning threshold', () => {
    const db = makeDb();
    db.prepare('insert into settings (key, value) values (?, ?)').run('canvas_token_encrypted', 'ZW5jOnQ=');
    db.prepare('insert into settings (key, value) values (?, ?)').run('canvas_token_saved_at', '2026-05-01T00:00:00Z');

    const status = getSyncStatus(db, NOW);

    expect(status.tokenAgeDays).toBe(109);
    expect(status.tokenExpiringSoon).toBe(true);
  });

  it('does not flag a freshly saved token', () => {
    const db = makeDb();
    db.prepare('insert into settings (key, value) values (?, ?)').run('canvas_token_encrypted', 'ZW5jOnQ=');
    db.prepare('insert into settings (key, value) values (?, ?)').run('canvas_token_saved_at', '2026-08-17T00:00:00Z');

    expect(getSyncStatus(db, NOW).tokenExpiringSoon).toBe(false);
  });
});
