import { app, ipcMain, nativeTheme, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';

export type ThemePreference = 'light' | 'dark' | 'system';

const VALID_THEMES: ThemePreference[] = ['light', 'dark', 'system'];

export function getThemePreference(db: Database.Database): ThemePreference {
  const row = db.prepare('select value from settings where key = ?').get('theme') as
    | { value: string }
    | undefined;
  if (row && VALID_THEMES.includes(row.value as ThemePreference)) {
    return row.value as ThemePreference;
  }
  return 'system';
}

export function setThemePreference(db: Database.Database, value: ThemePreference): void {
  db.prepare(
    'insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
  ).run('theme', value);
}

export function registerIpcHandlers(db: Database.Database, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('theme:get', () => getThemePreference(db));
  ipcMain.handle('theme:set', (_event, value: ThemePreference) => {
    setThemePreference(db, value);
  });
  ipcMain.handle('app:getVersion', () => app.getVersion());

  nativeTheme.on('updated', () => {
    getWindow()?.webContents.send('theme:system-changed', nativeTheme.shouldUseDarkColors);
  });
}
