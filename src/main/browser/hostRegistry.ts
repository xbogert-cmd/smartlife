import type { BrowserHost } from './view';

/**
 * The AI tools need the browser host, but ToolContext is shared by every tool
 * in the app and widening it for two of them would touch every other tool's
 * type surface for no benefit. Set once during IPC registration.
 */
let activeHost: BrowserHost | null = null;

export function setActiveBrowserHost(host: BrowserHost | null): void {
  activeHost = host;
}

export function getActiveBrowserHost(): BrowserHost | null {
  return activeHost;
}

/**
 * The origin of the tab a ref belongs to, or '' if it can't be resolved --
 * the tab may have closed, a test double may not implement getState, or the
 * URL may be malformed or still loading. Same try/catch shape as
 * viewContext.ts's browserLine(), which resolves a tab's origin for the
 * same reason: a confirmation description naming the wrong site (or
 * throwing) is worse than one that just omits the site.
 */
export function originForTab(tabId: string): string {
  try {
    const state = getActiveBrowserHost()?.getState();
    const tab = state?.tabs.find((t) => t.id === tabId);
    return tab !== undefined ? new URL(tab.url).origin : '';
  } catch {
    return '';
  }
}
