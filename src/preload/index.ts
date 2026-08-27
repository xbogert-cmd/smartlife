import { contextBridge, ipcRenderer } from 'electron';

interface StreamEvent {
  type: 'text-delta' | 'tool-status' | 'turn-complete' | 'provider-switched';
  text?: string;
  toolName?: string;
  toolLabel?: string;
  from?: string;
  to?: string;
  reason?: string;
  conversationId?: string;
}

interface ConfirmRequest {
  id: string;
  toolName: string;
  description: string;
}

interface AiMessage {
  role: 'user' | 'assistant';
  content: unknown;
  providerId: string | null;
  model: string | null;
}

interface CatalogEntry {
  providerId: 'anthropic' | 'gemini';
  model: string;
  displayName: string;
  costRank: number;
}

interface OllamaModelInfo {
  name: string;
}

type ProviderId = 'anthropic' | 'gemini' | 'ollama';

interface RankingEntry {
  providerId: ProviderId;
  model: string;
}

interface PinnedEntry {
  providerId: ProviderId;
  model: string;
}

interface CanvasSyncStatus {
  tokenConfigured: boolean;
  baseUrlConfigured: boolean;
  lastSyncedAt: string | null;
  tokenInvalid: boolean;
  tokenAgeDays: number | null;
  tokenExpiringSoon: boolean;
}

interface CanvasActionResult {
  ok: boolean;
  error?: string;
  name?: string;
}

interface CalendarStatus {
  clientConfigured: boolean;
  connected: boolean;
  accountEmail: string | null;
  lastSyncedAt: string | null;
  tokenInvalid: boolean;
}

interface CalendarActionResult {
  ok: boolean;
  error?: string;
  eventId?: string;
}

interface EventDraft {
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  attendees?: string[];
}

interface BrowserTab {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: { code: number; description: string } | null;
}

interface BrowserState {
  tabs: BrowserTab[];
  activeTabId: string;
}

interface BrowserDownloadRequest {
  id: string;
  filename: string;
  sizeBytes: number;
  sourceUrl: string;
}

interface BrowserFindResult {
  activeMatchOrdinal: number;
  matches: number;
}

interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BrowserHistoryEntry {
  url: string;
  title: string | null;
  visitedAt: string;
}

type PickAttachmentResult =
  | { ok: true; id: string; name: string; kind: 'text' | 'image' }
  | { ok: false; reason: string };

interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}

interface UsageRow {
  providerId: string;
  model: string;
  displayName: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

const smartlife = {
  theme: {
    get: (): Promise<'light' | 'dark' | 'system'> => ipcRenderer.invoke('theme:get'),
    set: (value: 'light' | 'dark' | 'system'): Promise<void> => ipcRenderer.invoke('theme:set', value),
    onSystemChange: (cb: (isDark: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, isDark: boolean) => cb(isDark);
      ipcRenderer.on('theme:system-changed', listener);
      return () => ipcRenderer.removeListener('theme:system-changed', listener);
    },
    onPreferenceChange: (cb: (value: 'light' | 'dark' | 'system') => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, value: 'light' | 'dark' | 'system') => cb(value);
      ipcRenderer.on('theme:preference-changed', listener);
      return () => ipcRenderer.removeListener('theme:preference-changed', listener);
    },
  },
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  },
  navigation: {
    onNavigate: (cb: (path: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, path: string) => cb(path);
      ipcRenderer.on('navigate', listener);
      return () => ipcRenderer.removeListener('navigate', listener);
    },
  },
  ai: {
    getApiKeyStatus: (): Promise<boolean> => ipcRenderer.invoke('ai:get-api-key-status'),
    setApiKey: (apiKey: string): Promise<void> => ipcRenderer.invoke('ai:set-api-key', apiKey),
    getMode: (): Promise<'ask' | 'assist' | 'auto'> => ipcRenderer.invoke('ai:get-mode'),
    setMode: (mode: 'ask' | 'assist' | 'auto'): Promise<void> => ipcRenderer.invoke('ai:set-mode', mode),
    sendMessage: (text: string, view: unknown = null, attachmentIds: string[] = [], conversationId: string): Promise<void> =>
      ipcRenderer.invoke('ai:send-message', text, view, attachmentIds, conversationId),
    onStreamEvent: (cb: (event: StreamEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, streamEvent: StreamEvent) => cb(streamEvent);
      ipcRenderer.on('ai:stream-event', listener);
      return () => ipcRenderer.removeListener('ai:stream-event', listener);
    },
    onConfirmRequest: (cb: (req: ConfirmRequest) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, req: ConfirmRequest) => cb(req);
      ipcRenderer.on('ai:confirm-request', listener);
      return () => ipcRenderer.removeListener('ai:confirm-request', listener);
    },
    respondToConfirm: (id: string, approved: boolean): Promise<void> => ipcRenderer.invoke('ai:confirm-response', id, approved),
    getHistory: (conversationId: string): Promise<AiMessage[]> => ipcRenderer.invoke('ai:get-history', conversationId),
    getPendingConfirmation: (): Promise<ConfirmRequest | null> => ipcRenderer.invoke('ai:get-pending-confirmation'),
    onConfirmResolved: (cb: (id: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, id: string) => cb(id);
      ipcRenderer.on('ai:confirm-resolved', listener);
      return () => ipcRenderer.removeListener('ai:confirm-resolved', listener);
    },
    getCatalog: (): Promise<CatalogEntry[]> => ipcRenderer.invoke('ai:get-catalog'),
    getGeminiKeyStatus: (): Promise<boolean> => ipcRenderer.invoke('ai:get-gemini-key-status'),
    setGeminiKey: (apiKey: string): Promise<void> => ipcRenderer.invoke('ai:set-gemini-key', apiKey),
    clearGeminiKey: (): Promise<void> => ipcRenderer.invoke('ai:clear-gemini-key'),
    getOllamaEndpoint: (): Promise<string> => ipcRenderer.invoke('ai:get-ollama-endpoint'),
    setOllamaEndpoint: (endpoint: string): Promise<void> => ipcRenderer.invoke('ai:set-ollama-endpoint', endpoint),
    listOllamaModels: (): Promise<OllamaModelInfo[]> => ipcRenderer.invoke('ai:list-ollama-models'),
    getRanking: (): Promise<RankingEntry[]> => ipcRenderer.invoke('ai:get-ranking'),
    setRanking: (entries: RankingEntry[]): Promise<void> => ipcRenderer.invoke('ai:set-ranking', entries),
    getPinnedEntry: (): Promise<PinnedEntry | null> => ipcRenderer.invoke('ai:get-pinned-entry'),
    setPinnedEntry: (entry: PinnedEntry): Promise<void> => ipcRenderer.invoke('ai:set-pinned-entry', entry),
    clearPinnedEntry: (): Promise<void> => ipcRenderer.invoke('ai:clear-pinned-entry'),
    retryProviderEntry: (providerId: ProviderId, model: string): Promise<void> =>
      ipcRenderer.invoke('ai:retry-provider-entry', providerId, model),
    hasUsableProvider: (): Promise<boolean> => ipcRenderer.invoke('ai:has-usable-provider'),
    pickAttachment: (): Promise<PickAttachmentResult | null> => ipcRenderer.invoke('ai:pick-attachment'),
    listConversations: (): Promise<ConversationSummary[]> => ipcRenderer.invoke('ai:list-conversations'),
    createConversation: (): Promise<string> => ipcRenderer.invoke('ai:create-conversation'),
    renameConversation: (id: string, title: string): Promise<void> =>
      ipcRenderer.invoke('ai:rename-conversation', id, title),
    deleteConversation: (id: string): Promise<void> => ipcRenderer.invoke('ai:delete-conversation', id),
    getUsageSummary: (): Promise<UsageRow[]> => ipcRenderer.invoke('ai:get-usage-summary'),
  },
  canvas: {
    getStatus: (): Promise<CanvasSyncStatus> => ipcRenderer.invoke('canvas:get-status'),
    setBaseUrl: (url: string): Promise<void> => ipcRenderer.invoke('canvas:set-base-url', url),
    setToken: (token: string): Promise<void> => ipcRenderer.invoke('canvas:set-token', token),
    clearToken: (): Promise<void> => ipcRenderer.invoke('canvas:clear-token'),
    testConnection: (): Promise<CanvasActionResult> => ipcRenderer.invoke('canvas:test-connection'),
    syncNow: (): Promise<CanvasSyncStatus> => ipcRenderer.invoke('canvas:sync-now'),
    getUpcoming: (days: number): Promise<unknown[]> => ipcRenderer.invoke('canvas:get-upcoming', days),
    getOverdue: (days: number): Promise<unknown[]> => ipcRenderer.invoke('canvas:get-overdue', days),
    getGrades: (): Promise<unknown[]> => ipcRenderer.invoke('canvas:get-grades'),
    getAnnouncements: (limit: number): Promise<unknown[]> =>
      ipcRenderer.invoke('canvas:get-announcements', limit),
    getCourse: (courseId: number): Promise<unknown> => ipcRenderer.invoke('canvas:get-course', courseId),
    syncCourse: (courseId: number): Promise<unknown> => ipcRenderer.invoke('canvas:sync-course', courseId),
    getPage: (courseId: number, pageUrl: string): Promise<unknown> =>
      ipcRenderer.invoke('canvas:get-page', courseId, pageUrl),
    openFile: (fileId: number): Promise<CanvasActionResult> => ipcRenderer.invoke('canvas:open-file', fileId),
    openExternal: (url: string): Promise<CanvasActionResult> =>
      ipcRenderer.invoke('canvas:open-external', url),
    searchMaterials: (query: string): Promise<unknown[]> =>
      ipcRenderer.invoke('canvas:search-materials', query),
    onSyncChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      ipcRenderer.on('canvas:sync-changed', listener);
      return () => ipcRenderer.removeListener('canvas:sync-changed', listener);
    },
    getAssignment: (assignmentId: number): Promise<unknown> =>
      ipcRenderer.invoke('canvas:get-assignment', assignmentId),
    saveDraft: (assignmentId: number, body: string): Promise<void> =>
      ipcRenderer.invoke('canvas:save-draft', assignmentId, body),
    clearDraft: (assignmentId: number): Promise<void> =>
      ipcRenderer.invoke('canvas:clear-draft', assignmentId),
    pickFile: (): Promise<{ path: string; name: string; size: number } | null> =>
      ipcRenderer.invoke('canvas:pick-file'),
    submit: (
      assignmentId: number,
      input:
        | { kind: 'text'; body: string }
        | { kind: 'file'; filePath: string }
        | { kind: 'discussion'; message: string }
    ): Promise<{ ok: boolean; verified: boolean; submittedAt: string | null; message: string }> =>
      ipcRenderer.invoke('canvas:submit', assignmentId, input),
  },
  calendar: {
    getStatus: (): Promise<CalendarStatus> => ipcRenderer.invoke('calendar:get-status'),
    setClientConfig: (clientId: string, clientSecret: string): Promise<CalendarActionResult> =>
      ipcRenderer.invoke('calendar:set-client-config', clientId, clientSecret),
    connect: (): Promise<CalendarActionResult> => ipcRenderer.invoke('calendar:connect'),
    disconnect: (): Promise<CalendarActionResult> => ipcRenderer.invoke('calendar:disconnect'),
    syncNow: (): Promise<CalendarStatus> => ipcRenderer.invoke('calendar:sync-now'),
    listCalendars: (): Promise<unknown[]> => ipcRenderer.invoke('calendar:list-calendars'),
    setCalendarEnabled: (calendarId: string, enabled: boolean): Promise<unknown[]> =>
      ipcRenderer.invoke('calendar:set-calendar-enabled', calendarId, enabled),
    getEvents: (fromDate: string, toDate: string): Promise<unknown[]> =>
      ipcRenderer.invoke('calendar:get-events', fromDate, toDate),
    getAssignments: (fromDate: string, toDate: string): Promise<unknown[]> =>
      ipcRenderer.invoke('calendar:get-assignments', fromDate, toDate),
    createEvent: (draft: EventDraft): Promise<CalendarActionResult> =>
      ipcRenderer.invoke('calendar:create-event', draft),
    updateEvent: (eventId: string, draft: EventDraft): Promise<CalendarActionResult> =>
      ipcRenderer.invoke('calendar:update-event', eventId, draft),
    deleteEvent: (calendarId: string, eventId: string): Promise<CalendarActionResult> =>
      ipcRenderer.invoke('calendar:delete-event', calendarId, eventId),
    onSyncChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      ipcRenderer.on('calendar:sync-changed', listener);
      return () => ipcRenderer.removeListener('calendar:sync-changed', listener);
    },
  },
  browser: {
    getState: (): Promise<BrowserState> => ipcRenderer.invoke('browser:get-state'),
    // Exposed to the app, deliberately not to the AI: Phase 3b opens a Canvas
    // assignment URL here. AI-driven navigation is Phase 5b.
    openTab: (url: string): Promise<string> => ipcRenderer.invoke('browser:open-tab', url),
    closeTab: (id: string): Promise<void> => ipcRenderer.invoke('browser:close-tab', id),
    activateTab: (id: string): Promise<void> => ipcRenderer.invoke('browser:activate-tab', id),
    navigate: (id: string, input: string): Promise<void> =>
      ipcRenderer.invoke('browser:navigate', id, input),
    goBack: (id: string): Promise<void> => ipcRenderer.invoke('browser:go-back', id),
    goForward: (id: string): Promise<void> => ipcRenderer.invoke('browser:go-forward', id),
    reload: (id: string): Promise<void> => ipcRenderer.invoke('browser:reload', id),
    stop: (id: string): Promise<void> => ipcRenderer.invoke('browser:stop', id),
    find: (id: string, text: string): Promise<void> => ipcRenderer.invoke('browser:find', id, text),
    stopFind: (id: string): Promise<void> => ipcRenderer.invoke('browser:stop-find', id),
    setBounds: (rect: BrowserRect): Promise<void> => ipcRenderer.invoke('browser:set-bounds', rect),
    setRouteActive: (active: boolean): Promise<void> =>
      ipcRenderer.invoke('browser:set-route-active', active),
    suspend: (): Promise<void> => ipcRenderer.invoke('browser:suspend'),
    resume: (): Promise<void> => ipcRenderer.invoke('browser:resume'),
    findHistory: (prefix: string): Promise<BrowserHistoryEntry[]> =>
      ipcRenderer.invoke('browser:find-history', prefix),
    clearData: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('browser:clear-data'),
    respondToDownload: (id: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke('browser:download-response', id, approved),
    onStateChanged: (cb: (state: BrowserState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: BrowserState): void => cb(state);
      ipcRenderer.on('browser:state-changed', listener);
      return () => ipcRenderer.removeListener('browser:state-changed', listener);
    },
    onDownloadRequest: (cb: (request: BrowserDownloadRequest) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, request: BrowserDownloadRequest): void =>
        cb(request);
      ipcRenderer.on('browser:download-request', listener);
      return () => ipcRenderer.removeListener('browser:download-request', listener);
    },
    onFindResult: (cb: (result: BrowserFindResult) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, result: BrowserFindResult): void => cb(result);
      ipcRenderer.on('browser:find-result', listener);
      return () => ipcRenderer.removeListener('browser:find-result', listener);
    },
  },
};

contextBridge.exposeInMainWorld('smartlife', smartlife);

export type SmartlifeApi = typeof smartlife;
