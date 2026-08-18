import { ipcMain, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { setStoredApiKey, hasStoredApiKey } from './apiKey';

export function registerAiIpcHandlers(db: Database.Database, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('ai:get-api-key-status', () => hasStoredApiKey(db));
  ipcMain.handle('ai:set-api-key', (_event, apiKey: string) => {
    setStoredApiKey(db, apiKey);
  });
  void getWindow; // unused until Task 5 wires ai:send-message, which needs it — keeps the parameter's purpose visible now
}
