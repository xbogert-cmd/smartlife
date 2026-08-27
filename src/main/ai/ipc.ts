import { ipcMain, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { setStoredApiKey, hasStoredApiKey } from './apiKey';
import { getAiMode, setAiMode } from './mode';
import type { AiMode } from './permissions';
import { getMessages, createConversation, listConversations, renameConversation, deleteConversation, getUsageSummary } from './conversation';
import { getPendingConfirmation, resolveConfirmation, setConfirmationBroadcaster } from './confirmations';
import { handleSendMessage } from './chatController';
import type { ViewContext } from './viewContext';
import { setActiveNavigator } from './navigatorRegistry';
import { clearGeminiKey, clearPinnedEntry, getOllamaEndpoint, getPinnedEntry, hasGeminiKey, setGeminiKey, setOllamaEndpoint, setPinnedEntry, type PinnedEntry } from './providerConfig';
import { getRanking, seedRankingIfEmpty, setRanking, type RankingEntry } from './providerRanking';
import { CATALOG } from './providers/catalog';
import { listOllamaModels } from './providers/ollama';
import type { ProviderId } from './providers/types';
import { getActiveCapabilities, hasUsableProvider, resetProviderCache, retryProviderEntry } from './router';
import { pickAttachment } from './attachments/pickAttachment';
import { transcribeAudio } from './voice/transcribe';

export function registerAiIpcHandlers(db: Database.Database, getWindow: () => BrowserWindow | null): void {
  // Published so canvas_open_assignment can move the app to /browser, the
  // same channel the application menu uses.
  setActiveNavigator((path) => getWindow()?.webContents.send('navigate', path));
  setConfirmationBroadcaster((id) => getWindow()?.webContents.send('ai:confirm-resolved', id));

  ipcMain.handle('ai:get-api-key-status', () => hasStoredApiKey(db));
  ipcMain.handle('ai:set-api-key', (_event, apiKey: string) => {
    setStoredApiKey(db, apiKey);
    seedRankingIfEmpty(db, { providerId: 'anthropic', model: 'claude-haiku-4-5-20251001' });
    resetProviderCache();
  });

  ipcMain.handle('ai:get-mode', () => getAiMode(db));
  ipcMain.handle('ai:set-mode', (_event, mode: AiMode) => {
    setAiMode(db, mode);
  });

  ipcMain.handle(
    'ai:send-message',
    (_event, text: string, view: ViewContext | null, attachmentIds: string[] = [], conversationId: string) =>
      handleSendMessage(db, getWindow, text, view ?? null, conversationId, { attachmentIds })
  );
  ipcMain.handle('ai:confirm-response', (_event, id: string, approved: boolean) => {
    resolveConfirmation(id, approved);
  });
  ipcMain.handle('ai:get-pending-confirmation', () => getPendingConfirmation());
  ipcMain.handle('ai:get-history', (_event, conversationId: string) => {
    return getMessages(db, conversationId).map((m) => ({
      role: m.role,
      content: JSON.parse(m.content),
      providerId: m.providerId,
      model: m.model,
    }));
  });

  ipcMain.handle('ai:list-conversations', () => listConversations(db));
  ipcMain.handle('ai:create-conversation', () => createConversation(db));
  ipcMain.handle('ai:rename-conversation', (_event, id: string, title: string) => {
    renameConversation(db, id, title);
  });
  ipcMain.handle('ai:delete-conversation', (_event, id: string) => {
    deleteConversation(db, id);
  });
  ipcMain.handle('ai:get-usage-summary', () => getUsageSummary(db));

  ipcMain.handle('ai:get-catalog', () => CATALOG);

  ipcMain.handle('ai:get-gemini-key-status', () => hasGeminiKey(db));
  ipcMain.handle('ai:set-gemini-key', (_event, apiKey: string) => {
    setGeminiKey(db, apiKey);
    seedRankingIfEmpty(db, { providerId: 'gemini', model: 'gemini-2.5-flash' });
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

  ipcMain.handle('ai:has-usable-provider', () => hasUsableProvider(db));

  ipcMain.handle('ai:pick-attachment', () => pickAttachment(getWindow(), getActiveCapabilities(db).supportsVision));
  ipcMain.handle('ai:transcribe-audio', (_event, data: string, mimeType: string) => transcribeAudio(db, data, mimeType));
}
