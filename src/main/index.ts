import { app, BrowserWindow, Menu, session, shell } from 'electron';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { registerIpcHandlers } from './ipc';
import { registerAiIpcHandlers } from './ai/ipc';
import { registerCanvasIpcHandlers } from './canvas/ipc';
import { startCanvasScheduler, type CanvasScheduler } from './canvas/scheduler';
import { registerCalendarIpcHandlers } from './calendar/ipc';
import { startCalendarScheduler, type CalendarScheduler } from './calendar/scheduler';
import { registerBrowserIpcHandlers } from './browser/ipc';
import type { BrowserHost } from './browser/view';
import { buildMenu } from './menu';
import { buildCsp } from './csp';
import { logError, getLogPath } from './log';
import { isAppLoadTarget, isSafeExternalUrl, resolveAppLoadUrl } from './url';

const isDev = !app.isPackaged;

function escapeHtml(value: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, (char) => map[char]);
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let dbConnection: Database.Database | null = null;
  let handlersRegistered = false;
  let canvasScheduler: CanvasScheduler | null = null;
  let calendarScheduler: CalendarScheduler | null = null;
  let browserHost: BrowserHost | null = null;

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  function createWindow(): BrowserWindow {
    const window = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      titleBarStyle: 'hiddenInset',
      // Explicit, not the OS default -- Sidebar.tsx's paddingTop below reserves
      // space for exactly this position, so the two can never silently drift
      // apart the way "leave it at the OS default and hope the CSS guess is
      // still right" would.
      trafficLightPosition: { x: 20, y: 20 },
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Canvas-authored HTML (announcements, page bodies) is sanitized but
    // deliberately keeps ordinary <a href> links. Without this guard,
    // clicking one would navigate this privileged window itself — and
    // Electron re-runs the preload script on same-webContents navigation,
    // handing the destination page the full window.smartlife IPC bridge.
    // Route ordinary links to the OS browser instead; never let the window
    // itself navigate anywhere but its own app content.
    const appLoadUrl = resolveAppLoadUrl(process.env.ELECTRON_RENDERER_URL, join(__dirname, '../renderer/index.html'));
    window.webContents.on('will-navigate', (event, navigationUrl) => {
      if (isAppLoadTarget(navigationUrl, appLoadUrl)) return;
      event.preventDefault();
      if (isSafeExternalUrl(navigationUrl)) void shell.openExternal(navigationUrl);
    });

    // target="_blank" (or window.open) must never create a second privileged
    // window; send it to the OS browser instead, same as will-navigate.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });

    window.once('ready-to-show', () => window.show());
    window.on('closed', () => {
      if (mainWindow === window) mainWindow = null;
    });

    return window;
  }

  function loadStartupError(window: BrowserWindow, message: string): void {
    const html = `<!doctype html><html><body style="font-family: -apple-system, sans-serif; padding: 32px; background: #0B0F14; color: #E8EDF2;">
      <h2>SmartLife failed to start</h2>
      <p>${escapeHtml(message)}</p>
      <p style="color: #8A9AAB; font-size: 13px;">Details were written to: ${escapeHtml(getLogPath())}</p>
    </body></html>`;
    window.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  }

  function loadContent(window: BrowserWindow): void {
    if (!handlersRegistered) {
      try {
        dbConnection = openDb();
        registerIpcHandlers(dbConnection, () => mainWindow);
        registerAiIpcHandlers(dbConnection, () => mainWindow);
        canvasScheduler = startCanvasScheduler(dbConnection, () => mainWindow);
        registerCanvasIpcHandlers(dbConnection, () => mainWindow, canvasScheduler);
        calendarScheduler = startCalendarScheduler(dbConnection, () => mainWindow);
        registerCalendarIpcHandlers(dbConnection, () => mainWindow, calendarScheduler);
        browserHost = registerBrowserIpcHandlers(dbConnection, () => mainWindow);
        handlersRegistered = true;
      } catch (error) {
        logError('startup', error);
        loadStartupError(window, error instanceof Error ? error.message : String(error));
        return;
      }
    }

    if (process.env.ELECTRON_RENDERER_URL) {
      window.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      window.loadFile(join(__dirname, '../renderer/index.html'));
    }
  }

  app.whenReady().then(() => {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [buildCsp(isDev)] },
      });
    });

    Menu.setApplicationMenu(buildMenu(() => mainWindow));

    mainWindow = createWindow();
    loadContent(mainWindow);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      loadContent(mainWindow);
    }
  });

  app.on('before-quit', () => {
    canvasScheduler?.stop();
    calendarScheduler?.stop();
    browserHost?.destroy();
    dbConnection?.close();
  });
}
