import { ipcMain, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { setStoredApiKey, hasStoredApiKey } from './apiKey';
import { getAiMode, setAiMode } from './mode';
import type { AiMode } from './permissions';
import { getOrCreateConversationId, getMessages } from './conversation';
import { resolveConfirmation } from './confirmations';
import { handleSendMessage } from './chatController';
import type { ViewContext } from './viewContext';
import { setActiveNavigator } from './navigatorRegistry';

export function registerAiIpcHandlers(db: Database.Database, getWindow: () => BrowserWindow | null): void {
  // Published so canvas_open_assignment can move the app to /browser, the
  // same channel the application menu uses.
  setActiveNavigator((path) => getWindow()?.webContents.send('navigate', path));

  ipcMain.handle('ai:get-api-key-status', () => hasStoredApiKey(db));
  ipcMain.handle('ai:set-api-key', (_event, apiKey: string) => {
    setStoredApiKey(db, apiKey);
  });

  ipcMain.handle('ai:get-mode', () => getAiMode(db));
  ipcMain.handle('ai:set-mode', (_event, mode: AiMode) => {
    setAiMode(db, mode);
  });

  ipcMain.handle('ai:send-message', (_event, text: string, view: ViewContext | null) =>
    handleSendMessage(db, getWindow, text, view ?? null)
  );
  ipcMain.handle('ai:confirm-response', (_event, id: string, approved: boolean) => {
    resolveConfirmation(id, approved);
  });
  ipcMain.handle('ai:get-history', () => {
    const conversationId = getOrCreateConversationId(db);
    return getMessages(db, conversationId).map((m) => ({ role: m.role, content: JSON.parse(m.content) }));
  });
}
