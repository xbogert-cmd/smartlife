import { Notification, type BrowserWindow } from 'electron';

/**
 * A confirmation with a long timeout is meant to be seen eventually, not
 * necessarily right away -- this is the nudge that makes "eventually"
 * actually happen instead of the user forgetting it exists. Only fires when
 * the window genuinely isn't in front of the user; a focused window already
 * has its own badge (Sidebar's pending-confirmation dot).
 */
export function notifyIfUnfocused(win: BrowserWindow | null, title: string, body: string): void {
  if (win === null || win.isFocused()) return;
  new Notification({ title, body }).show();
}
