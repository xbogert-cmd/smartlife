import { app, BrowserWindow, Menu, session } from 'electron';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { registerIpcHandlers } from './ipc';
import { registerAiIpcHandlers } from './ai/ipc';
import { buildMenu } from './menu';
import { buildCsp } from './csp';
import { logError, getLogPath } from './log';

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
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
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
    dbConnection?.close();
  });
}
