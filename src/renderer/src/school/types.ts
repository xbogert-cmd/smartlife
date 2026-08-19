export interface CanvasSyncStatus {
  tokenConfigured: boolean;
  baseUrlConfigured: boolean;
  lastSyncedAt: string | null;
  tokenInvalid: boolean;
  tokenAgeDays: number | null;
  tokenExpiringSoon: boolean;
}

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

export const SCHOOL_ACCENT = '#3B82F6';
