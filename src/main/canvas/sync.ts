import type Database from 'better-sqlite3';
import type { CanvasCredentials } from './client';
import { CanvasAuthError } from './errors';
import * as api from './api';
import type { CanvasAssignment, CanvasCourse } from './api';

export const SYNC_KEY_LAST_CORE = 'last_core_sync';
export const SYNC_KEY_TOKEN_INVALID = 'token_invalid';

export function courseContentKey(courseId: number): string {
  return `course:${courseId}:content_sync`;
}

export interface SyncResult {
  ok: boolean;
  coursesSynced: number;
  tokenInvalid: boolean;
  errors: string[];
}

export function getSyncState(db: Database.Database, key: string): string | null {
  const row = db.prepare('select value from canvas_sync_state where key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setSyncState(db: Database.Database, key: string, value: string): void {
  db.prepare(
    'insert into canvas_sync_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
  ).run(key, value);
}

export function clearSyncState(db: Database.Database, key: string): void {
  db.prepare('delete from canvas_sync_state where key = ?').run(key);
}

function courseGrade(course: CanvasCourse): { score: number | null; grade: string | null } {
  const enrollments = course.enrollments ?? [];
  const student = enrollments.find((e) => e.type === 'student') ?? enrollments[0];
  return {
    score: student?.computed_current_score ?? null,
    grade: student?.computed_current_grade ?? null,
  };
}

function upsertCourses(db: Database.Database, courses: CanvasCourse[], syncedAt: string): void {
  const upsert = db.prepare(
    `insert into canvas_courses (id, name, course_code, term_name, current_score, current_grade, synced_at)
     values (@id, @name, @course_code, @term_name, @current_score, @current_grade, @synced_at)
     on conflict(id) do update set
       name = excluded.name, course_code = excluded.course_code, term_name = excluded.term_name,
       current_score = excluded.current_score, current_grade = excluded.current_grade,
       synced_at = excluded.synced_at`
  );
  const run = db.transaction((rows: CanvasCourse[]) => {
    for (const course of rows) {
      const { score, grade } = courseGrade(course);
      upsert.run({
        id: course.id,
        name: course.name,
        course_code: course.course_code ?? null,
        term_name: course.term?.name ?? null,
        current_score: score,
        current_grade: grade,
        synced_at: syncedAt,
      });
    }
    // Drop courses no longer returned by Canvas; children cascade.
    const keep = rows.map((c) => c.id);
    const placeholders = keep.map(() => '?').join(',');
    if (keep.length === 0) {
      db.prepare('delete from canvas_courses').run();
    } else {
      db.prepare(`delete from canvas_courses where id not in (${placeholders})`).run(...keep);
    }
  });
  run(courses);
}

function upsertAssignments(
  db: Database.Database,
  courseId: number,
  assignments: CanvasAssignment[],
  syncedAt: string
): void {
  const upsert = db.prepare(
    `insert into canvas_assignments
       (id, course_id, name, description, due_at, points_possible, html_url, submission_types,
        has_submitted, submitted_at, score, grade, workflow_state, synced_at)
     values
       (@id, @course_id, @name, @description, @due_at, @points_possible, @html_url, @submission_types,
        @has_submitted, @submitted_at, @score, @grade, @workflow_state, @synced_at)
     on conflict(id) do update set
       name = excluded.name, description = excluded.description, due_at = excluded.due_at,
       points_possible = excluded.points_possible, html_url = excluded.html_url,
       submission_types = excluded.submission_types, has_submitted = excluded.has_submitted,
       submitted_at = excluded.submitted_at, score = excluded.score, grade = excluded.grade,
       workflow_state = excluded.workflow_state, synced_at = excluded.synced_at`
  );
  const run = db.transaction((rows: CanvasAssignment[]) => {
    for (const assignment of rows) {
      const submission = assignment.submission ?? null;
      upsert.run({
        id: assignment.id,
        course_id: courseId,
        name: assignment.name,
        description: assignment.description ?? null,
        due_at: assignment.due_at ?? null,
        points_possible: assignment.points_possible ?? null,
        html_url: assignment.html_url ?? null,
        submission_types: JSON.stringify(assignment.submission_types ?? []),
        has_submitted: submission?.submitted_at ? 1 : 0,
        submitted_at: submission?.submitted_at ?? null,
        score: submission?.score ?? null,
        grade: submission?.grade ?? null,
        workflow_state: submission?.workflow_state ?? null,
        synced_at: syncedAt,
      });
    }
    const keep = rows.map((a) => a.id);
    if (keep.length === 0) {
      db.prepare('delete from canvas_assignments where course_id = ?').run(courseId);
    } else {
      const placeholders = keep.map(() => '?').join(',');
      db.prepare(
        `delete from canvas_assignments where course_id = ? and id not in (${placeholders})`
      ).run(courseId, ...keep);
    }
  });
  run(assignments);
}

/**
 * Tier-1 sync: courses + grades, assignments per course, announcements.
 * Requests run STRICTLY SERIALLY — Instructure advises against concurrent
 * requests, and parallelising this would incur a pre-flight quota penalty.
 */
export async function syncCore(
  db: Database.Database,
  creds: CanvasCredentials,
  now: Date = new Date()
): Promise<SyncResult> {
  const syncedAt = now.toISOString();
  const errors: string[] = [];

  let courses: CanvasCourse[];
  try {
    courses = await api.listCourses(creds);
  } catch (error) {
    if (error instanceof CanvasAuthError) {
      setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');
      return { ok: false, coursesSynced: 0, tokenInvalid: true, errors: [error.message] };
    }
    return {
      ok: false,
      coursesSynced: 0,
      tokenInvalid: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  upsertCourses(db, courses, syncedAt);

  for (const course of courses) {
    try {
      const assignments = await api.listAssignments(creds, course.id);
      upsertAssignments(db, course.id, assignments, syncedAt);
    } catch (error) {
      if (error instanceof CanvasAuthError) {
        setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');
        return { ok: false, coursesSynced: 0, tokenInvalid: true, errors: [error.message] };
      }
      errors.push(`${course.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const known = new Set(courses.map((c) => c.id));
    const announcements = await api.listAnnouncements(creds, courses.map((c) => c.id));
    const upsert = db.prepare(
      `insert into canvas_announcements (id, course_id, title, message, posted_at, html_url, synced_at)
       values (@id, @course_id, @title, @message, @posted_at, @html_url, @synced_at)
       on conflict(id) do update set
         title = excluded.title, message = excluded.message, posted_at = excluded.posted_at,
         html_url = excluded.html_url, synced_at = excluded.synced_at`
    );
    db.transaction(() => {
      for (const announcement of announcements) {
        const courseId = Number.parseInt((announcement.context_code ?? '').replace('course_', ''), 10);
        // Canvas can return announcements for contexts outside the active set;
        // inserting those would violate the foreign key.
        if (!Number.isFinite(courseId) || !known.has(courseId)) continue;
        upsert.run({
          id: announcement.id,
          course_id: courseId,
          title: announcement.title ?? null,
          message: announcement.message ?? null,
          posted_at: announcement.posted_at ?? null,
          html_url: announcement.html_url ?? null,
          synced_at: syncedAt,
        });
      }
    })();
  } catch (error) {
    if (error instanceof CanvasAuthError) {
      setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');
      return { ok: false, coursesSynced: courses.length, tokenInvalid: true, errors: [error.message] };
    }
    errors.push(`Announcements: ${error instanceof Error ? error.message : String(error)}`);
  }

  clearSyncState(db, SYNC_KEY_TOKEN_INVALID);
  setSyncState(db, SYNC_KEY_LAST_CORE, syncedAt);
  return { ok: true, coursesSynced: courses.length, tokenInvalid: false, errors };
}
