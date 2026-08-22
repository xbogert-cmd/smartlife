import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate';
import type { Migration } from './migrate';
import migration0001 from './migrations/0001_init.sql?raw';
import migration0002 from './migrations/0002_ai_core.sql?raw';
import migration0003 from './migrations/0003_canvas.sql?raw';
import migration0004 from './migrations/0004_calendar.sql?raw';
import migration0005 from './migrations/0005_browser.sql?raw';
import migration0006 from './migrations/0006_submissions.sql?raw';

const ALL_MIGRATIONS: Migration[] = [
  { filename: '0001_init.sql', sql: migration0001 },
  { filename: '0002_ai_core.sql', sql: migration0002 },
  { filename: '0003_canvas.sql', sql: migration0003 },
  { filename: '0004_calendar.sql', sql: migration0004 },
  { filename: '0005_browser.sql', sql: migration0005 },
  { filename: '0006_submissions.sql', sql: migration0006 },
];

describe('migrations', () => {
  it('0006 creates the submissions tables with the expected columns', () => {
    const db = new Database(':memory:');
    runMigrations(db, ALL_MIGRATIONS);

    const draftCols = (db.prepare('pragma table_info(assignment_drafts)').all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();
    expect(draftCols).toEqual(['assignment_id', 'body', 'updated_at']);

    const topicCols = (db.prepare('pragma table_info(canvas_discussion_topics)').all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();
    expect(topicCols).toEqual([
      'assignment_id',
      'course_id',
      'id',
      'require_initial_post',
      'synced_at',
      'title',
    ]);
  });

  it('cascades draft deletion when its assignment is removed', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, ALL_MIGRATIONS);

    db.prepare("insert into canvas_courses (id, name) values (1, 'C')").run();
    db.prepare("insert into canvas_assignments (course_id, id, name) values (1, 10, 'A')").run();
    db.prepare("insert into assignment_drafts (assignment_id, body) values (10, 'draft text')").run();

    db.prepare('delete from canvas_assignments where id = 10').run();

    const remaining = db.prepare('select count(*) as n from assignment_drafts').get() as { n: number };
    expect(remaining.n).toBe(0);
  });
});
