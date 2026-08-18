import type Database from 'better-sqlite3';
import { getCanvasBaseUrl, getTokenAgeDays, hasCanvasToken, TOKEN_WARN_AFTER_DAYS } from './token';
import { getSyncState, SYNC_KEY_LAST_CORE, SYNC_KEY_TOKEN_INVALID } from './sync';

export interface UpcomingAssignment {
  id: number;
  courseId: number;
  courseName: string;
  name: string;
  dueAt: string;
  pointsPossible: number | null;
  hasSubmitted: boolean;
  htmlUrl: string | null;
}

export interface CourseGrade {
  id: number;
  name: string;
  courseCode: string | null;
  currentScore: number | null;
  currentGrade: string | null;
}

export interface AnnouncementRow {
  id: number;
  courseId: number;
  courseName: string;
  title: string | null;
  message: string | null;
  postedAt: string | null;
}

export interface CanvasSyncStatus {
  tokenConfigured: boolean;
  baseUrlConfigured: boolean;
  lastSyncedAt: string | null;
  tokenInvalid: boolean;
  tokenAgeDays: number | null;
  tokenExpiringSoon: boolean;
}

const MS_PER_DAY = 86_400_000;

export function getUpcomingAssignments(
  db: Database.Database,
  days: number,
  now: Date = new Date()
): UpcomingAssignment[] {
  const from = now.toISOString();
  const to = new Date(now.getTime() + days * MS_PER_DAY).toISOString();
  const rows = db
    .prepare(
      `select a.id, a.course_id, c.name as course_name, a.name, a.due_at,
              a.points_possible, a.has_submitted, a.html_url
       from canvas_assignments a
       join canvas_courses c on c.id = a.course_id
       where a.due_at is not null and a.due_at >= ? and a.due_at <= ?
       order by a.due_at, a.id`
    )
    .all(from, to) as Array<{
    id: number;
    course_id: number;
    course_name: string;
    name: string;
    due_at: string;
    points_possible: number | null;
    has_submitted: number;
    html_url: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    courseId: row.course_id,
    courseName: row.course_name,
    name: row.name,
    dueAt: row.due_at,
    pointsPossible: row.points_possible,
    hasSubmitted: row.has_submitted === 1,
    htmlUrl: row.html_url,
  }));
}

export function getCourseGrades(db: Database.Database): CourseGrade[] {
  const rows = db
    .prepare(
      'select id, name, course_code, current_score, current_grade from canvas_courses order by name, id'
    )
    .all() as Array<{
    id: number;
    name: string;
    course_code: string | null;
    current_score: number | null;
    current_grade: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    courseCode: row.course_code,
    currentScore: row.current_score,
    currentGrade: row.current_grade,
  }));
}

export function getRecentAnnouncements(db: Database.Database, limit: number): AnnouncementRow[] {
  const rows = db
    .prepare(
      `select n.id, n.course_id, c.name as course_name, n.title, n.message, n.posted_at
       from canvas_announcements n
       join canvas_courses c on c.id = n.course_id
       order by n.posted_at desc, n.id desc
       limit ?`
    )
    .all(limit) as Array<{
    id: number;
    course_id: number;
    course_name: string;
    title: string | null;
    message: string | null;
    posted_at: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    courseId: row.course_id,
    courseName: row.course_name,
    title: row.title,
    message: row.message,
    postedAt: row.posted_at,
  }));
}

export function getSyncStatus(db: Database.Database, now: Date = new Date()): CanvasSyncStatus {
  const tokenAgeDays = getTokenAgeDays(db, now);
  return {
    tokenConfigured: hasCanvasToken(db),
    baseUrlConfigured: getCanvasBaseUrl(db) !== null,
    lastSyncedAt: getSyncState(db, SYNC_KEY_LAST_CORE),
    tokenInvalid: getSyncState(db, SYNC_KEY_TOKEN_INVALID) === '1',
    tokenAgeDays,
    tokenExpiringSoon: tokenAgeDays !== null && tokenAgeDays >= TOKEN_WARN_AFTER_DAYS,
  };
}
