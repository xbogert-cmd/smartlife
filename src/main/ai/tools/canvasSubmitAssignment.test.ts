import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));
vi.mock('../../canvas/submit', () => ({ submitAssignment: vi.fn() }));

import { submitAssignment } from '../../canvas/submit';
import { setActiveCanvasScheduler } from '../../canvas/schedulerRegistry';
import { canvasSubmitAssignmentTool } from './canvasSubmitAssignment';

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
  score real, grade text, workflow_state text, synced_at text not null default (datetime('now'))
);
create table canvas_discussion_topics (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  assignment_id integer, title text, require_initial_post integer not null default 0,
  synced_at text not null default (datetime('now'))
);
create table assignment_drafts (
  assignment_id integer primary key references canvas_assignments(id) on delete cascade,
  body text not null, updated_at text not null default (datetime('now'))
);
`;

function setup(submissionTypes = '["online_text_entry"]') {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare("insert into canvas_courses (id, name) values (1, 'ACG')").run();
  db.prepare('insert into canvas_assignments (id, course_id, name, submission_types) values (10, 1, ?, ?)').run(
    'Chapter 4 Homework',
    submissionTypes
  );
  db.prepare("insert into settings (key, value) values ('canvas_base_url', 'https://uncw.instructure.com')").run();
  db.prepare("insert into settings (key, value) values ('canvas_token_encrypted', ?)").run(
    Buffer.from('enc:tok').toString('base64')
  );
  setActiveCanvasScheduler({ syncNow: vi.fn(), runExclusive: vi.fn(async (fn: () => unknown) => fn()) } as never);
  return db;
}

function ctx(db: Database.Database, mode: 'ask' | 'assist' | 'auto', requestConfirmation = vi.fn().mockResolvedValue(true)) {
  return { db, conversationId: 'c1', mode, requestConfirmation };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(submitAssignment).mockResolvedValue({
    ok: true,
    verified: true,
    submittedAt: '2026-08-22T12:00:00Z',
    message: 'Submitted and confirmed by Canvas.',
  });
});

describe('canvasSubmitAssignmentTool', () => {
  it('is in the ALWAYS_CONFIRM tier', () => {
    expect(canvasSubmitAssignmentTool.tier).toBe('ALWAYS_CONFIRM');
  });

  it('exposes no file or path parameter', () => {
    // A model-supplied path would be an exfiltration channel.
    const props = canvasSubmitAssignmentTool.schema.input_schema.properties as Record<string, unknown>;
    const keys = Object.keys(props).join(' ').toLowerCase();
    expect(keys).not.toContain('file');
    expect(keys).not.toContain('path');
  });

  it('asks for confirmation even in auto mode', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    const db = setup();
    await canvasSubmitAssignmentTool.run({ assignmentId: 10, text: 'my answer' }, ctx(db, 'auto', ask));
    expect(ask).toHaveBeenCalled();
  });

  it('puts the full untruncated text in the confirmation description', async () => {
    const long = 'x'.repeat(500);
    const ask = vi.fn().mockResolvedValue(true);
    const db = setup();
    await canvasSubmitAssignmentTool.run({ assignmentId: 10, text: long }, ctx(db, 'ask', ask));
    expect(ask.mock.calls[0][1]).toContain(long);
  });

  it('names the assignment in the confirmation', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    const db = setup();
    await canvasSubmitAssignmentTool.run({ assignmentId: 10, text: 'a' }, ctx(db, 'ask', ask));
    expect(ask.mock.calls[0][1]).toContain('Chapter 4 Homework');
  });

  it('warns that a discussion post is public and undeletable', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    const db = setup('["discussion_topic"]');
    db.prepare('insert into canvas_discussion_topics (id, course_id, assignment_id) values (55, 1, 10)').run();

    await canvasSubmitAssignmentTool.run({ assignmentId: 10, text: 'my post' }, ctx(db, 'ask', ask));

    const description = ask.mock.calls[0][1] as string;
    expect(description).toContain('whole class');
    expect(description).toContain('delete');
  });

  it('does not submit when the user declines', async () => {
    const ask = vi.fn().mockResolvedValue(false);
    const db = setup();
    const result = await canvasSubmitAssignmentTool.run({ assignmentId: 10, text: 'a' }, ctx(db, 'auto', ask));
    expect(submitAssignment).not.toHaveBeenCalled();
    expect(result).toContain('declined');
  });

  it('sends a text assignment as a text submission', async () => {
    const db = setup();
    await canvasSubmitAssignmentTool.run({ assignmentId: 10, text: 'answer' }, ctx(db, 'ask'));
    expect(vi.mocked(submitAssignment).mock.calls[0][3]).toEqual({ kind: 'text', body: 'answer' });
  });

  it('sends a discussion assignment as a discussion post', async () => {
    const db = setup('["discussion_topic"]');
    db.prepare('insert into canvas_discussion_topics (id, course_id, assignment_id) values (55, 1, 10)').run();
    await canvasSubmitAssignmentTool.run({ assignmentId: 10, text: 'post' }, ctx(db, 'ask'));
    expect(vi.mocked(submitAssignment).mock.calls[0][3]).toEqual({ kind: 'discussion', message: 'post' });
  });

  it('refuses a file-upload assignment and points at the UI', async () => {
    const db = setup('["online_upload"]');
    const result = await canvasSubmitAssignmentTool.run({ assignmentId: 10, text: 'a' }, ctx(db, 'ask'));
    expect(submitAssignment).not.toHaveBeenCalled();
    expect(result).toContain('file');
  });

  it('refuses a handoff assignment without asking for confirmation', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    const db = setup('["external_tool"]');
    const result = await canvasSubmitAssignmentTool.run({ assignmentId: 10, text: 'a' }, ctx(db, 'ask', ask));
    expect(ask).not.toHaveBeenCalled();
    expect(result).toContain('browser');
  });

  it('refuses an unknown assignment without asking for confirmation', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    const db = setup();
    const result = await canvasSubmitAssignmentTool.run({ assignmentId: 999, text: 'a' }, ctx(db, 'ask', ask));
    expect(ask).not.toHaveBeenCalled();
    expect(result).toContain('not');
  });

  it('reports an unverified submission honestly rather than as success', async () => {
    vi.mocked(submitAssignment).mockResolvedValue({
      ok: true,
      verified: false,
      submittedAt: null,
      message: "Submitted, but we couldn't confirm it — check Canvas.",
    });
    const db = setup();
    const result = await canvasSubmitAssignmentTool.run({ assignmentId: 10, text: 'a' }, ctx(db, 'ask'));
    expect(result).toContain("couldn't confirm");
  });
});
