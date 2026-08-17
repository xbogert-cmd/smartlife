import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate';

const INIT_SQL = `create table settings (
  key text primary key,
  value text not null
);`;

describe('runMigrations', () => {
  it('creates tables from a pending migration', () => {
    const db = new Database(':memory:');
    runMigrations(db, [{ filename: '0001_init.sql', sql: INIT_SQL }]);

    const tables = db
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toContain('settings');
    expect(tables).toContain('schema_migrations');
  });

  it('is idempotent — re-running does not re-apply an already-applied migration', () => {
    const db = new Database(':memory:');
    const migration = { filename: '0001_init.sql', sql: INIT_SQL };

    runMigrations(db, [migration]);
    expect(() => runMigrations(db, [migration])).not.toThrow();

    const applied = db.prepare('select count(*) as count from schema_migrations').get() as { count: number };
    expect(applied.count).toBe(1);
  });

  it('applies multiple pending migrations in filename order', () => {
    const db = new Database(':memory:');
    runMigrations(db, [
      { filename: '0002_second.sql', sql: 'create table second (id integer primary key);' },
      { filename: '0001_init.sql', sql: INIT_SQL },
    ]);

    // Ordered by rowid, not applied_at: two migrations applied in the same test can get the
    // same second-resolution `datetime('now')` timestamp, which would make an applied_at sort
    // nondeterministic. rowid reflects true insertion order regardless of timestamp ties.
    const order = db.prepare('select filename from schema_migrations order by rowid').all() as Array<{ filename: string }>;
    expect(order.map((r) => r.filename)).toEqual(['0001_init.sql', '0002_second.sql']);
  });
});
