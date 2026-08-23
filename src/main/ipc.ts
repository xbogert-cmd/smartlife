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

// The Settings UI write reaches the renderer through React state directly, so
// it never needed this. The AI tool writes straight to the DB with no
// renderer round trip at all, so without a broadcast the theme only visibly
// changed after an app restart. Registered here rather than threaded through
// every write site, the same reasoning as browser/hostRegistry.ts and
// ai/navigatorRegistry.ts.
let broadcastThemePreference: (value: ThemePreference) => void = () => {};

export function broadcastThemePreferenceChange(value: ThemePreference): void {
  broadcastThemePreference(value);
}

export function registerIpcHandlers(db: Database.Database, getWindow: () => BrowserWindow | null): void {
  broadcastThemePreference = (value) => getWindow()?.webContents.send('theme:preference-changed', value);

  ipcMain.handle('theme:get', () => getThemePreference(db));
  ipcMain.handle('theme:set', (_event, value: ThemePreference) => {
    if (!VALID_THEMES.includes(value)) return;
    setThemePreference(db, value);
    broadcastThemePreference(value);
  });
  ipcMain.handle('app:getVersion', () => app.getVersion());

  nativeTheme.on('updated', () => {
    getWindow()?.webContents.send('theme:system-changed', nativeTheme.shouldUseDarkColors);
  });
}
