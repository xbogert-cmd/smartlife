import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getThemePreference, setThemePreference } from './ipc';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null)');
  return db;
}

describe('theme preference persistence', () => {
  it('defaults to "system" when unset', () => {
    const db = makeDb();
    expect(getThemePreference(db)).toBe('system');
  });

  it('round-trips a set value', () => {
    const db = makeDb();
    setThemePreference(db, 'dark');
    expect(getThemePreference(db)).toBe('dark');
  });

  it('overwrites a previously set value', () => {
    const db = makeDb();
    setThemePreference(db, 'dark');
    setThemePreference(db, 'light');
    expect(getThemePreference(db)).toBe('light');
  });

  it('falls back to "system" for a corrupted/unexpected stored value', () => {
    const db = makeDb();
    db.prepare('insert into settings (key, value) values (?, ?)').run('theme', 'not-a-real-theme');
    expect(getThemePreference(db)).toBe('system');
  });
});
