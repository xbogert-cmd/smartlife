import { app, ipcMain, session, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { logError } from '../log';
import type { DownloadRequest } from './downloads';
import type { ViewportRect } from './geometry';
import { BROWSER_PARTITION } from './handlers';
import { clearHistory, findHistory, historyCutoff, pruneHistory } from './history';
import { createBrowserHost, type BrowserHost, type FindResult } from './view';

export function registerBrowserIpcHandlers(
  db: Database.Database,
  getWindow: () => BrowserWindow | null
): BrowserHost {
  // Bound on every launch so the table cannot grow without limit. Cheap: one
  // indexed DELETE against a table that only ever holds ~90 days of rows.
  try {
    pruneHistory(db, historyCutoff());
  } catch (error) {
    logError('browser:pruneHistory', error);
  }

  // The host attaches views to the window's contentView, so the window must
  // exist before registration. Fail fast with a clear error rather than
  // letting an opaque Electron crash happen inside contentView.addChildView.
  const window = getWindow();
  if (window === null) {
    throw new Error('registerBrowserIpcHandlers must be called after the main window exists.');
  }

  // Pending download confirmations, keyed by request id. Mirrors the
  // ai:confirm-request / ai:confirm-response pair rather than inventing a
  // second idiom for the same shape of problem.
  const pendingDownloads = new Map<string, (approved: boolean) => void>();
  let downloadCounter = 0;

  function confirmDownload(request: DownloadRequest): Promise<boolean> {
    const window = getWindow();
    // No window means nobody can answer. A download that cannot be confirmed
    // must never default to "yes".
    if (window === null) return Promise.resolve(false);

    downloadCounter += 1;
    const id = `download-${downloadCounter}`;
    return new Promise<boolean>((resolve) => {
      pendingDownloads.set(id, resolve);
      window.webContents.send('browser:download-request', { id, ...request });
    });
  }

  const host = createBrowserHost({
    window,
    db,
    downloadsDir: app.getPath('downloads'),
    onStateChange: (state) => getWindow()?.webContents.send('browser:state-changed', state),
    confirmDownload,
    onFindResult: (result: FindResult) => getWindow()?.webContents.send('browser:find-result', result),
  });

  ipcMain.handle('browser:get-state', () => host.getState());
  ipcMain.handle('browser:open-tab', (_event, url: string) => host.openTab(url));
  ipcMain.handle('browser:close-tab', (_event, id: string) => host.closeTab(id));
  ipcMain.handle('browser:activate-tab', (_event, id: string) => host.activateTab(id));
  ipcMain.handle('browser:navigate', (_event, id: string, input: string) => host.navigate(id, input));
  ipcMain.handle('browser:go-back', (_event, id: string) => host.goBack(id));
  ipcMain.handle('browser:go-forward', (_event, id: string) => host.goForward(id));
  ipcMain.handle('browser:reload', (_event, id: string) => host.reload(id));
  ipcMain.handle('browser:stop', (_event, id: string) => host.stop(id));
  ipcMain.handle('browser:find', (_event, id: string, text: string) => host.find(id, text));
  ipcMain.handle('browser:stop-find', (_event, id: string) => host.stopFind(id));

  ipcMain.handle('browser:set-bounds', (_event, rect: ViewportRect) => host.setBounds(rect));
  ipcMain.handle('browser:set-route-active', (_event, active: boolean) => host.setRouteActive(active));
  ipcMain.handle('browser:suspend', () => host.suspend());
  ipcMain.handle('browser:resume', () => host.resume());

  ipcMain.handle('browser:find-history', (_event, prefix: string) => findHistory(db, prefix));

  ipcMain.handle('browser:clear-data', async () => {
    clearHistory(db);
    const browserSession = session.fromPartition(BROWSER_PARTITION);
    // Cookies and site data are persisted on disk by this phase, so "clear"
    // has to mean all three or it is a false promise.
    await browserSession.clearStorageData();
    await browserSession.clearCache();
    return { ok: true };
  });

  ipcMain.handle('browser:download-response', (_event, id: string, approved: boolean) => {
    const resolve = pendingDownloads.get(id);
    if (!resolve) return;
    pendingDownloads.delete(id);
    resolve(approved);
  });

  return host;
}
