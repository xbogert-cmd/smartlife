import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate';
import migration0001 from './migrations/0001_init.sql?raw';
import migration0002 from './migrations/0002_ai_core.sql?raw';
import migration0003 from './migrations/0003_canvas.sql?raw';

export function openDb(): Database.Database {
  const dbPath = join(app.getPath('userData'), 'smartlife.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db, [
    { filename: '0001_init.sql', sql: migration0001 },
    { filename: '0002_ai_core.sql', sql: migration0002 },
    { filename: '0003_canvas.sql', sql: migration0003 },
  ]);
  return db;
}
