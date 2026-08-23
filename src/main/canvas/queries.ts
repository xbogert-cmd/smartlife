import type Database from 'better-sqlite3';
import { getCanvasBaseUrl, getTokenAgeDays, hasCanvasToken, TOKEN_WARN_AFTER_DAYS } from './token';
import { courseContentKey, getSyncState, SYNC_KEY_LAST_CORE, SYNC_KEY_TOKEN_INVALID } from './sync';
import { classifySubmission, type SubmissionPath } from './submission';
import { getDraft } from './drafts';

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

/**
 * Assignments whose due date has passed without a submission.
 *
 * getUpcomingAssignments only looks forward (`due_at >= now`), so a missed
 * deadline disappears from every surface in the app. This is the query that
 * puts it back.
 *
 * Rows with nothing to submit are dropped: roughly a quarter of a real
 * semester is submission_types ["none"] -- attendance rows, participation,
 * gradebook placeholders -- and a "needs attention" list full of them is
 * noise the user learns to ignore.
 */
export function getOverdueAssignments(
  db: Database.Database,
  days: number,
  now: Date = new Date()
): UpcomingAssignment[] {
  const from = new Date(now.getTime() - days * MS_PER_DAY).toISOString();
  const to = now.toISOString();
  const rows = db
    .prepare(
      `select a.id, a.course_id, c.name as course_name, a.name, a.due_at,
              a.points_possible, a.has_submitted, a.html_url, a.submission_types
       from canvas_assignments a
       join canvas_courses c on c.id = a.course_id
       where a.due_at is not null and a.due_at >= ? and a.due_at < ?
         and a.has_submitted = 0
       order by a.due_at desc, a.id`
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
    submission_types: string | null;
  }>;

  return rows
    // The topic id is irrelevant here: every path except 'none' means there is
    // something to hand in, and that is the only question being asked.
    .filter((row) => classifySubmission(row.submission_types, null).kind !== 'none')
    .map((row) => ({
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

export interface CourseAssignment {
  id: number;
  name: string;
  dueAt: string | null;
  pointsPossible: number | null;
  hasSubmitted: boolean;
  score: number | null;
  grade: string | null;
  htmlUrl: string | null;
}

export interface ModuleItemRow {
  id: number;
  title: string | null;
  type: string | null;
  contentId: number | null;
  pageUrl: string | null;
  externalUrl: string | null;
}

export interface ModuleWithItems {
  id: number;
  name: string | null;
  items: ModuleItemRow[];
}

export interface FileRow {
  id: number;
  displayName: string | null;
  contentType: string | null;
  size: number | null;
}

export interface CourseDetail {
  course: CourseGrade;
  assignments: CourseAssignment[];
  modules: ModuleWithItems[];
  files: FileRow[];
  announcements: AnnouncementRow[];
  contentSyncedAt: string | null;
}

export interface MaterialHit {
  kind: 'file' | 'page';
  courseId: number;
  courseName: string;
  title: string;
  fileId: number | null;
  pageUrl: string | null;
}

export function getCourseDetail(db: Database.Database, courseId: number): CourseDetail | null {
  const course = db
    .prepare('select id, name, course_code, current_score, current_grade from canvas_courses where id = ?')
    .get(courseId) as
    | { id: number; name: string; course_code: string | null; current_score: number | null; current_grade: string | null }
    | undefined;
  if (!course) return null;

  const assignments = (
    db
      .prepare(
        `select id, name, due_at, points_possible, has_submitted, score, grade, html_url
         from canvas_assignments where course_id = ?
         order by case when due_at is null then 1 else 0 end, due_at, id`
      )
      .all(courseId) as Array<{
      id: number;
      name: string;
      due_at: string | null;
      points_possible: number | null;
      has_submitted: number;
      score: number | null;
      grade: string | null;
      html_url: string | null;
    }>
  ).map((row) => ({
    id: row.id,
    name: row.name,
    dueAt: row.due_at,
    pointsPossible: row.points_possible,
    hasSubmitted: row.has_submitted === 1,
    score: row.score,
    grade: row.grade,
    htmlUrl: row.html_url,
  }));

  const moduleRows = db
    .prepare('select id, name from canvas_modules where course_id = ? order by position, id')
    .all(courseId) as { id: number; name: string | null }[];

  const itemStmt = db.prepare(
    `select id, title, type, content_id, page_url, external_url
     from canvas_module_items where module_id = ? order by position, id`
  );

  const modules: ModuleWithItems[] = moduleRows.map((module) => ({
    id: module.id,
    name: module.name,
    items: (
      itemStmt.all(module.id) as Array<{
        id: number;
        title: string | null;
        type: string | null;
        content_id: number | null;
        page_url: string | null;
        external_url: string | null;
      }>
    ).map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      contentId: item.content_id,
      pageUrl: item.page_url,
      externalUrl: item.external_url,
    })),
  }));

  const files = (
    db
      .prepare('select id, display_name, content_type, size from canvas_files where course_id = ? order by display_name, id')
      .all(courseId) as Array<{ id: number; display_name: string | null; content_type: string | null; size: number | null }>
  ).map((row) => ({ id: row.id, displayName: row.display_name, contentType: row.content_type, size: row.size }));

  const announcements = (
    db
      .prepare(
        `select n.id, n.course_id, c.name as course_name, n.title, n.message, n.posted_at
         from canvas_announcements n join canvas_courses c on c.id = n.course_id
         where n.course_id = ? order by n.posted_at desc, n.id desc`
      )
      .all(courseId) as Array<{
      id: number;
      course_id: number;
      course_name: string;
      title: string | null;
      message: string | null;
      posted_at: string | null;
    }>
  ).map((row) => ({
    id: row.id,
    courseId: row.course_id,
    courseName: row.course_name,
    title: row.title,
    message: row.message,
    postedAt: row.posted_at,
  }));

  return {
    course: {
      id: course.id,
      name: course.name,
      courseCode: course.course_code,
      currentScore: course.current_score,
      currentGrade: course.current_grade,
    },
    assignments,
    modules,
    files,
    announcements,
    contentSyncedAt: getSyncState(db, courseContentKey(courseId)),
  };
}

export function searchMaterials(db: Database.Database, query: string, limit = 25): MaterialHit[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const like = `%${trimmed.replace(/[%_]/g, (c) => `\\${c}`)}%`;

  const files = db
    .prepare(
      `select f.id, f.display_name, f.course_id, c.name as course_name
       from canvas_files f join canvas_courses c on c.id = f.course_id
       where f.display_name like ? escape '\\'
       order by f.display_name, f.id limit ?`
    )
    .all(like, limit) as Array<{ id: number; display_name: string | null; course_id: number; course_name: string }>;

  const pages = db
    .prepare(
      `select p.url, p.title, p.course_id, c.name as course_name
       from canvas_pages p join canvas_courses c on c.id = p.course_id
       where p.title like ? escape '\\'
       order by p.title, p.url limit ?`
    )
    .all(like, limit) as Array<{ url: string; title: string | null; course_id: number; course_name: string }>;

  const hits: MaterialHit[] = [
    ...files.map((f) => ({
      kind: 'file' as const,
      courseId: f.course_id,
      courseName: f.course_name,
      title: f.display_name ?? 'Untitled file',
      fileId: f.id,
      pageUrl: null,
    })),
    ...pages.map((p) => ({
      kind: 'page' as const,
      courseId: p.course_id,
      courseName: p.course_name,
      title: p.title ?? p.url,
      fileId: null,
      pageUrl: p.url,
    })),
  ];

  return hits.slice(0, limit);
}

export function getPageBody(
  db: Database.Database,
  courseId: number,
  pageUrl: string
): { title: string | null; body: string | null } | null {
  const row = db
    .prepare('select title, body from canvas_pages where course_id = ? and url = ?')
    .get(courseId, pageUrl) as { title: string | null; body: string | null } | undefined;
  return row ?? null;
}

export interface AssignmentDetail {
  id: number;
  courseId: number;
  courseName: string;
  name: string;
  description: string | null;
  dueAt: string | null;
  pointsPossible: number | null;
  htmlUrl: string | null;
  hasSubmitted: boolean;
  submittedAt: string | null;
  score: number | null;
  grade: string | null;
  workflowState: string | null;
  /** Resolved once here so every consumer reads the same classification. */
  path: SubmissionPath;
  draft: string | null;
}

export function getAssignmentDetail(
  db: Database.Database,
  assignmentId: number
): AssignmentDetail | null {
  const row = db
    .prepare(
      `select a.id, a.course_id, c.name as course_name, a.name, a.description, a.due_at,
              a.points_possible, a.html_url, a.submission_types, a.has_submitted,
              a.submitted_at, a.score, a.grade, a.workflow_state
       from canvas_assignments a
       join canvas_courses c on c.id = a.course_id
       where a.id = ?`
    )
    .get(assignmentId) as
    | {
        id: number;
        course_id: number;
        course_name: string;
        name: string;
        description: string | null;
        due_at: string | null;
        points_possible: number | null;
        html_url: string | null;
        submission_types: string | null;
        has_submitted: number;
        submitted_at: string | null;
        score: number | null;
        grade: string | null;
        workflow_state: string | null;
      }
    | undefined;

  if (row === undefined) return null;

  // Canvas only links topic -> assignment, so this lookup is the reverse
  // direction and returns undefined until the topic has synced.
  const topic = db
    .prepare('select id from canvas_discussion_topics where assignment_id = ? limit 1')
    .get(assignmentId) as { id: number } | undefined;

  return {
    id: row.id,
    courseId: row.course_id,
    courseName: row.course_name,
    name: row.name,
    description: row.description,
    dueAt: row.due_at,
    pointsPossible: row.points_possible,
    htmlUrl: row.html_url,
    hasSubmitted: row.has_submitted === 1,
    submittedAt: row.submitted_at,
    score: row.score,
    grade: row.grade,
    workflowState: row.workflow_state,
    path: classifySubmission(row.submission_types, topic ? topic.id : null),
    draft: getDraft(db, assignmentId),
  };
}
