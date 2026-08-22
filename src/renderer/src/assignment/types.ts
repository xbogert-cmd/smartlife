/** Mirrors src/main/canvas/submission.ts. Keep the two in step. */
export type SubmissionPath =
  | { kind: 'text' }
  | { kind: 'file' }
  | { kind: 'text-or-file' }
  | { kind: 'discussion'; topicId: number }
  | { kind: 'handoff'; reason: 'external_tool' | 'quiz' | 'unresolved_discussion' }
  | { kind: 'none' };

/** Mirrors AssignmentDetail in src/main/canvas/queries.ts. */
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
  path: SubmissionPath;
  draft: string | null;
}

export type SubmitInput =
  | { kind: 'text'; body: string }
  | { kind: 'file'; filePath: string }
  | { kind: 'discussion'; message: string };

export interface SubmitOutcome {
  ok: boolean;
  verified: boolean;
  submittedAt: string | null;
  message: string;
}

export interface PickedFile {
  path: string;
  name: string;
  size: number;
}
