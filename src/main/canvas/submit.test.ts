import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('./api');
// A bare vi.mock('./upload') automocks CanvasUploadError too, and this
// vitest version's automock does not run the original constructor — every
// mocked CanvasUploadError would come back with `step` undefined. Keep the
// real class, mock only the function.
vi.mock('./upload', async () => {
  const actual = await vi.importActual<typeof import('./upload')>('./upload');
  return { ...actual, uploadSubmissionFile: vi.fn() };
});
vi.mock('node:fs/promises', () => {
  const readFile = vi.fn(async () => Buffer.from([1, 2, 3, 4]));
  return { readFile, default: { readFile } };
});

import * as api from './api';
import { CanvasUploadError, uploadSubmissionFile } from './upload';
import { CanvasAuthError, CanvasForbiddenError, CanvasRequireInitialPostError } from './errors';
import { submitAssignment } from './submit';
import { getDraft, saveDraft } from './drafts';

const CREDS = { baseUrl: 'https://uncw.instructure.com', token: 't' };

const SCHEMA = `
create table canvas_courses (
  id integer primary key, name text not null, course_code text,
  term_name text, current_score real, current_grade text,
  synced_at text not null default (datetime('now'))
);
create table canvas_assignments (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  name text not null, description text, due_at text, points_possible real,
  html_url text, submission_types text, has_submitted integer not null default 0,
  submitted_at text, score real, grade text, workflow_state text,
  synced_at text not null default (datetime('now'))
);
create table canvas_discussion_topics (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  assignment_id integer, title text,
  require_initial_post integer not null default 0,
  synced_at text not null default (datetime('now'))
);
create table assignment_drafts (
  assignment_id integer primary key references canvas_assignments(id) on delete cascade,
  body text not null,
  updated_at text not null default (datetime('now'))
);
`;

function setup(submissionTypes: string): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare("insert into canvas_courses (id, name) values (1, 'ACG')").run();
  db.prepare(
    "insert into canvas_assignments (id, course_id, name, submission_types) values (10, 1, 'Ch 4', ?)"
  ).run(submissionTypes);
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getMySubmission).mockResolvedValue({
    id: 900,
    submitted_at: '2026-08-22T12:00:00Z',
    workflow_state: 'submitted',
    score: null,
    grade: null,
  });
  vi.mocked(api.postSubmission).mockResolvedValue({ id: 900 });
  vi.mocked(api.postDiscussionEntry).mockResolvedValue({ id: 33 });
  vi.mocked(uploadSubmissionFile).mockResolvedValue(77);
});

describe('submitAssignment — text', () => {
  it('submits the body as online_text_entry and verifies', async () => {
    const db = setup('["online_text_entry"]');
    const outcome = await submitAssignment(db, CREDS, 10, { kind: 'text', body: '<p>done</p>' });

    expect(api.postSubmission).toHaveBeenCalledWith(CREDS, 1, 10, {
      submission_type: 'online_text_entry',
      body: '<p>done</p>',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.verified).toBe(true);
    expect(outcome.submittedAt).toBe('2026-08-22T12:00:00Z');
  });

  it('writes what the server reported back to the database', async () => {
    const db = setup('["online_text_entry"]');
    await submitAssignment(db, CREDS, 10, { kind: 'text', body: 'x' });

    const row = db
      .prepare('select has_submitted, submitted_at, workflow_state from canvas_assignments where id = 10')
      .get() as { has_submitted: number; submitted_at: string; workflow_state: string };
    expect(row).toEqual({
      has_submitted: 1,
      submitted_at: '2026-08-22T12:00:00Z',
      workflow_state: 'submitted',
    });
  });

  it('clears the draft after a confirmed submission', async () => {
    const db = setup('["online_text_entry"]');
    saveDraft(db, 10, 'x');
    await submitAssignment(db, CREDS, 10, { kind: 'text', body: 'x' });
    expect(getDraft(db, 10)).toBeNull();
  });

  it('accepts text for a text-or-file assignment', async () => {
    const db = setup('["online_text_entry","online_upload"]');
    const outcome = await submitAssignment(db, CREDS, 10, { kind: 'text', body: 'x' });
    expect(outcome.ok).toBe(true);
  });
});

describe('submitAssignment — file', () => {
  it('uploads first, then submits the returned file id', async () => {
    const db = setup('["online_upload"]');
    const outcome = await submitAssignment(db, CREDS, 10, { kind: 'file', filePath: '/tmp/essay.pdf' });

    expect(uploadSubmissionFile).toHaveBeenCalled();
    expect(api.postSubmission).toHaveBeenCalledWith(CREDS, 1, 10, {
      submission_type: 'online_upload',
      file_ids: [77],
    });
    expect(outcome.ok).toBe(true);
  });

  it('never submits when the upload failed', async () => {
    vi.mocked(uploadSubmissionFile).mockRejectedValue(new CanvasUploadError(2, 'dropped'));
    const db = setup('["online_upload"]');

    const outcome = await submitAssignment(db, CREDS, 10, { kind: 'file', filePath: '/tmp/x.pdf' });

    expect(api.postSubmission).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("didn't finish uploading");
  });

  it('distinguishes a step-1 upload failure from a rejected file', async () => {
    vi.mocked(uploadSubmissionFile).mockRejectedValue(new CanvasUploadError(1, 'quota'));
    const db = setup('["online_upload"]');
    const outcome = await submitAssignment(db, CREDS, 10, { kind: 'file', filePath: '/tmp/x.pdf' });
    expect(outcome.message).toContain("wouldn't start the upload");
  });

  it('distinguishes a step-3 confirmation failure', async () => {
    vi.mocked(uploadSubmissionFile).mockRejectedValue(new CanvasUploadError(3, 'no id'));
    const db = setup('["online_upload"]');
    const outcome = await submitAssignment(db, CREDS, 10, { kind: 'file', filePath: '/tmp/x.pdf' });
    expect(outcome.message).toContain("didn't confirm");
  });
});

describe('submitAssignment — discussion', () => {
  it('posts an entry rather than a submission', async () => {
    const db = setup('["discussion_topic"]');
    db.prepare('insert into canvas_discussion_topics (id, course_id, assignment_id) values (55, 1, 10)').run();

    const outcome = await submitAssignment(db, CREDS, 10, { kind: 'discussion', message: 'my post' });

    expect(api.postDiscussionEntry).toHaveBeenCalledWith(CREDS, 1, 55, 'my post');
    expect(api.postSubmission).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
  });

  it('names require_initial_post rather than reporting a permissions failure', async () => {
    vi.mocked(api.postDiscussionEntry).mockRejectedValue(new CanvasRequireInitialPostError());
    const db = setup('["discussion_topic"]');
    db.prepare('insert into canvas_discussion_topics (id, course_id, assignment_id) values (55, 1, 10)').run();

    const outcome = await submitAssignment(db, CREDS, 10, { kind: 'discussion', message: 'x' });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('post before you can see');
  });
});

describe('submitAssignment — refusals', () => {
  it('refuses an external tool assignment', async () => {
    const db = setup('["external_tool"]');
    const outcome = await submitAssignment(db, CREDS, 10, { kind: 'text', body: 'x' });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('browser');
    expect(api.postSubmission).not.toHaveBeenCalled();
  });

  it('refuses an assignment with nothing to submit', async () => {
    const db = setup('["none"]');
    const outcome = await submitAssignment(db, CREDS, 10, { kind: 'text', body: 'x' });
    expect(outcome.ok).toBe(false);
    expect(api.postSubmission).not.toHaveBeenCalled();
  });

  it('refuses an unknown assignment', async () => {
    const outcome = await submitAssignment(setup('["online_text_entry"]'), CREDS, 999, {
      kind: 'text',
      body: 'x',
    });
    expect(outcome.ok).toBe(false);
    expect(api.postSubmission).not.toHaveBeenCalled();
  });

  it('refuses a file input for a text-only assignment', async () => {
    const db = setup('["online_text_entry"]');
    const outcome = await submitAssignment(db, CREDS, 10, { kind: 'file', filePath: '/tmp/x.pdf' });
    expect(outcome.ok).toBe(false);
    expect(uploadSubmissionFile).not.toHaveBeenCalled();
    expect(api.postSubmission).not.toHaveBeenCalled();
  });

  it('refuses a text input for a file-only assignment', async () => {
    const db = setup('["online_upload"]');
    const outcome = await submitAssignment(db, CREDS, 10, { kind: 'text', body: 'x' });
    expect(outcome.ok).toBe(false);
    expect(api.postSubmission).not.toHaveBeenCalled();
  });

  it('names an institutional API-write restriction on a 403', async () => {
    vi.mocked(api.postSubmission).mockRejectedValue(new CanvasForbiddenError('not allowed'));
    const db = setup('["online_text_entry"]');

    const outcome = await submitAssignment(db, CREDS, 10, { kind: 'text', body: 'x' });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('Canvas refused');
    expect(outcome.message).toContain('browser');
  });

  it('surfaces an expired token distinctly', async () => {
    vi.mocked(api.postSubmission).mockRejectedValue(new CanvasAuthError());
    const db = setup('["online_text_entry"]');
    const outcome = await submitAssignment(db, CREDS, 10, { kind: 'text', body: 'x' });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('token');
  });

  it('keeps the draft when the submission failed', async () => {
    vi.mocked(api.postSubmission).mockRejectedValue(new CanvasForbiddenError('no'));
    const db = setup('["online_text_entry"]');
    saveDraft(db, 10, 'keep me');

    await submitAssignment(db, CREDS, 10, { kind: 'text', body: 'keep me' });

    expect(getDraft(db, 10)).toBe('keep me');
  });
});

describe('submitAssignment — verification', () => {
  it('reports ok-but-unverified when the read-back fails, never plain success', async () => {
    vi.mocked(api.getMySubmission).mockRejectedValue(new Error('network'));
    const db = setup('["online_text_entry"]');

    const outcome = await submitAssignment(db, CREDS, 10, { kind: 'text', body: 'x' });

    expect(outcome.ok).toBe(true);
    expect(outcome.verified).toBe(false);
    expect(outcome.message).toContain('check Canvas');
  });

  it('does not clear the draft when the submission could not be verified', async () => {
    // The user may need to resubmit; discarding their text would be destructive.
    vi.mocked(api.getMySubmission).mockRejectedValue(new Error('network'));
    const db = setup('["online_text_entry"]');
    saveDraft(db, 10, 'keep me');

    await submitAssignment(db, CREDS, 10, { kind: 'text', body: 'keep me' });

    expect(getDraft(db, 10)).toBe('keep me');
  });

  it('does not mark the row submitted when verification failed', async () => {
    vi.mocked(api.getMySubmission).mockRejectedValue(new Error('network'));
    const db = setup('["online_text_entry"]');

    await submitAssignment(db, CREDS, 10, { kind: 'text', body: 'x' });

    const row = db.prepare('select has_submitted from canvas_assignments where id = 10').get() as {
      has_submitted: number;
    };
    expect(row.has_submitted).toBe(0);
  });
});
