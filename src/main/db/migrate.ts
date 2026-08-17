import type Database from 'better-sqlite3';

export interface Migration {
  filename: string;
  sql: string;
}

export function runMigrations(db: Database.Database, migrations: Migration[]): void {
  db.exec(
    `create table if not exists schema_migrations (
      filename text primary key,
      applied_at text not null default (datetime('now'))
    )`
  );

  const applied = new Set(
    (db.prepare('select filename from schema_migrations').all() as Array<{ filename: string }>).map(
      (row) => row.filename
    )
  );

  const pending = migrations
    .filter((m) => !applied.has(m.filename))
    .sort((a, b) => a.filename.localeCompare(b.filename));

  for (const migration of pending) {
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('insert into schema_migrations (filename) values (?)').run(migration.filename);
    });
    apply();
  }
}
