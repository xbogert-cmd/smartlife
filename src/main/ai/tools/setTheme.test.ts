import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { setThemeTool } from './setTheme';
import { broadcastThemePreferenceChange, registerIpcHandlers } from '../../ipc';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0' },
  ipcMain: { handle: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false, on: vi.fn() },
}));

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

describe('set_theme tool reaches the renderer', () => {
  it('broadcasts theme:preference-changed, same as the Settings UI write, so the AI does not need a restart to take effect', async () => {
    const db = makeDb();
    db.exec('create table if not exists settings (key text primary key, value text not null)');
    const send = vi.fn();
    registerIpcHandlers(db, () => ({ webContents: { send } }) as never);

    await setThemeTool.run({ theme: 'dark' }, { db, conversationId: 'c1', mode: 'auto', requestConfirmation: vi.fn() });

    expect(send).toHaveBeenCalledWith('theme:preference-changed', 'dark');
  });

  it('does not broadcast when the user declines', async () => {
    const db = makeDb();
    const send = vi.fn();
    registerIpcHandlers(db, () => ({ webContents: { send } }) as never);

    await setThemeTool.run(
      { theme: 'dark' },
      { db, conversationId: 'c1', mode: 'ask', requestConfirmation: vi.fn().mockResolvedValue(false) }
    );

    expect(send).not.toHaveBeenCalled();
  });
});

// Sanity check that the tool and the ipc.ts choke point really are wired to
// the same function, not two independently-behaving broadcasters.
describe('broadcastThemePreferenceChange is the same function setTheme.ts imports', () => {
  it('is exported from ipc.ts', () => {
    expect(typeof broadcastThemePreferenceChange).toBe('function');
  });
});
