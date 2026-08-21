import { isAllowedNavigationUrl, shouldAllowPermission } from './security';

/**
 * All tabs share one persistent partition.
 *
 * Persistent because the Canvas login has to survive tab switches and app
 * restarts -- that is the entire premise of Canvas-in-browser and of Phase 3b.
 *
 * NOT the default session, and that part is about correctness rather than
 * isolation: the app's Content-Security-Policy is applied to
 * session.defaultSession (src/main/index.ts), and inheriting
 * `default-src 'self'` would break every website loaded here.
 */
export const BROWSER_PARTITION = 'persist:browser';

/**
 * The exact webPreferences object passed to every WebContentsView.
 *
 * There is deliberately no `preload` key. window.smartlife must not be
 * reachable from embedded web content, and the way to guarantee that is to
 * never put it there in the first place. handlers.test.ts asserts on this.
 *
 * `webSecurity` is absent too, which leaves it at its secure default (true).
 */
export const EMBEDDED_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  partition: BROWSER_PARTITION,
} as const;

/** Structural stand-in for Electron.Event, so this module stays testable. */
export interface PreventableEvent {
  preventDefault(): void;
}

/**
 * Wired to will-navigate and will-redirect on every embedded webContents.
 * Allowlist, not blocklist -- see security.ts.
 */
export function createNavigationGuard(
  onBlocked: (url: string) => void
): (event: PreventableEvent, url: string) => void {
  return (event, url) => {
    if (isAllowedNavigationUrl(url)) return;
    event.preventDefault();
    try {
      onBlocked(url);
    } catch {
      // onBlocked is a notification channel; its failure must not prevent the
      // security verdict (preventDefault was already called).
    }
  };
}

export interface WindowOpenResult {
  action: 'deny';
}

/**
 * Wired to setWindowOpenHandler on every embedded webContents.
 *
 * ALWAYS returns deny, then opens a tab itself. Returning 'allow' would hand
 * Electron the job of creating a real BrowserWindow with webPreferences we did
 * not specify -- and every rendering surface in this app must be one we
 * configured deliberately.
 */
export function createWindowOpenHandler(
  openTab: (url: string) => void,
  onBlocked: (url: string) => void
): (details: { url: string }) => WindowOpenResult {
  return ({ url }) => {
    if (isAllowedNavigationUrl(url)) {
      try {
        openTab(url);
      } catch {
        // openTab is a notification channel; its failure must not prevent the
        // security verdict (deny is still returned).
      }
    } else {
      try {
        onBlocked(url);
      } catch {
        // onBlocked is a notification channel; its failure must not prevent the
        // security verdict (deny is still returned).
      }
    }
    return { action: 'deny' };
  };
}

export interface PermissionHandlers {
  requestHandler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void;
  checkHandler: (contents: unknown, permission: string) => boolean;
}

/**
 * Both handlers are installed on the partition. The synchronous check handler
 * is the one that gets forgotten, and forgetting it means some permission
 * checks silently succeed.
 *
 * Every denial is reported so that if something the user genuinely needs
 * breaks, there is evidence rather than a theory about which permission to
 * allow.
 */
export function createPermissionHandlers(onDenied: (permission: string) => void): PermissionHandlers {
  return {
    requestHandler(_contents, permission, callback) {
      try {
        onDenied(permission);
      } catch {
        // onDenied is a notification channel; its failure must not prevent the
        // security verdict (callback is still invoked).
      }
      callback(shouldAllowPermission(permission));
    },
    checkHandler(_contents, permission) {
      try {
        onDenied(permission);
      } catch {
        // onDenied is a notification channel; its failure must not prevent the
        // security verdict (deny is still returned).
      }
      return shouldAllowPermission(permission);
    },
  };
}
