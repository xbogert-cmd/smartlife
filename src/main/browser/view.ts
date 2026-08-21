import { session, WebContentsView, type BaseWindow, type WebContents } from 'electron';
import type Database from 'better-sqlite3';
import { logError } from '../log';
import { resolveAddressInput } from './address';
import { createDownloadHandler, type DownloadItemLike, type DownloadRequest } from './downloads';
import {
  buildExtractionScript,
  MAX_EXTRACT_CHARS,
  shapeExtraction,
  type PageExtract,
  type RawExtraction,
} from './extract';
import { toViewBounds, type ViewportRect } from './geometry';
import {
  BROWSER_PARTITION,
  createNavigationGuard,
  createPermissionHandlers,
  createWindowOpenHandler,
  EMBEDDED_WEB_PREFERENCES,
} from './handlers';
import { recordVisit } from './history';
import { isAllowedNavigationUrl } from './security';
import { createSuspendCounter } from './suspend';
import { BLANK_URL, createInitialState, tabReducer, type TabAction, type TabState } from './tabs';

/** Chromium's ERR_ABORTED. Fires during perfectly ordinary navigation --
 *  clicking a link while a page is still loading, or a server redirect --
 *  so surfacing it as an error would show a failure screen on healthy pages. */
const ERR_ABORTED = -3;

/** App-defined, not a Chromium code: Chromium never reports a refusal we made
 *  ourselves, but the user still needs to see why the page did not change. */
const ERR_BLOCKED_SCHEME = -10;

export interface FindResult {
  activeMatchOrdinal: number;
  matches: number;
}

export interface BrowserHostOptions {
  window: BaseWindow;
  db: Database.Database;
  downloadsDir: string;
  onStateChange: (state: TabState) => void;
  confirmDownload: (request: DownloadRequest) => Promise<boolean>;
  onFindResult: (result: FindResult) => void;
}

export interface BrowserHost {
  getState(): TabState;
  openTab(url: string): string;
  closeTab(id: string): void;
  activateTab(id: string): void;
  navigate(id: string, input: string): void;
  goBack(id: string): void;
  goForward(id: string): void;
  reload(id: string): void;
  stop(id: string): void;
  find(id: string, text: string): void;
  stopFind(id: string): void;
  setBounds(rect: ViewportRect): void;
  setRouteActive(active: boolean): void;
  suspend(): void;
  resume(): void;
  resetSuspend(): void;
  readPage(id?: string): Promise<PageExtract>;
  destroy(): void;
}

/**
 * Hosts one WebContentsView per tab.
 *
 * Contains no policy of its own: navigation rules, permission decisions,
 * filename sanitization, address resolution, tab state, bounds maths and
 * overlay suspension were all decided and tested in their own pure modules.
 * What is left here is wiring, which is exactly the part that cannot be tested
 * without Electron.
 */
export function createBrowserHost(options: BrowserHostOptions): BrowserHost {
  const { window, db, downloadsDir, onStateChange, confirmDownload, onFindResult } = options;

  const views = new Map<string, WebContentsView>();
  const suspension = createSuspendCounter();
  let routeActive = false;
  let currentBounds: ViewportRect = { x: 0, y: 0, width: 0, height: 0 };
  let idCounter = 0;

  function nextId(): string {
    idCounter += 1;
    return `tab-${idCounter}`;
  }

  let state = createInitialState(nextId());

  function note(context: string, detail: string): void {
    logError(context, new Error(detail));
  }

  // ---- session -----------------------------------------------------------

  const browserSession = session.fromPartition(BROWSER_PARTITION);

  const permissions = createPermissionHandlers((permission) =>
    note('browser:permission-denied', permission)
  );
  browserSession.setPermissionRequestHandler((contents, permission, callback) => {
    permissions.requestHandler(contents, permission, callback);
  });
  browserSession.setPermissionCheckHandler((contents, permission) =>
    permissions.checkHandler(contents, permission)
  );

  const handleDownload = createDownloadHandler({
    downloadsDir,
    confirm: confirmDownload,
    onError: (error) => logError('browser:download', error),
  });
  browserSession.on('will-download', (_event, item) => {
    handleDownload(item as unknown as DownloadItemLike);
  });

  // Deliberately NO certificate-error handler. Electron's default rejects
  // invalid certificates, and the classic mistake is adding a handler that
  // calls callback(true) to silence a development warning. Its absence here is
  // the policy.

  // ---- state -------------------------------------------------------------

  function dispatch(action: TabAction): void {
    const next = tabReducer(state, action);
    if (next === state) return;
    state = next;
    syncViews();
    onStateChange(state);
  }

  function wire(id: string, contents: WebContents): void {
    const guard = createNavigationGuard((url) => {
      note('browser:navigation-blocked', url);
      // Surfaced, not just logged. A refused navigation that does nothing
      // visible reads as a broken link rather than a deliberate refusal.
      dispatch({
        type: 'load-failed',
        id,
        code: ERR_BLOCKED_SCHEME,
        description: `Blocked a link to ${url} — this browser only opens http and https pages.`,
      });
    });
    contents.on('will-navigate', (event, url) => guard(event, url));
    contents.on('will-redirect', (event, url) => guard(event, url));

    contents.setWindowOpenHandler(
      createWindowOpenHandler(
        (url) => {
          openTab(url);
        },
        (url) => note('browser:popup-blocked', url)
      )
    );

    contents.on('did-start-loading', () => dispatch({ type: 'navigate-start', id }));
    contents.on('did-stop-loading', () => dispatch({ type: 'load-end', id }));
    contents.on('page-title-updated', (_event, title) => dispatch({ type: 'title', id, title }));

    const committed = (url: string): void => {
      dispatch({
        type: 'navigate-committed',
        id,
        url,
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
      });
      if (url !== BLANK_URL) {
        try {
          recordVisit(db, url, contents.getTitle() || null);
        } catch (error) {
          logError('browser:recordVisit', error);
        }
      }
    };
    contents.on('did-navigate', (_event, url) => committed(url));
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) committed(url);
    });

    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame) return;
      if (code === ERR_ABORTED) return;
      dispatch({ type: 'load-failed', id, code, description });
    });

    contents.on('render-process-gone', (_event, details) => {
      dispatch({ type: 'load-failed', id, code: -1, description: `This tab crashed (${details.reason})` });
    });

    contents.on('unresponsive', () => {
      dispatch({ type: 'load-failed', id, code: -2, description: 'This page stopped responding' });
    });

    // Electron reports find results asynchronously; the FindBar's "3 of 17"
    // counter has no other source.
    contents.on('found-in-page', (_event, result) => {
      onFindResult({ activeMatchOrdinal: result.activeMatchOrdinal, matches: result.matches });
    });
  }

  /**
   * The single choke point for every app-initiated load.
   *
   * This guard is NOT redundant with the will-navigate handler. Electron's own
   * documentation is explicit: will-navigate "will not emit when the navigation
   * is started programmatically with APIs like webContents.loadURL". So the
   * address bar, the renderer's openTab IPC, and a restored tab all reach
   * loadURL without ever passing the navigation guard. Without this check,
   * typing file:///etc/passwd into the address bar would simply load it.
   */
  function loadUrlSafely(contents: WebContents, id: string, url: string): void {
    if (!isAllowedNavigationUrl(url)) {
      note('browser:navigation-blocked', url);
      dispatch({
        type: 'load-failed',
        id,
        code: ERR_BLOCKED_SCHEME,
        description: `Blocked a link to ${url} — this browser only opens http and https pages.`,
      });
      return;
    }
    void contents.loadURL(url).catch((error) => logError('browser:loadURL', error));
  }

  function createViewFor(id: string, url: string): WebContentsView {
    const view = new WebContentsView({ webPreferences: { ...EMBEDDED_WEB_PREFERENCES } });
    views.set(id, view);
    window.contentView.addChildView(view);
    wire(id, view.webContents);
    loadUrlSafely(view.webContents, id, url);
    return view;
  }

  function destroyView(id: string): void {
    const view = views.get(id);
    if (!view) return;
    views.delete(id);
    window.contentView.removeChildView(view);
    try {
      view.webContents.close();
    } catch (error) {
      logError('browser:closeView', error);
    }
  }

  /** Reconciles the real views against the reducer's state. */
  function syncViews(): void {
    for (const tab of state.tabs) {
      if (!views.has(tab.id)) createViewFor(tab.id, tab.url);
    }
    for (const id of [...views.keys()]) {
      if (!state.tabs.some((tab) => tab.id === id)) destroyView(id);
    }

    const visible = routeActive && !suspension.isSuspended();
    for (const [id, view] of views) {
      const isActive = id === state.activeTabId;
      view.setVisible(isActive && visible);
      if (isActive) view.setBounds(toViewBounds(currentBounds));
    }
  }

  function activeContents(id?: string): WebContents | null {
    return views.get(id ?? state.activeTabId)?.webContents ?? null;
  }

  function openTab(url: string): string {
    const id = nextId();
    dispatch({ type: 'open', id, url });
    return id;
  }

  syncViews();

  return {
    getState: () => state,
    openTab,
    closeTab: (id) => dispatch({ type: 'close', id, blankId: nextId() }),
    activateTab: (id) => dispatch({ type: 'activate', id }),

    navigate(id, input) {
      const contents = activeContents(id);
      if (!contents) return;
      loadUrlSafely(contents, id, resolveAddressInput(input));
    },

    goBack: (id) => activeContents(id)?.navigationHistory.goBack(),
    goForward: (id) => activeContents(id)?.navigationHistory.goForward(),
    reload: (id) => activeContents(id)?.reload(),
    stop: (id) => activeContents(id)?.stop(),
    find: (id, text) => {
      if (text.length > 0) activeContents(id)?.findInPage(text);
    },
    stopFind: (id) => activeContents(id)?.stopFindInPage('clearSelection'),

    setBounds(rect) {
      currentBounds = rect;
      syncViews();
    },
    setRouteActive(active) {
      routeActive = active;
      syncViews();
    },
    suspend() {
      suspension.acquire();
      syncViews();
    },
    resume() {
      suspension.release();
      syncViews();
    },
    resetSuspend() {
      suspension.reset();
      syncViews();
    },

    async readPage(id) {
      const targetId = id ?? state.activeTabId;
      const contents = views.get(targetId)?.webContents;
      const fallbackUrl = state.tabs.find((tab) => tab.id === targetId)?.url ?? '';
      if (!contents) return shapeExtraction(null, fallbackUrl);
      try {
        const raw = (await contents.executeJavaScript(
          buildExtractionScript(MAX_EXTRACT_CHARS),
          true
        )) as RawExtraction | null;
        return shapeExtraction(raw, contents.getURL());
      } catch (error) {
        logError('browser:readPage', error);
        return shapeExtraction(null, fallbackUrl);
      }
    },

    destroy() {
      for (const id of [...views.keys()]) destroyView(id);
    },
  };
}
