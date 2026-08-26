import { ipcMain, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { setStoredApiKey, hasStoredApiKey } from './apiKey';
import { getAiMode, setAiMode } from './mode';
import type { AiMode } from './permissions';
import { getOrCreateConversationId, getMessages } from './conversation';
import { getPendingConfirmation, resolveConfirmation, setConfirmationBroadcaster } from './confirmations';
import { handleSendMessage } from './chatController';
import type { ViewContext } from './viewContext';
import { setActiveNavigator } from './navigatorRegistry';
import { clearGeminiKey, clearPinnedEntry, getOllamaEndpoint, getPinnedEntry, hasGeminiKey, setGeminiKey, setOllamaEndpoint, setPinnedEntry, type PinnedEntry } from './providerConfig';
import { getRanking, setRanking, type RankingEntry } from './providerRanking';
import { CATALOG } from './providers/catalog';
import { listOllamaModels } from './providers/ollama';
import type { ProviderId } from './providers/types';
import { resetProviderCache, retryProviderEntry } from './router';

export function registerAiIpcHandlers(db: Database.Database, getWindow: () => BrowserWindow | null): void {
  // Published so canvas_open_assignment can move the app to /browser, the
  // same channel the application menu uses.
  setActiveNavigator((path) => getWindow()?.webContents.send('navigate', path));
  setConfirmationBroadcaster((id) => getWindow()?.webContents.send('ai:confirm-resolved', id));

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
  ipcMain.handle('ai:get-pending-confirmation', () => getPendingConfirmation());
  ipcMain.handle('ai:get-history', () => {
    const conversationId = getOrCreateConversationId(db);
    return getMessages(db, conversationId).map((m) => ({ role: m.role, content: JSON.parse(m.content) }));
  });

  ipcMain.handle('ai:get-catalog', () => CATALOG);

  ipcMain.handle('ai:get-gemini-key-status', () => hasGeminiKey(db));
  ipcMain.handle('ai:set-gemini-key', (_event, apiKey: string) => {
    setGeminiKey(db, apiKey);
    resetProviderCache();
  });
  ipcMain.handle('ai:clear-gemini-key', () => {
    clearGeminiKey(db);
    resetProviderCache();
  });

  ipcMain.handle('ai:get-ollama-endpoint', () => getOllamaEndpoint(db));
  ipcMain.handle('ai:set-ollama-endpoint', (_event, endpoint: string) => {
    setOllamaEndpoint(db, endpoint);
    resetProviderCache();
  });
  ipcMain.handle('ai:list-ollama-models', () => listOllamaModels(getOllamaEndpoint(db)));

  ipcMain.handle('ai:get-ranking', () => getRanking(db));
  ipcMain.handle('ai:set-ranking', (_event, entries: RankingEntry[]) => {
    setRanking(db, entries);
    resetProviderCache();
  });

  ipcMain.handle('ai:get-pinned-entry', () => getPinnedEntry(db));
  ipcMain.handle('ai:set-pinned-entry', (_event, entry: PinnedEntry) => {
    setPinnedEntry(db, entry);
    resetProviderCache();
  });
  ipcMain.handle('ai:clear-pinned-entry', () => {
    clearPinnedEntry(db);
    resetProviderCache();
  });

  ipcMain.handle('ai:retry-provider-entry', (_event, providerId: ProviderId, model: string) => {
    retryProviderEntry(db, providerId, model);
  });
}
