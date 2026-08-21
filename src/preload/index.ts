import { contextBridge, ipcRenderer } from 'electron';

interface StreamEvent {
  type: 'text-delta' | 'tool-status' | 'turn-complete';
  text?: string;
  toolName?: string;
  toolLabel?: string;
}

interface ConfirmRequest {
  id: string;
  toolName: string;
  description: string;
}

interface AiMessage {
  role: 'user' | 'assistant';
  content: unknown;
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

const smartlife = {
  theme: {
    get: (): Promise<'light' | 'dark' | 'system'> => ipcRenderer.invoke('theme:get'),
    set: (value: 'light' | 'dark' | 'system'): Promise<void> => ipcRenderer.invoke('theme:set', value),
    onSystemChange: (cb: (isDark: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, isDark: boolean) => cb(isDark);
      ipcRenderer.on('theme:system-changed', listener);
      return () => ipcRenderer.removeListener('theme:system-changed', listener);
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
    sendMessage: (text: string): Promise<void> => ipcRenderer.invoke('ai:send-message', text),
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
    getHistory: (): Promise<AiMessage[]> => ipcRenderer.invoke('ai:get-history'),
  },
  canvas: {
    getStatus: (): Promise<CanvasSyncStatus> => ipcRenderer.invoke('canvas:get-status'),
    setBaseUrl: (url: string): Promise<void> => ipcRenderer.invoke('canvas:set-base-url', url),
    setToken: (token: string): Promise<void> => ipcRenderer.invoke('canvas:set-token', token),
    clearToken: (): Promise<void> => ipcRenderer.invoke('canvas:clear-token'),
    testConnection: (): Promise<CanvasActionResult> => ipcRenderer.invoke('canvas:test-connection'),
    syncNow: (): Promise<CanvasSyncStatus> => ipcRenderer.invoke('canvas:sync-now'),
    getUpcoming: (days: number): Promise<unknown[]> => ipcRenderer.invoke('canvas:get-upcoming', days),
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
};

contextBridge.exposeInMainWorld('smartlife', smartlife);

export type SmartlifeApi = typeof smartlife;
