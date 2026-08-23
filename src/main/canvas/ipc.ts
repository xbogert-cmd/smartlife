import { ipcMain, shell, dialog, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  clearCanvasToken,
  getCanvasCredentials,
  setCanvasBaseUrl,
  setCanvasToken,
} from './token';
import { getSelf } from './api';
import { clearSyncState, fetchPageBody, syncCourseContent, SYNC_KEY_TOKEN_INVALID } from './sync';
import { openCanvasFile } from './files';
import {
  getAssignmentDetail,
  getCourseDetail,
  getCourseGrades,
  getOverdueAssignments,
  getPageBody,
  getRecentAnnouncements,
  getSyncStatus,
  getUpcomingAssignments,
  searchMaterials,
} from './queries';
import { clearDraft, saveDraft } from './drafts';
import { submitAssignment, type SubmitInput } from './submit';
import { setActiveCanvasScheduler } from './schedulerRegistry';
import type { CanvasScheduler } from './scheduler';
import { isSafeExternalUrl } from '../url';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The AI's canvas_submit_assignment tool deliberately has no file/path
// parameter, so a prompt-injected model can never name an arbitrary local
// file for upload. canvas:submit must hold the same line for the renderer:
// a filePath is only honored here if it was actually handed back by
// canvas:pick-file in this session, never an arbitrary string the caller
// supplies.
const pickedFilePaths = new Set<string>();

export function registerCanvasIpcHandlers(
  db: Database.Database,
  getWindow: () => BrowserWindow | null,
  scheduler: CanvasScheduler
): void {
  // Published so the AI submit tool can reach the same exclusivity guard.
  setActiveCanvasScheduler(scheduler);

  ipcMain.handle('canvas:get-status', () => getSyncStatus(db));

  ipcMain.handle('canvas:set-base-url', (_event, url: string) => {
    setCanvasBaseUrl(db, url);
  });

  ipcMain.handle('canvas:set-token', (_event, token: string) => {
    setCanvasToken(db, token);
    // A fresh token deserves a fresh chance -- otherwise the background
    // scheduler's known-invalid skip (canvas/scheduler.ts) would keep
    // silently declining to try the new token until a sync happened to
    // succeed some other way.
    clearSyncState(db, SYNC_KEY_TOKEN_INVALID);
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
  ipcMain.handle('canvas:get-overdue', (_event, days: number) => getOverdueAssignments(db, days));
  ipcMain.handle('canvas:get-grades', () => getCourseGrades(db));
  ipcMain.handle('canvas:get-announcements', (_event, limit: number) => getRecentAnnouncements(db, limit));
  ipcMain.handle('canvas:get-course', (_event, courseId: number) => getCourseDetail(db, courseId));
  ipcMain.handle('canvas:search-materials', (_event, query: string) => searchMaterials(db, query));

  ipcMain.handle('canvas:sync-course', async (_event, courseId: number) => {
    const creds = getCanvasCredentials(db);
    if (creds === null) return { ok: false, tokenInvalid: false, errors: ['Canvas is not connected.'] };
    // Route through the scheduler's own in-flight guard so this never runs
    // concurrently with the background/focus-triggered sync — Canvas's API
    // guidance is against overlapping request chains.
    const result = await scheduler.runExclusive(() => syncCourseContent(db, creds, courseId));
    if (result === null) {
      return { ok: false, tokenInvalid: false, errors: ['A Canvas sync is already in progress. Try again shortly.'] };
    }
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

  ipcMain.handle('canvas:open-external', async (_event, url: string) => {
    // These URLs come from Canvas data. Anything other than http(s) — file:,
    // or a custom scheme registered by another app — must never be opened.
    if (!isSafeExternalUrl(url)) {
      return { ok: false, error: 'Only web links can be opened.' };
    }
    await shell.openExternal(new URL(url).toString());
    return { ok: true };
  });

  ipcMain.handle('canvas:get-assignment', async (_event, assignmentId: number) =>
    getAssignmentDetail(db, assignmentId)
  );

  ipcMain.handle('canvas:save-draft', (_event, assignmentId: number, body: string) => {
    saveDraft(db, assignmentId, body);
  });

  ipcMain.handle('canvas:clear-draft', (_event, assignmentId: number) => {
    clearDraft(db, assignmentId);
  });

  /**
   * The native picker runs main-side and hands back only a path plus display
   * metadata. The renderer never touches file bytes and no fs API crosses the
   * preload bridge.
   */
  ipcMain.handle('canvas:pick-file', async () => {
    const window = getWindow();
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openFile'] })
      : await dialog.showOpenDialog({ properties: ['openFile'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    try {
      const info = await stat(filePath);
      pickedFilePaths.add(filePath);
      return { path: filePath, name: basename(filePath), size: info.size };
    } catch {
      return null;
    }
  });

  ipcMain.handle('canvas:submit', async (_event, assignmentId: number, input: SubmitInput) => {
    const creds = getCanvasCredentials(db);
    if (creds === null) {
      return { ok: false, verified: false, submittedAt: null, message: 'Canvas is not connected.' };
    }
    if (input.kind === 'file' && !pickedFilePaths.has(input.filePath)) {
      return {
        ok: false,
        verified: false,
        submittedAt: null,
        message: 'That file was not selected through the file picker.',
      };
    }
    if (input.kind === 'file') pickedFilePaths.delete(input.filePath);
    // Same guard canvas:sync-course uses: a submission must never overlap a
    // background sync.
    const outcome = await scheduler.runExclusive(() =>
      submitAssignment(db, creds, assignmentId, input)
    );
    if (outcome === null) {
      return {
        ok: false,
        verified: false,
        submittedAt: null,
        message: 'A Canvas sync is already in progress. Try again shortly.',
      };
    }
    getWindow()?.webContents.send('canvas:sync-changed');
    return outcome;
  });
}
