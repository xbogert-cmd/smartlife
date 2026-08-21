import { ipcMain, shell, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { runOAuthFlow } from './oauth';
import {
  clearGoogleAuth,
  getGoogleClientConfig,
  setGoogleClientConfig,
  setGoogleRefreshToken,
} from './token';
import {
  getAssignmentDueDates,
  getCalendarStatus,
  getEventsInRange,
  listCalendarRows,
  setCalendarEnabled,
} from './queries';
import { createCalendarEvent, deleteCalendarEvent, updateCalendarEvent, type EventDraft } from './writes';
import type { CalendarScheduler } from './scheduler';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerCalendarIpcHandlers(
  db: Database.Database,
  getWindow: () => BrowserWindow | null,
  scheduler: CalendarScheduler
): void {
  ipcMain.handle('calendar:get-status', () => getCalendarStatus(db));

  ipcMain.handle('calendar:set-client-config', (_event, clientId: string, clientSecret: string) => {
    try {
      setGoogleClientConfig(db, clientId, clientSecret);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle('calendar:connect', async () => {
    const config = getGoogleClientConfig(db);
    if (config === null) {
      return { ok: false, error: 'Save your Google Client ID and Client Secret first.' };
    }
    try {
      // The consent screen opens in the user's own browser, where they are
      // already signed in. No Google password ever passes through SmartLife.
      const tokens = await runOAuthFlow(config, (url) => {
        void shell.openExternal(url);
      });
      if (tokens.refreshToken === null) {
        // Without a refresh token the app can sync exactly once and then go
        // silent, which is worse than failing loudly here.
        return {
          ok: false,
          error: 'Google did not return a refresh token. Remove SmartLife from your Google account permissions and try again.',
        };
      }
      setGoogleRefreshToken(db, tokens.refreshToken);
      await scheduler.syncNow();
      getWindow()?.webContents.send('calendar:sync-changed');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle('calendar:disconnect', () => {
    clearGoogleAuth(db);
    return { ok: true };
  });

  ipcMain.handle('calendar:sync-now', async () => {
    await scheduler.syncNow();
    return getCalendarStatus(db);
  });

  ipcMain.handle('calendar:list-calendars', () => listCalendarRows(db));

  ipcMain.handle('calendar:set-calendar-enabled', async (_event, calendarId: string, enabled: boolean) => {
    setCalendarEnabled(db, calendarId, enabled);
    // A newly enabled calendar has no cached events yet, so toggling it on
    // without a sync would show an empty calendar.
    if (enabled) await scheduler.syncNow();
    getWindow()?.webContents.send('calendar:sync-changed');
    return listCalendarRows(db);
  });

  ipcMain.handle('calendar:get-events', (_event, fromDate: string, toDate: string) =>
    getEventsInRange(db, fromDate, toDate)
  );

  ipcMain.handle('calendar:get-assignments', (_event, fromDate: string, toDate: string) =>
    getAssignmentDueDates(db, fromDate, toDate)
  );

  ipcMain.handle('calendar:create-event', async (_event, draft: EventDraft) => {
    const result = await createCalendarEvent(db, draft);
    if (result.ok) getWindow()?.webContents.send('calendar:sync-changed');
    return result;
  });

  ipcMain.handle('calendar:update-event', async (_event, eventId: string, draft: EventDraft) => {
    const result = await updateCalendarEvent(db, eventId, draft);
    getWindow()?.webContents.send('calendar:sync-changed');
    return result;
  });

  ipcMain.handle('calendar:delete-event', async (_event, calendarId: string, eventId: string) => {
    const result = await deleteCalendarEvent(db, calendarId, eventId);
    if (result.ok) getWindow()?.webContents.send('calendar:sync-changed');
    return result;
  });
}
