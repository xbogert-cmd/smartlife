import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const nativeThemeListeners = new Map<string, () => void>();

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0' },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  nativeTheme: {
    shouldUseDarkColors: false,
    on: (event: string, cb: () => void) => nativeThemeListeners.set(event, cb),
  },
}));

import { broadcastThemePreferenceChange, getThemePreference, registerIpcHandlers, setThemePreference } from './ipc';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null)');
  return db;
}

beforeEach(() => {
  handlers.clear();
  nativeThemeListeners.clear();
});

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

describe('theme:set broadcasts the new preference to the renderer', () => {
  it('sends theme:preference-changed after a valid write', () => {
    const db = makeDb();
    const send = vi.fn();
    registerIpcHandlers(db, () => ({ webContents: { send } }) as never);

    handlers.get('theme:set')?.({}, 'dark');

    expect(send).toHaveBeenCalledWith('theme:preference-changed', 'dark');
    expect(getThemePreference(db)).toBe('dark');
  });

  it('does not broadcast, and does not write, an invalid value', () => {
    const db = makeDb();
    const send = vi.fn();
    registerIpcHandlers(db, () => ({ webContents: { send } }) as never);

    handlers.get('theme:set')?.({}, 'rainbow');

    expect(send).not.toHaveBeenCalled();
    expect(getThemePreference(db)).toBe('system');
  });

  it('does nothing when the window is gone (closed mid-write)', () => {
    const db = makeDb();
    registerIpcHandlers(db, () => null);

    expect(() => handlers.get('theme:set')?.({}, 'dark')).not.toThrow();
    expect(getThemePreference(db)).toBe('dark');
  });
});

describe('broadcastThemePreferenceChange', () => {
  it('lets a caller outside the theme:set handler (the AI tool) reach the same broadcast', () => {
    const db = makeDb();
    const send = vi.fn();
    registerIpcHandlers(db, () => ({ webContents: { send } }) as never);

    setThemePreference(db, 'light');
    broadcastThemePreferenceChange('light');

    expect(send).toHaveBeenCalledWith('theme:preference-changed', 'light');
  });
});
