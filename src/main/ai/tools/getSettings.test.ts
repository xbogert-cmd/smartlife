import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { getSettingsTool } from './getSettings';

vi.mock('electron', () => ({ app: { getVersion: () => '0.1.0' } }));

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null)');
  return db;
}

describe('get_settings tool', () => {
  it('returns the theme and version without ever requesting confirmation (READ tier)', async () => {
    const db = makeDb();
    const requestConfirmation = vi.fn();
    const result = await getSettingsTool.run({}, { db, conversationId: 'c1', mode: 'ask', requestConfirmation });
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(JSON.parse(result)).toEqual({ theme: 'system', version: '0.1.0' });
  });
});
