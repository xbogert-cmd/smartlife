import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { setThemeTool } from './setTheme';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null)');
  return db;
}

describe('set_theme tool', () => {
  it('sets the theme directly when the mode auto-executes SAFE_WRITE', async () => {
    const db = makeDb();
    const result = await setThemeTool.run(
      { theme: 'dark' },
      { db, conversationId: 'c1', mode: 'auto', requestConfirmation: vi.fn() }
    );
    expect(result).toBe('Theme set to "dark".');
    const row = db.prepare('select value from settings where key = ?').get('theme') as { value: string };
    expect(row.value).toBe('dark');
  });

  it('pauses for confirmation in assist mode too, since SAFE_WRITE now requires it there', async () => {
    const db = makeDb();
    const requestConfirmation = vi.fn().mockResolvedValue(true);
    const result = await setThemeTool.run(
      { theme: 'dark' },
      { db, conversationId: 'c1', mode: 'assist', requestConfirmation }
    );
    expect(requestConfirmation).toHaveBeenCalledWith('set_theme', 'Change theme to "dark"');
    expect(result).toBe('Theme set to "dark".');
  });

  it('pauses for confirmation in ask mode and applies the change on approval', async () => {
    const db = makeDb();
    const requestConfirmation = vi.fn().mockResolvedValue(true);
    const result = await setThemeTool.run({ theme: 'light' }, { db, conversationId: 'c1', mode: 'ask', requestConfirmation });
    expect(requestConfirmation).toHaveBeenCalledWith('set_theme', 'Change theme to "light"');
    expect(result).toBe('Theme set to "light".');
  });

  it('does not apply the change when the user declines', async () => {
    const db = makeDb();
    const result = await setThemeTool.run(
      { theme: 'dark' },
      { db, conversationId: 'c1', mode: 'ask', requestConfirmation: vi.fn().mockResolvedValue(false) }
    );
    expect(result).toBe('User declined this action.');
    expect(db.prepare('select value from settings where key = ?').get('theme')).toBeUndefined();
  });

  it('rejects an invalid theme value without touching the database or asking for confirmation', async () => {
    const db = makeDb();
    const requestConfirmation = vi.fn();
    const result = await setThemeTool.run({ theme: 'rainbow' }, { db, conversationId: 'c1', mode: 'ask', requestConfirmation });
    expect(result).toContain('Invalid theme');
    expect(requestConfirmation).not.toHaveBeenCalled();
  });
});
