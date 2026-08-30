import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

import { canvasFindAssignmentTool } from './canvasFindAssignment';
import { canvasOpenAssignmentTool } from './canvasOpenAssignment';
import { canvasUpcomingTool } from './canvasUpcoming';
import { setActiveBrowserHost } from '../../browser/hostRegistry';
import { setActiveNavigator } from '../navigatorRegistry';
import { resolveExecutionMode } from '../permissions';
import type { ToolContext } from './types';

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

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare("insert into canvas_courses (id, name) values (1, 'Arabic 101')").run();
  const insert = db.prepare(
    `insert into canvas_assignments (id, course_id, name, due_at, points_possible, submission_types, has_submitted, html_url)
     values (?, 1, ?, ?, ?, ?, ?, ?)`
  );
  // Past due, so canvas_upcoming_assignments can never surface it.
  insert.run(10, 'Homework 2', '2026-08-10T04:00:00Z', 25, '["online_upload"]', 0, 'https://canvas.example/courses/1/assignments/10');
  insert.run(11, 'Connect Chapter 4', null, 10, '["external_tool"]', 0, 'https://canvas.example/courses/1/assignments/11');
  insert.run(12, 'No link here', null, 10, '["external_tool"]', 0, null);
  return db;
}

function ctx(db: Database.Database, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    db,
    conversationId: 'c1',
    mode: 'auto',
    requestConfirmation: async () => true,
    ...overrides,
  };
}

afterEach(() => {
  setActiveBrowserHost(null);
  setActiveNavigator(null);
});

describe('canvas_find_assignment', () => {
  it('finds a past-due assignment that canvas_upcoming_assignments cannot', async () => {
    const db = makeDb();
    const upcoming = await canvasUpcomingTool.run({ days: 180 }, ctx(db));
    expect(upcoming).not.toContain('Homework 2');

    const found = await canvasFindAssignmentTool.run({ query: 'Homework 2' }, ctx(db));
    expect(found).toContain('Homework 2');
  });

  it('reports the assignment id, which every other tool needs', async () => {
    const out = await canvasFindAssignmentTool.run({ query: 'Homework 2' }, ctx(makeDb()));
    expect(out).toContain('assignment id 10');
  });

  it('says what can actually be done with each match', async () => {
    const out = await canvasFindAssignmentTool.run({ query: 'Connect' }, ctx(makeDb()));
    expect(out).toContain('canvas_open_assignment');
  });

  it('tells the model not to guess when nothing matches', async () => {
    const out = await canvasFindAssignmentTool.run({ query: 'Nonexistent' }, ctx(makeDb()));
    expect(out).toMatch(/do not guess/i);
  });

  it('asks for a search term when given an empty query', async () => {
    const out = await canvasFindAssignmentTool.run({ query: '  ' }, ctx(makeDb()));
    expect(out).toMatch(/provide part of an assignment name/i);
  });

  it('is a READ tool that only pauses in ask mode', () => {
    expect(canvasFindAssignmentTool.tier).toBe('READ');
    expect(resolveExecutionMode(canvasFindAssignmentTool.tier, 'ask')).toBe('pause');
    expect(resolveExecutionMode(canvasFindAssignmentTool.tier, 'assist')).toBe('auto');
    expect(resolveExecutionMode(canvasFindAssignmentTool.tier, 'auto')).toBe('auto');
  });
});

describe('canvas_upcoming_assignments', () => {
  it('emits the assignment id its own schema promises', async () => {
    const db = makeDb();
    db.prepare(
      `insert into canvas_assignments (id, course_id, name, due_at, submission_types)
       values (20, 1, 'Future essay', ?, '["online_text_entry"]')`
    ).run(new Date(Date.now() + 86_400_000).toISOString());

    const out = await canvasUpcomingTool.run({ days: 7 }, ctx(db));
    expect(out).toContain('assignment id 20');
  });
});

describe('canvas_open_assignment', () => {
  it("opens the assignment's own Canvas url", async () => {
    const opened: string[] = [];
    setActiveBrowserHost({ openTab: (url: string) => { opened.push(url); return 't1'; } } as never);
    const out = await canvasOpenAssignmentTool.run({ assignmentId: 11 }, ctx(makeDb()));
    expect(opened).toEqual(['https://canvas.example/courses/1/assignments/11']);
    expect(out).toContain('Connect Chapter 4');
  });

  it('switches the app to the browser route so the user actually sees it', async () => {
    const routes: string[] = [];
    setActiveBrowserHost({ openTab: () => 't1' } as never);
    setActiveNavigator((path) => routes.push(path));
    await canvasOpenAssignmentTool.run({ assignmentId: 11 }, ctx(makeDb()));
    expect(routes).toEqual(['/browser']);
  });

  it('accepts no url from the caller, only an assignment id', () => {
    const props = canvasOpenAssignmentTool.schema.input_schema as {
      properties: Record<string, unknown>;
    };
    // A url parameter would let a prompt-injected model open anything at all.
    expect(Object.keys(props.properties)).toEqual(['assignmentId']);
  });

  it('refuses an assignment that is not in the local database', async () => {
    const opened: string[] = [];
    setActiveBrowserHost({ openTab: (url: string) => { opened.push(url); return 't1'; } } as never);
    const out = await canvasOpenAssignmentTool.run({ assignmentId: 999 }, ctx(makeDb()));
    expect(out).toMatch(/not in the local database/i);
    expect(opened).toEqual([]);
  });

  it('refuses an assignment with no stored Canvas link', async () => {
    const opened: string[] = [];
    setActiveBrowserHost({ openTab: (url: string) => { opened.push(url); return 't1'; } } as never);
    const out = await canvasOpenAssignmentTool.run({ assignmentId: 12 }, ctx(makeDb()));
    expect(out).toMatch(/no Canvas link/i);
    expect(opened).toEqual([]);
  });

  it('opens nothing when the user declines', async () => {
    const opened: string[] = [];
    setActiveBrowserHost({ openTab: (url: string) => { opened.push(url); return 't1'; } } as never);
    const out = await canvasOpenAssignmentTool.run(
      { assignmentId: 11 },
      ctx(makeDb(), { mode: 'ask', requestConfirmation: async () => false })
    );
    expect(out).toMatch(/declined/i);
    expect(opened).toEqual([]);
  });

  it('pauses for confirmation in ask and assist, not in auto', () => {
    expect(resolveExecutionMode(canvasOpenAssignmentTool.tier, 'ask')).toBe('pause');
    expect(resolveExecutionMode(canvasOpenAssignmentTool.tier, 'assist')).toBe('pause');
    expect(resolveExecutionMode(canvasOpenAssignmentTool.tier, 'auto')).toBe('auto');
  });

  it('degrades gracefully when the browser host is unavailable', async () => {
    setActiveBrowserHost(null);
    const out = await canvasOpenAssignmentTool.run({ assignmentId: 11 }, ctx(makeDb()));
    expect(out).toMatch(/not available/i);
  });
});
