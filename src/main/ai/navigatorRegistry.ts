/**
 * Lets a tool move the app to a route, the same way the application menu does
 * (`webContents.send('navigate', path)`).
 *
 * Registered rather than threaded through ToolContext for the same reason as
 * the browser host: one tool needs it, and widening the context shared by
 * every tool would touch all of them for no benefit.
 */
type Navigator = (path: string) => void;

let activeNavigator: Navigator | null = null;

export function setActiveNavigator(navigator: Navigator | null): void {
  activeNavigator = navigator;
}

export function getActiveNavigator(): Navigator | null {
  return activeNavigator;
}
