import { contextBridge, ipcRenderer } from 'electron';

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
  },
};

contextBridge.exposeInMainWorld('smartlife', smartlife);

export type SmartlifeApi = typeof smartlife;
