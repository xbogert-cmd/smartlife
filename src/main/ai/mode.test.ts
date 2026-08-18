import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getAiMode, setAiMode } from './mode';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null)');
  return db;
}

describe('ai_mode setting', () => {
  it('defaults to "ask" when unset', () => {
    const db = makeDb();
    expect(getAiMode(db)).toBe('ask');
  });

  it('round-trips a set value', () => {
    const db = makeDb();
    setAiMode(db, 'auto');
    expect(getAiMode(db)).toBe('auto');
  });

  it('falls back to "ask" for a corrupted stored value', () => {
    const db = makeDb();
    db.prepare('insert into settings (key, value) values (?, ?)').run('ai_mode', 'not-a-real-mode');
    expect(getAiMode(db)).toBe('ask');
  });
});
