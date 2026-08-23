import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

import {
  getUpcomingAssignments,
  getOverdueAssignments,
  getCourseGrades,
  getRecentAnnouncements,
  getSyncStatus,
  getCourseDetail,
  searchMaterials,
  getPageBody,
} from './queries';
import { courseContentKey } from './sync';

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
create table canvas_modules (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  name text, position integer, synced_at text not null default (datetime('now'))
);
create table canvas_module_items (
  id integer primary key,
  module_id integer not null references canvas_modules(id) on delete cascade,
  course_id integer not null, title text, type text, content_id integer,
  page_url text, html_url text, external_url text, position integer
);
create table canvas_files (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  display_name text, filename text, content_type text, size integer,
  updated_at text, synced_at text not null default (datetime('now'))
);
create table canvas_pages (
  course_id integer not null references canvas_courses(id) on delete cascade,
  url text not null, title text, body text, updated_at text,
  synced_at text not null default (datetime('now')), primary key (course_id, url)
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

function seedCourseContent(db: Database.Database): void {
  addAssignment(db, { id: 1, course_id: 101, name: 'Problem Set 1', due_at: '2026-08-20T00:00:00Z' });
  db.prepare('insert into canvas_announcements (id, course_id, title, posted_at) values (?,?,?,?)').run(
    1, 101, 'Welcome', '2026-08-10T00:00:00Z'
  );
  db.prepare('insert into canvas_modules (id, course_id, name, position) values (?,?,?,?)').run(10, 101, 'Week 1', 1);
  db.prepare(
    `insert into canvas_module_items (id, module_id, course_id, title, type, content_id, page_url, external_url, position)
     values (?,?,?,?,?,?,?,?,?)`
  ).run(1000, 10, 101, 'Syllabus', 'Page', null, 'syllabus', null, 1);
  db.prepare(
    `insert into canvas_module_items (id, module_id, course_id, title, type, content_id, page_url, external_url, position)
     values (?,?,?,?,?,?,?,?,?)`
  ).run(1001, 10, 101, 'Slides', 'File', 7, null, null, 2);
  db.prepare('insert into canvas_files (id, course_id, display_name, content_type, size) values (?,?,?,?,?)').run(
    7, 101, 'Lecture 1.pdf', 'application/pdf', 1024
  );
  db.prepare('insert into canvas_pages (course_id, url, title, body) values (?,?,?,?)').run(
    101, 'syllabus', 'Syllabus', '<p>Read this</p>'
  );
}

describe('getCourseDetail', () => {
  it('returns the full shape with assignments, modules, files, and announcements', () => {
    const db = makeDb();
    seedCourseContent(db);
    db.prepare('insert into canvas_sync_state (key, value) values (?, ?)').run(
      courseContentKey(101),
      '2026-08-18T00:00:00.000Z'
    );

    const detail = getCourseDetail(db, 101);

    expect(detail).not.toBeNull();
    expect(detail!.course).toEqual({
      id: 101,
      name: 'Statistics',
      courseCode: 'STT 215',
      currentScore: 91.5,
      currentGrade: 'A-',
    });
    expect(detail!.assignments.map((a) => a.name)).toEqual(['Problem Set 1']);
    expect(detail!.files).toEqual([{ id: 7, displayName: 'Lecture 1.pdf', contentType: 'application/pdf', size: 1024 }]);
    expect(detail!.announcements.map((a) => a.title)).toEqual(['Welcome']);
    expect(detail!.contentSyncedAt).toBe('2026-08-18T00:00:00.000Z');
  });

  it('returns null for an unknown course id', () => {
    const db = makeDb();
    expect(getCourseDetail(db, 999)).toBeNull();
  });

  it('nests module items under their module', () => {
    const db = makeDb();
    seedCourseContent(db);

    const detail = getCourseDetail(db, 101);

    expect(detail!.modules).toEqual([
      {
        id: 10,
        name: 'Week 1',
        items: [
          { id: 1000, title: 'Syllabus', type: 'Page', contentId: null, pageUrl: 'syllabus', externalUrl: null },
          { id: 1001, title: 'Slides', type: 'File', contentId: 7, pageUrl: null, externalUrl: null },
        ],
      },
    ]);
  });
});

describe('searchMaterials', () => {
  it('finds a file by partial display name', () => {
    const db = makeDb();
    seedCourseContent(db);

    const hits = searchMaterials(db, 'Lecture');

    expect(hits).toEqual([
      { kind: 'file', courseId: 101, courseName: 'Statistics', title: 'Lecture 1.pdf', fileId: 7, pageUrl: null },
    ]);
  });

  it('finds a page by partial title', () => {
    const db = makeDb();
    seedCourseContent(db);

    const hits = searchMaterials(db, 'syllab');

    expect(hits).toEqual([
      { kind: 'page', courseId: 101, courseName: 'Statistics', title: 'Syllabus', fileId: null, pageUrl: 'syllabus' },
    ]);
  });

  it('returns an empty array when nothing matches', () => {
    const db = makeDb();
    seedCourseContent(db);

    expect(searchMaterials(db, 'nonexistent-material')).toEqual([]);
  });

  it('escapes literal % and _ characters instead of treating them as wildcards', () => {
    const db = makeDb();
    // If % or _ in the query leaked through as SQL LIKE wildcards, this query
    // would spuriously match "50Xoff.pdf" too (% matches "", _ matches "X").
    db.prepare('insert into canvas_files (id, course_id, display_name) values (?,?,?)').run(7, 101, '50%_off.pdf');
    db.prepare('insert into canvas_files (id, course_id, display_name) values (?,?,?)').run(8, 101, '50Xoff.pdf');

    const hits = searchMaterials(db, '50%_off');

    expect(hits.map((h) => h.title)).toEqual(['50%_off.pdf']);
  });
});

describe('getPageBody', () => {
  it('returns the cached title and body for a known course/url pair', () => {
    const db = makeDb();
    seedCourseContent(db);

    expect(getPageBody(db, 101, 'syllabus')).toEqual({ title: 'Syllabus', body: '<p>Read this</p>' });
  });

  it('returns null for an unknown course/url pair', () => {
    const db = makeDb();
    seedCourseContent(db);

    expect(getPageBody(db, 101, 'missing')).toBeNull();
  });
});

describe('getOverdueAssignments', () => {
  const NOW = new Date('2026-08-22T12:00:00.000Z');

  function seed(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    db.prepare("insert into canvas_courses (id, name) values (1, 'Financial Accounting')").run();
    const insert = db.prepare(
      `insert into canvas_assignments (id, course_id, name, due_at, submission_types, has_submitted)
       values (?, 1, ?, ?, ?, ?)`
    );
    // Two days late, unsubmitted, real upload -> the case this exists for.
    insert.run(10, 'Missed upload', '2026-08-20T04:00:00Z', '["online_upload"]', 0);
    // Two days late but already submitted -> not overdue.
    insert.run(11, 'Turned in late', '2026-08-20T04:00:00Z', '["online_upload"]', 1);
    // Two days late, nothing to submit -> noise, must be excluded.
    insert.run(12, 'Attendance 8/20', '2026-08-20T04:00:00Z', '["none"]', 0);
    // Two days late, LTI tool -> still the user's problem, must be kept.
    insert.run(13, 'Connect homework', '2026-08-20T04:00:00Z', '["external_tool"]', 0);
    // Due in the future -> not overdue.
    insert.run(14, 'Next week', '2026-08-29T04:00:00Z', '["online_upload"]', 0);
    // 40 days late -> outside a 14-day window.
    insert.run(15, 'Ancient history', '2026-07-13T04:00:00Z', '["online_upload"]', 0);
    // No due date at all -> never overdue.
    insert.run(16, 'Undated', null, '["online_upload"]', 0);
    return db;
  }

  it('returns unsubmitted assignments whose due date has passed', () => {
    const rows = getOverdueAssignments(seed(), 14, NOW);
    expect(rows.map((row) => row.id)).toContain(10);
  });

  it('excludes assignments that were already submitted', () => {
    const rows = getOverdueAssignments(seed(), 14, NOW);
    expect(rows.map((row) => row.id)).not.toContain(11);
  });

  it('excludes assignments with nothing to submit', () => {
    // ~24% of a real semester is submission_types ["none"] -- attendance and
    // gradebook placeholders. Without this filter the section is all noise.
    const rows = getOverdueAssignments(seed(), 14, NOW);
    expect(rows.map((row) => row.id)).not.toContain(12);
  });

  it('keeps external_tool assignments, which the user still has to go do', () => {
    const rows = getOverdueAssignments(seed(), 14, NOW);
    expect(rows.map((row) => row.id)).toContain(13);
  });

  it('excludes an external_tool assignment graded via LTI passback even without a submission timestamp', () => {
    // Canvas's grade-passback from an LTI tool (Connect, MyLab, Cengage)
    // routinely sets workflow_state to 'graded' without ever setting
    // submitted_at, so has_submitted stays 0 for work the student already
    // finished. Row 13 (still ungraded) above proves the filter isn't a
    // blanket exclusion of external_tool rows -- only graded ones drop out.
    const db = seed();
    db.prepare(
      `insert into canvas_assignments (id, course_id, name, due_at, submission_types, has_submitted, workflow_state, score)
       values (18, 1, 'Graded LTI lab', '2026-08-20T04:00:00Z', '["external_tool"]', 0, 'graded', 18)`
    ).run();
    const rows = getOverdueAssignments(db, 14, NOW);
    expect(rows.map((row) => row.id)).not.toContain(18);
  });

  it('excludes assignments that are not due yet', () => {
    const rows = getOverdueAssignments(seed(), 14, NOW);
    expect(rows.map((row) => row.id)).not.toContain(14);
  });

  it('excludes assignments older than the window', () => {
    const rows = getOverdueAssignments(seed(), 14, NOW);
    expect(rows.map((row) => row.id)).not.toContain(15);
  });

  it('excludes assignments with no due date', () => {
    const rows = getOverdueAssignments(seed(), 14, NOW);
    expect(rows.map((row) => row.id)).not.toContain(16);
  });

  it('orders the most recently missed first', () => {
    const db = seed();
    db.prepare(
      `insert into canvas_assignments (id, course_id, name, due_at, submission_types, has_submitted)
       values (17, 1, 'Missed yesterday', '2026-08-21T04:00:00Z', '["online_upload"]', 0)`
    ).run();
    const rows = getOverdueAssignments(db, 14, NOW);
    expect(rows[0].id).toBe(17);
  });

  it('resolves the course name', () => {
    const rows = getOverdueAssignments(seed(), 14, NOW);
    expect(rows[0].courseName).toBe('Financial Accounting');
  });
});
