import { app, BrowserWindow, Menu, session } from 'electron';
import { join } from 'node:path';
import { openDb } from './db';
import { registerIpcHandlers } from './ipc';
import { buildMenu } from './menu';
import { buildCsp } from './csp';
import { logError, getLogPath } from './log';

const isDev = !app.isPackaged;

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  function createWindow(): void {
    mainWindow = new BrowserWindow({
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

    mainWindow.once('ready-to-show', () => mainWindow?.show());
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    if (process.env.ELECTRON_RENDERER_URL) {
      mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
    }
  }

  function showStartupError(message: string): void {
    const html = `<!doctype html><html><body style="font-family: -apple-system, sans-serif; padding: 32px; background: #0B0F14; color: #E8EDF2;">
      <h2>SmartLife failed to start</h2>
      <p>${message}</p>
      <p style="color: #8A9AAB; font-size: 13px;">Details were written to: ${getLogPath()}</p>
    </body></html>`;
    const errorWindow = new BrowserWindow({ width: 600, height: 320, webPreferences: { sandbox: true } });
    errorWindow.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  }

  app.whenReady().then(() => {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [buildCsp(isDev)] },
      });
    });

    Menu.setApplicationMenu(buildMenu(() => mainWindow));

    try {
      const db = openDb();
      registerIpcHandlers(db, () => mainWindow);
      createWindow();
    } catch (error) {
      logError('startup', error);
      showStartupError(error instanceof Error ? error.message : String(error));
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
