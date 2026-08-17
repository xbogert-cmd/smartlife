import type { SmartlifeApi } from './index';

declare global {
  interface Window {
    smartlife: SmartlifeApi;
  }
}

export {};
