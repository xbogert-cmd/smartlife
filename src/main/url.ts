import { pathToFileURL } from 'node:url';

// Shared with canvas/ipc.ts's canvas:open-external handler and index.ts's
// navigation guard — one allowlist, checked in the main process, for any
// URL that came from Canvas-authored content or a page navigation.
export function isSafeExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

// The URL the main window is supposed to be showing: the Vite dev server in
// development, or the packaged renderer's index.html otherwise. Both
// loadContent() and the will-navigate guard need this same value.
export function resolveAppLoadUrl(rendererUrlEnv: string | undefined, indexHtmlPath: string): string {
  if (rendererUrlEnv) return rendererUrlEnv;
  return pathToFileURL(indexHtmlPath).toString();
}

// True when a navigation target is the app's own page rather than somewhere
// a click or script sent it. Anything else gets blocked by the will-navigate
// guard in index.ts.
export function isAppLoadTarget(navigationUrl: string, appLoadUrl: string): boolean {
  return navigationUrl === appLoadUrl;
}
