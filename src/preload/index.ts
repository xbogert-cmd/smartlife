import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('smartlife', {});
