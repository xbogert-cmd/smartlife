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
};

contextBridge.exposeInMainWorld('smartlife', smartlife);

export type SmartlifeApi = typeof smartlife;
