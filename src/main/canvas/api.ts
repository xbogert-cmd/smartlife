import { canvasFetchAll, canvasFetchOne, type CanvasCredentials } from './client';

export interface CanvasUser {
  id: number;
  name: string;
}

export interface CanvasEnrollment {
  type?: string;
  computed_current_score?: number | null;
  computed_current_grade?: string | null;
}

export interface CanvasCourse {
  id: number;
  name: string;
  course_code?: string;
  term?: { name?: string };
  enrollments?: CanvasEnrollment[];
}

export interface CanvasSubmission {
  submitted_at?: string | null;
  score?: number | null;
  grade?: string | null;
  workflow_state?: string;
}

export interface CanvasAssignment {
  id: number;
  name: string;
  description?: string | null;
  due_at?: string | null;
  points_possible?: number | null;
  html_url?: string;
  submission_types?: string[];
  submission?: CanvasSubmission | null;
}

export interface CanvasAnnouncement {
  id: number;
  title?: string;
  message?: string;
  posted_at?: string | null;
  html_url?: string;
  context_code?: string;
}

export interface CanvasModuleItem {
  id: number;
  title?: string;
  type?: string;
  content_id?: number | null;
  page_url?: string | null;
  html_url?: string | null;
  external_url?: string | null;
  position?: number;
}

export interface CanvasModule {
  id: number;
  name?: string;
  position?: number;
  items?: CanvasModuleItem[];
}

export interface CanvasFile {
  id: number;
  display_name?: string;
  filename?: string;
  'content-type'?: string;
  size?: number;
  updated_at?: string;
  url?: string;
}

export interface CanvasPage {
  url: string;
  title?: string;
  body?: string | null;
  updated_at?: string;
}

export function getSelf(creds: CanvasCredentials): Promise<CanvasUser> {
  return canvasFetchOne<CanvasUser>(creds, '/api/v1/users/self');
}

/**
 * One request returns every active course AND its current grade —
 * `include[]=total_scores` puts computed_current_score on the enrollment,
 * so the grade dashboard costs no extra calls.
 */
export function listCourses(creds: CanvasCredentials): Promise<CanvasCourse[]> {
  return canvasFetchAll<CanvasCourse>(creds, '/api/v1/courses', {
    'include[]': ['total_scores', 'term'],
    enrollment_state: 'active',
    'state[]': ['available'],
  });
}

export function listAssignments(creds: CanvasCredentials, courseId: number): Promise<CanvasAssignment[]> {
  return canvasFetchAll<CanvasAssignment>(creds, `/api/v1/courses/${courseId}/assignments`, {
    'include[]': ['submission'],
  });
}

/** One call covers every course, via repeated context_codes[] params. */
export function listAnnouncements(
  creds: CanvasCredentials,
  courseIds: number[]
): Promise<CanvasAnnouncement[]> {
  if (courseIds.length === 0) return Promise.resolve([]);
  return canvasFetchAll<CanvasAnnouncement>(creds, '/api/v1/announcements', {
    'context_codes[]': courseIds.map((id) => `course_${id}`),
  });
}

/** `include[]=items` inlines module items, avoiding a request per module. */
export function listModules(creds: CanvasCredentials, courseId: number): Promise<CanvasModule[]> {
  return canvasFetchAll<CanvasModule>(creds, `/api/v1/courses/${courseId}/modules`, {
    'include[]': ['items'],
  });
}

/** Fallback for modules whose item list Canvas omitted (very large modules). */
export function listModuleItems(
  creds: CanvasCredentials,
  courseId: number,
  moduleId: number
): Promise<CanvasModuleItem[]> {
  return canvasFetchAll<CanvasModuleItem>(
    creds,
    `/api/v1/courses/${courseId}/modules/${moduleId}/items`
  );
}

export function listFiles(creds: CanvasCredentials, courseId: number): Promise<CanvasFile[]> {
  return canvasFetchAll<CanvasFile>(creds, `/api/v1/courses/${courseId}/files`);
}

export function getPage(
  creds: CanvasCredentials,
  courseId: number,
  pageUrl: string
): Promise<CanvasPage> {
  return canvasFetchOne<CanvasPage>(
    creds,
    `/api/v1/courses/${courseId}/pages/${encodeURIComponent(pageUrl)}`
  );
}

/** Canvas file URLs expire, so this is called at click time — never cached. */
export function getFile(creds: CanvasCredentials, fileId: number): Promise<CanvasFile> {
  return canvasFetchOne<CanvasFile>(creds, `/api/v1/files/${fileId}`);
}
