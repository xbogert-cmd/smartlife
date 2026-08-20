import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

import { canvasUpcomingTool } from './canvasUpcoming';
import { canvasGradesTool } from './canvasGrades';
import { canvasSearchMaterialsTool } from './canvasSearchMaterials';
import { TOOLS } from './registry';
import { resolveExecutionMode } from '../permissions';

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
create table canvas_announcements (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  title text, message text, posted_at text, html_url text,
  synced_at text not null default (datetime('now'))
);
create table canvas_files (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  display_name text, filename text, content_type text, size integer,
  updated_at text, synced_at text not null default (datetime('now'))
);
create table canvas_pages (
  course_id integer not null references canvas_courses(id) on delete cascade,
  url text not null, title text, body text, updated_at text,
  synced_at text not null default (datetime('now')), primary key (course_id, url)
);
create table canvas_sync_state (key text primary key, value text not null);
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare('insert into canvas_courses (id, name, course_code, current_score, current_grade) values (?,?,?,?,?)').run(
    101, 'Statistics', 'STT 215', 91.5, 'A-'
  );
  return db;
}

function ctx(db: Database.Database) {
  return {
    db,
    conversationId: 'conv-1',
    mode: 'ask' as const,
    requestConfirmation: vi.fn(async () => {
      throw new Error('READ-tier tools must never ask for confirmation');
    }),
  };
}

describe('Canvas tool registration', () => {
  it('registers all three tools', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toContain('canvas_upcoming_assignments');
    expect(names).toContain('canvas_course_grades');
    expect(names).toContain('canvas_search_materials');
  });

  it('registers them at READ tier, which never pauses in any mode', () => {
    for (const tool of [canvasUpcomingTool, canvasGradesTool, canvasSearchMaterialsTool]) {
      expect(tool.tier).toBe('READ');
      for (const mode of ['ask', 'assist', 'auto'] as const) {
        expect(resolveExecutionMode(tool.tier, mode)).toBe('auto');
      }
    }
  });

  it('declares object input schemas', () => {
    for (const tool of [canvasUpcomingTool, canvasGradesTool, canvasSearchMaterialsTool]) {
      expect(tool.schema.input_schema.type).toBe('object');
      expect(tool.schema.description.length).toBeGreaterThan(10);
    }
  });
});

describe('canvas_upcoming_assignments', () => {
  it('lists work due inside the requested window', async () => {
    const db = makeDb();
    const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
    db.prepare(
      'insert into canvas_assignments (id, course_id, name, due_at, points_possible, has_submitted) values (?,?,?,?,?,?)'
    ).run(555, 101, 'Problem Set 3', due, 20, 0);

    const output = await canvasUpcomingTool.run({ days: 7 }, ctx(db));

    expect(output).toContain('Problem Set 3');
    expect(output).toContain('Statistics');
  });

  it('marks submitted work so the model does not nag about it', async () => {
    const db = makeDb();
    const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
    db.prepare(
      'insert into canvas_assignments (id, course_id, name, due_at, points_possible, has_submitted) values (?,?,?,?,?,?)'
    ).run(555, 101, 'Problem Set 3', due, 20, 1);

    expect(await canvasUpcomingTool.run({ days: 7 }, ctx(db))).toContain('submitted');
  });

  it('defaults to a 7-day window when days is omitted', async () => {
    const db = makeDb();
    const inTenDays = new Date(Date.now() + 10 * 86_400_000).toISOString();
    db.prepare('insert into canvas_assignments (id, course_id, name, due_at) values (?,?,?,?)').run(
      556, 101, 'Far Off', inTenDays
    );

    expect(await canvasUpcomingTool.run({}, ctx(db))).toContain('Nothing is due');
  });

  it('says so plainly when nothing is due', async () => {
    expect(await canvasUpcomingTool.run({ days: 7 }, ctx(makeDb()))).toContain('Nothing is due');
  });

  it('clamps an out-of-range day count instead of failing', async () => {
    const db = makeDb();
    await expect(canvasUpcomingTool.run({ days: -5 }, ctx(db))).resolves.toContain('Nothing is due');
    await expect(canvasUpcomingTool.run({ days: 99999 }, ctx(db))).resolves.toBeTypeOf('string');
  });
});

describe('canvas_course_grades', () => {
  it('reports the current score and letter per course', async () => {
    const output = await canvasGradesTool.run({}, ctx(makeDb()));
    expect(output).toContain('Statistics');
    expect(output).toContain('91.5');
    expect(output).toContain('A-');
  });

  it('handles a course with no posted grade', async () => {
    const db = makeDb();
    db.prepare('insert into canvas_courses (id, name) values (?, ?)').run(202, 'Chemistry');
    const output = await canvasGradesTool.run({}, ctx(db));
    expect(output).toContain('Chemistry');
    expect(output).toContain('no grade posted');
  });

  it('says so when no courses are synced', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    expect(await canvasGradesTool.run({}, ctx(db))).toContain('No courses');
  });
});

describe('canvas_search_materials', () => {
  it('finds a file by partial name', async () => {
    const db = makeDb();
    db.prepare('insert into canvas_files (id, course_id, display_name) values (?,?,?)').run(7, 101, 'Syllabus.pdf');

    const output = await canvasSearchMaterialsTool.run({ query: 'syllab' }, ctx(db));

    expect(output).toContain('Syllabus.pdf');
    expect(output).toContain('Statistics');
  });

  it('finds a page by title', async () => {
    const db = makeDb();
    db.prepare('insert into canvas_pages (course_id, url, title) values (?,?,?)').run(101, 'week-1', 'Week 1 Overview');

    expect(await canvasSearchMaterialsTool.run({ query: 'overview' }, ctx(db))).toContain('Week 1 Overview');
  });

  it('reports no matches rather than returning an empty string', async () => {
    expect(await canvasSearchMaterialsTool.run({ query: 'nonexistent' }, ctx(makeDb()))).toContain('No materials');
  });

  it('asks for a query when given a blank one', async () => {
    expect(await canvasSearchMaterialsTool.run({ query: '   ' }, ctx(makeDb()))).toContain('search term');
  });
});
