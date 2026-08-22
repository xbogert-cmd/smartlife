import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { clearDraft, getDraft, saveDraft } from './drafts';

const SCHEMA = `
create table canvas_courses (id integer primary key, name text not null);
create table canvas_assignments (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  name text not null
);
create table assignment_drafts (
  assignment_id integer primary key references canvas_assignments(id) on delete cascade,
  body text not null,
  updated_at text not null default (datetime('now'))
);
`;

function setup(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare("insert into canvas_courses (id, name) values (1, 'C')").run();
  db.prepare("insert into canvas_assignments (id, course_id, name) values (10, 1, 'A')").run();
  return db;
}

describe('drafts', () => {
  it('returns null when nothing has been saved', () => {
    expect(getDraft(setup(), 10)).toBeNull();
  });

  it('round-trips a saved draft', () => {
    const db = setup();
    saveDraft(db, 10, 'first pass');
    expect(getDraft(db, 10)).toBe('first pass');
  });

  it('overwrites rather than inserting a second row', () => {
    const db = setup();
    saveDraft(db, 10, 'first');
    saveDraft(db, 10, 'second');
    expect(getDraft(db, 10)).toBe('second');
    const count = db.prepare('select count(*) as n from assignment_drafts').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('records the supplied timestamp rather than reading the clock', () => {
    const db = setup();
    saveDraft(db, 10, 'x', new Date('2026-08-22T12:00:00.000Z'));
    const row = db.prepare('select updated_at from assignment_drafts where assignment_id = 10').get() as {
      updated_at: string;
    };
    expect(row.updated_at).toBe('2026-08-22T12:00:00.000Z');
  });

  it('preserves an empty draft as empty rather than as absent', () => {
    // The user clearing the editor is a real state; it is not "no draft".
    const db = setup();
    saveDraft(db, 10, 'something');
    saveDraft(db, 10, '');
    expect(getDraft(db, 10)).toBe('');
  });

  it('clears a draft', () => {
    const db = setup();
    saveDraft(db, 10, 'x');
    clearDraft(db, 10);
    expect(getDraft(db, 10)).toBeNull();
  });

  it('clearing a draft that does not exist is not an error', () => {
    expect(() => clearDraft(setup(), 999)).not.toThrow();
  });
});
