import { ipcMain, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import {
  clearCanvasToken,
  getCanvasCredentials,
  setCanvasBaseUrl,
  setCanvasToken,
} from './token';
import { getSelf } from './api';
import { fetchPageBody, syncCourseContent } from './sync';
import { openCanvasFile } from './files';
import {
  getCourseDetail,
  getCourseGrades,
  getPageBody,
  getRecentAnnouncements,
  getSyncStatus,
  getUpcomingAssignments,
  searchMaterials,
} from './queries';
import type { CanvasScheduler } from './scheduler';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerCanvasIpcHandlers(
  db: Database.Database,
  getWindow: () => BrowserWindow | null,
  scheduler: CanvasScheduler
): void {
  ipcMain.handle('canvas:get-status', () => getSyncStatus(db));

  ipcMain.handle('canvas:set-base-url', (_event, url: string) => {
    setCanvasBaseUrl(db, url);
  });

  ipcMain.handle('canvas:set-token', (_event, token: string) => {
    setCanvasToken(db, token);
  });

  ipcMain.handle('canvas:clear-token', () => {
    clearCanvasToken(db);
  });

  ipcMain.handle('canvas:test-connection', async () => {
    const creds = getCanvasCredentials(db);
    if (creds === null) {
      return { ok: false, error: 'Add both the Canvas URL and an access token first.' };
    }
    try {
      const user = await getSelf(creds);
      return { ok: true, name: user.name };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle('canvas:sync-now', async () => {
    await scheduler.syncNow();
    return getSyncStatus(db);
  });

  ipcMain.handle('canvas:get-upcoming', (_event, days: number) => getUpcomingAssignments(db, days));
  ipcMain.handle('canvas:get-grades', () => getCourseGrades(db));
  ipcMain.handle('canvas:get-announcements', (_event, limit: number) => getRecentAnnouncements(db, limit));
  ipcMain.handle('canvas:get-course', (_event, courseId: number) => getCourseDetail(db, courseId));
  ipcMain.handle('canvas:search-materials', (_event, query: string) => searchMaterials(db, query));

  ipcMain.handle('canvas:sync-course', async (_event, courseId: number) => {
    const creds = getCanvasCredentials(db);
    if (creds === null) return { ok: false, tokenInvalid: false, errors: ['Canvas is not connected.'] };
    const result = await syncCourseContent(db, creds, courseId);
    getWindow()?.webContents.send('canvas:sync-changed');
    return result;
  });

  ipcMain.handle('canvas:get-page', async (_event, courseId: number, pageUrl: string) => {
    const cached = getPageBody(db, courseId, pageUrl);
    if (cached && cached.body !== null) return cached;
    const creds = getCanvasCredentials(db);
    if (creds === null) return cached;
    await fetchPageBody(db, creds, courseId, pageUrl);
    return getPageBody(db, courseId, pageUrl);
  });

  ipcMain.handle('canvas:open-file', async (_event, fileId: number) => {
    const creds = getCanvasCredentials(db);
    if (creds === null) return { ok: false, error: 'Canvas is not connected.' };
    try {
      await openCanvasFile(db, creds, fileId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });
}
