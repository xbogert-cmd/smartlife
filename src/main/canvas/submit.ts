import { basename, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import type { CanvasCredentials } from './client';
import { CanvasAuthError, CanvasForbiddenError, CanvasRequireInitialPostError } from './errors';
import { getMySubmission, postDiscussionEntry, postSubmission } from './api';
import { CanvasUploadError, uploadSubmissionFile } from './upload';
import { getAssignmentDetail } from './queries';
import { clearDraft } from './drafts';

export type SubmitInput =
  | { kind: 'text'; body: string }
  | { kind: 'file'; filePath: string }
  | { kind: 'discussion'; message: string };

export interface SubmitOutcome {
  ok: boolean;
  /**
   * True only when Canvas confirmed the submission on read-back. `ok && !verified`
   * is a real third state — Canvas took it, we could not prove it — and callers
   * must not flatten it into either success or failure.
   */
  verified: boolean;
  submittedAt: string | null;
  message: string;
}

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.rtf': 'application/rtf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.heic': 'image/heic',
  '.zip': 'application/zip',
  '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Canvas guesses from the extension when content_type is unhelpful, so a
 *  generic fallback is safe — but naming the common ones avoids surprises. */
function contentTypeFor(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function failure(message: string): SubmitOutcome {
  return { ok: false, verified: false, submittedAt: null, message };
}

function describeError(error: unknown): string {
  if (error instanceof CanvasRequireInitialPostError) {
    return 'You have to post before you can see the thread. Post your entry first.';
  }
  if (error instanceof CanvasAuthError) {
    return 'Canvas rejected the access token. Add a fresh one in Settings.';
  }
  if (error instanceof CanvasForbiddenError) {
    return 'Canvas refused the submission. Your school may not allow submitting through the API — use the browser instead.';
  }
  if (error instanceof CanvasUploadError) {
    if (error.step === 1) return "Canvas wouldn't start the upload. The file may be too large or over your quota.";
    if (error.step === 2) return "The file didn't finish uploading. Try again.";
    return "The file uploaded, but Canvas didn't confirm it. Nothing was submitted.";
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The single submission path. Both the UI button and the AI tool call this, so
 * there is one confirmation gate in front of it and one verification behind it.
 *
 * Callers must run this inside the Canvas scheduler's exclusivity guard so a
 * user-initiated submission never overlaps a background sync.
 */
export async function submitAssignment(
  db: Database.Database,
  creds: CanvasCredentials,
  assignmentId: number,
  input: SubmitInput
): Promise<SubmitOutcome> {
  const detail = getAssignmentDetail(db, assignmentId);
  if (detail === null) return failure('That assignment is not in the local database.');

  const path = detail.path;

  if (path.kind === 'handoff') {
    return failure(
      'This assignment has to be completed in the browser — Canvas has no API for submitting it.'
    );
  }
  if (path.kind === 'none') {
    return failure('This assignment does not take a submission.');
  }

  // The input has to match what the assignment actually accepts. A mismatch is
  // a caller bug (or a confused model), not something to coerce.
  const textAllowed = path.kind === 'text' || path.kind === 'text-or-file';
  const fileAllowed = path.kind === 'file' || path.kind === 'text-or-file';
  if (input.kind === 'text' && !textAllowed) {
    return failure('This assignment does not accept a text entry.');
  }
  if (input.kind === 'file' && !fileAllowed) {
    return failure('This assignment does not accept a file upload.');
  }
  if (input.kind === 'discussion' && path.kind !== 'discussion') {
    return failure('This assignment is not a discussion.');
  }
  if (path.kind === 'discussion' && input.kind !== 'discussion') {
    return failure('This assignment is a discussion and needs a discussion post.');
  }

  // ---- Send it ----------------------------------------------------------
  try {
    if (input.kind === 'discussion' && path.kind === 'discussion') {
      await postDiscussionEntry(creds, detail.courseId, path.topicId, input.message);
    } else if (input.kind === 'text') {
      await postSubmission(creds, detail.courseId, assignmentId, {
        submission_type: 'online_text_entry',
        body: input.body,
      });
    } else if (input.kind === 'file') {
      const data = await readFile(input.filePath);
      const fileId = await uploadSubmissionFile(creds, detail.courseId, assignmentId, {
        name: basename(input.filePath),
        size: data.byteLength,
        contentType: contentTypeFor(input.filePath),
        data: new Uint8Array(data),
      });
      await postSubmission(creds, detail.courseId, assignmentId, {
        submission_type: 'online_upload',
        file_ids: [fileId],
      });
    } else {
      // Unreachable through the validated UI/AI paths, but canvas:submit's IPC
      // handler performs no runtime validation of input.kind — an untyped or
      // malformed payload must fail loudly here rather than silently skip
      // every branch and fall through into verification.
      return failure('Unsupported submission input.');
    }
  } catch (error) {
    return failure(describeError(error));
  }

  // ---- Verify against the server, never against our own optimism --------
  let confirmed;
  try {
    confirmed = await getMySubmission(creds, detail.courseId, assignmentId);
  } catch {
    return {
      ok: true,
      verified: false,
      submittedAt: null,
      message: "Submitted, but we couldn't confirm it — check Canvas.",
    };
  }

  // "The read-back call didn't throw" is not proof Canvas actually recorded
  // anything — a 200 with submitted_at still null (a lagging record, or a
  // no-op accept) must not be treated as confirmation.
  const submittedAt = confirmed.submitted_at;
  if (typeof submittedAt !== 'string' || submittedAt.length === 0) {
    return {
      ok: true,
      verified: false,
      submittedAt: null,
      message: "Submitted, but Canvas hasn't recorded it yet — check Canvas.",
    };
  }

  db.prepare(
    `update canvas_assignments
     set has_submitted = 1, submitted_at = ?, score = ?, grade = ?, workflow_state = ?
     where id = ?`
  ).run(
    submittedAt,
    confirmed.score ?? null,
    confirmed.grade ?? null,
    confirmed.workflow_state ?? null,
    assignmentId
  );

  clearDraft(db, assignmentId);

  return {
    ok: true,
    verified: true,
    submittedAt,
    message: 'Submitted and confirmed by Canvas.',
  };
}
