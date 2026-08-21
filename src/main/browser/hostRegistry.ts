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
