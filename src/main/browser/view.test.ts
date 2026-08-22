import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

type Listener = (...args: unknown[]) => void;

class FakeWebContents {
  listeners = new Map<string, Listener[]>();
  loadedUrls: string[] = [];
  windowOpenHandler: ((details: { url: string }) => unknown) | null = null;
  executeResult: unknown = null;
  executeError: Error | null = null;
  closed = false;
  title = 'Fake Page';
  navigationHistory = { canGoBack: () => true, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() };
  reload = vi.fn();
  stop = vi.fn();
  findInPage = vi.fn();
  stopFindInPage = vi.fn();

  on(event: string, cb: Listener): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(cb);
    this.listeners.set(event, existing);
    return this;
  }
  setWindowOpenHandler(fn: (details: { url: string }) => unknown): void {
    this.windowOpenHandler = fn;
  }
  loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
    return Promise.resolve();
  }
  getURL(): string {
    return this.loadedUrls[this.loadedUrls.length - 1] ?? 'about:blank';
  }
  getTitle(): string {
    return this.title;
  }
  executeJavaScript(): Promise<unknown> {
    if (this.executeError) return Promise.reject(this.executeError);
    return Promise.resolve(this.executeResult);
  }
  close(): void {
    this.closed = true;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
}

const constructedOptions: unknown[] = [];

const fakeSession = {
  setPermissionRequestHandler: vi.fn(),
  setPermissionCheckHandler: vi.fn(),
  on: vi.fn(),
  clearStorageData: vi.fn(async () => {}),
  clearCache: vi.fn(async () => {}),
};

vi.mock('electron', () => ({
  WebContentsView: class {
    webContents: FakeWebContents;
    bounds: unknown = null;
    visible = false;
    constructor(options: unknown) {
      constructedOptions.push(options);
      this.webContents = new FakeWebContents();
    }
    setBounds(bounds: unknown): void {
      this.bounds = bounds;
    }
    setVisible(visible: boolean): void {
      this.visible = visible;
    }
  },
  session: { fromPartition: () => fakeSession },
  app: { getPath: () => '/tmp/logs' },
}));

const { createBrowserHost } = await import('./view');

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    create table browser_history (
      url text not null, title text,
      visited_at text not null default (datetime('now'))
    );
  `);
  return db;
}

interface FakeView {
  webContents: FakeWebContents;
  bounds: unknown;
  visible: boolean;
}

function makeFakeWindow(added: FakeView[], removed: FakeView[]) {
  return {
    contentView: {
      addChildView: (view: FakeView) => added.push(view),
      removeChildView: (view: FakeView) => removed.push(view),
    },
  };
}

function makeHost(options: { getWindow?: () => unknown } = {}) {
  const added: FakeView[] = [];
  const removed: FakeView[] = [];
  const window = makeFakeWindow(added, removed);
  const db = makeDb();
  const onStateChange = vi.fn();
  const onFindResult = vi.fn();
  const getWindow = options.getWindow ?? (() => window);
  const host = createBrowserHost({
    getWindow: getWindow as never,
    db,
    downloadsDir: '/tmp/Downloads',
    onStateChange,
    confirmDownload: async () => false,
    onFindResult,
  });
  return { host, added, removed, db, onStateChange, onFindResult, window };
}

beforeEach(() => {
  constructedOptions.length = 0;
  vi.clearAllMocks();
});

describe('view construction', () => {
  it('never passes a preload script to a WebContentsView', () => {
    makeHost();
    expect(constructedOptions.length).toBeGreaterThan(0);
    for (const options of constructedOptions) {
      const prefs = (options as { webPreferences: Record<string, unknown> }).webPreferences;
      expect('preload' in prefs).toBe(false);
    }
  });

  it('sandboxes and isolates every view, on the browser partition', () => {
    makeHost();
    const prefs = (constructedOptions[0] as { webPreferences: Record<string, unknown> }).webPreferences;
    expect(prefs.sandbox).toBe(true);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.partition).toBe('persist:browser');
  });

  it('starts with a single blank tab and adds its view to the window', () => {
    const { host, added } = makeHost();
    expect(host.getState().tabs).toHaveLength(1);
    expect(added).toHaveLength(1);
  });
});

describe('tabs', () => {
  it('opens a tab, creates its view, and loads the url', () => {
    const { host, added } = makeHost();
    host.openTab('https://uncw.edu/');
    expect(host.getState().tabs).toHaveLength(2);
    expect(added).toHaveLength(2);
    expect(added[1].webContents.loadedUrls).toContain('https://uncw.edu/');
  });

  it('resolves address-bar input rather than loading it verbatim', () => {
    const { host, added } = makeHost();
    host.navigate(host.getState().activeTabId, 'uncw.edu');
    expect(added[0].webContents.loadedUrls).toContain('https://uncw.edu');
  });

  it('searches for non-url input', () => {
    const { host, added } = makeHost();
    host.navigate(host.getState().activeTabId, 'how to cite mla');
    expect(added[0].webContents.loadedUrls.at(-1)).toContain('duckduckgo.com');
  });

  // will-navigate does not fire for loadURL (Electron's docs say so
  // explicitly), so the address bar would otherwise bypass the allowlist
  // entirely. Both inputs below carry an explicit "scheme://" that
  // resolveAddressInput (Task 3, already tested) passes through unchanged,
  // so they reach loadUrlSafely verbatim and must be blocked there.
  it.each(['file:///etc/passwd', 'javascript://alert(1)'])(
    'refuses to load %s typed into the address bar',
    (input) => {
      const { host, added } = makeHost();
      const before = added[0].webContents.loadedUrls.length;
      host.navigate(host.getState().activeTabId, input);
      expect(added[0].webContents.loadedUrls).toHaveLength(before);
      expect(host.getState().tabs[0].error?.description).toContain('only opens http and https');
    }
  );

  // data: URIs conventionally have no "//" after the scheme (data:text/html,...,
  // not data://text/html,...), so resolveAddressInput's scheme pattern -- which
  // requires "://" -- does not recognise this as already-schemed input, and its
  // own (already-tested) fallback treats it as search text instead. The security
  // invariant that matters here still holds: the raw data: URI is never handed to
  // loadURL, verbatim or otherwise.
  it('sends a data: URI typed into the address bar to a search instead of loading it verbatim', () => {
    const { host, added } = makeHost();
    host.navigate(host.getState().activeTabId, 'data:text/html,<h1>x</h1>');
    const loaded = added[0].webContents.loadedUrls.at(-1);
    expect(loaded).toContain('duckduckgo.com');
    expect(loaded).not.toContain('data:text/html');
  });

  it('refuses a disallowed url passed to openTab by the app', () => {
    const { host, added } = makeHost();
    host.openTab('file:///etc/passwd');
    const newView = added[added.length - 1];
    expect(newView.webContents.loadedUrls).toHaveLength(0);
  });

  it('destroys the view when a tab closes', () => {
    const { host, removed } = makeHost();
    const opened = host.openTab('https://uncw.edu/');
    host.closeTab(opened);
    expect(removed).toHaveLength(1);
    expect(host.getState().tabs).toHaveLength(1);
  });

  it('replaces the last tab with a fresh blank one, view included', () => {
    const { host, added } = makeHost();
    const only = host.getState().activeTabId;
    host.closeTab(only);
    expect(host.getState().tabs).toHaveLength(1);
    expect(host.getState().tabs[0].id).not.toBe(only);
    expect(added).toHaveLength(2);
  });
});

describe('visibility', () => {
  it('stays hidden until the browser route is active', () => {
    const { host, added } = makeHost();
    expect(added[0].visible).toBe(false);
    host.setRouteActive(true);
    expect(added[0].visible).toBe(true);
  });

  it('hides while an overlay is open and restores after', () => {
    const { host, added } = makeHost();
    host.setRouteActive(true);
    host.suspend();
    expect(added[0].visible).toBe(false);
    host.resume();
    expect(added[0].visible).toBe(true);
  });

  it('stays hidden after two suspends and one resume', () => {
    const { host, added } = makeHost();
    host.setRouteActive(true);
    host.suspend();
    host.suspend();
    host.resume();
    expect(added[0].visible).toBe(false);
    host.resume();
    expect(added[0].visible).toBe(true);
  });

  it('hides everything when the route goes away, even if not suspended', () => {
    const { host, added } = makeHost();
    host.setRouteActive(true);
    host.setRouteActive(false);
    expect(added[0].visible).toBe(false);
  });

  it('shows only the active tab', () => {
    const { host, added } = makeHost();
    host.setRouteActive(true);
    host.openTab('https://uncw.edu/');
    expect(added[0].visible).toBe(false);
    expect(added[1].visible).toBe(true);
  });

  it('hides a tab whose main frame failed to load, even though the route is active and nothing is suspended', () => {
    const { host, added } = makeHost();
    host.setRouteActive(true);
    expect(added[0].visible).toBe(true);
    added[0].webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://nope.test/', true);
    expect(host.getState().tabs[0].error).not.toBeNull();
    expect(added[0].visible).toBe(false);
  });

  it('shows the view again once a reload clears the error', () => {
    const { host, added } = makeHost();
    host.setRouteActive(true);
    added[0].webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://nope.test/', true);
    expect(added[0].visible).toBe(false);

    host.reload(host.getState().activeTabId);
    added[0].webContents.emit('did-start-loading');
    expect(host.getState().tabs[0].error).toBeNull();
    expect(added[0].visible).toBe(true);
  });

  it('applies rounded, clamped bounds to the active view', () => {
    const { host, added } = makeHost();
    host.setRouteActive(true);
    host.setBounds({ x: 12.4, y: -3, width: 640.5, height: 480.2 });
    expect(added[0].bounds).toEqual({ x: 12, y: 0, width: 641, height: 480 });
  });
});

describe('webContents events', () => {
  it('records history on navigation', () => {
    const { host, added, db } = makeHost();
    const contents = added[0].webContents;
    contents.emit('did-navigate', {}, 'https://uncw.edu/registrar');
    const rows = db.prepare('select url from browser_history').all() as { url: string }[];
    expect(rows.map((row) => row.url)).toEqual(['https://uncw.edu/registrar']);
    expect(host.getState().tabs[0].url).toBe('https://uncw.edu/registrar');
  });

  it('does not record about:blank', () => {
    const { added, db } = makeHost();
    added[0].webContents.emit('did-navigate', {}, 'about:blank');
    const count = db.prepare('select count(*) as n from browser_history').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('surfaces a real load failure', () => {
    const { host, added } = makeHost();
    added[0].webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://nope.test/', true);
    expect(host.getState().tabs[0].error).toEqual({ code: -105, description: 'ERR_NAME_NOT_RESOLVED' });
  });

  it('ignores ERR_ABORTED, which fires during ordinary navigation', () => {
    const { host, added } = makeHost();
    added[0].webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://uncw.edu/', true);
    expect(host.getState().tabs[0].error).toBeNull();
  });

  it('ignores subframe load failures', () => {
    const { host, added } = makeHost();
    added[0].webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://ads.test/', false);
    expect(host.getState().tabs[0].error).toBeNull();
  });

  it('reports a crashed tab rather than letting it look blank', () => {
    const { host, added } = makeHost();
    added[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(host.getState().tabs[0].error?.description).toContain('crashed');
  });

  it('opens popups as tabs and always denies the window', () => {
    const { host, added } = makeHost();
    const result = added[0].webContents.windowOpenHandler?.({ url: 'https://uncw.edu/popup' });
    expect(result).toEqual({ action: 'deny' });
    expect(host.getState().tabs).toHaveLength(2);
  });

  it('denies a popup to a refused scheme without opening a tab', () => {
    const { host, added } = makeHost();
    const result = added[0].webContents.windowOpenHandler?.({ url: 'file:///etc/passwd' });
    expect(result).toEqual({ action: 'deny' });
    expect(host.getState().tabs).toHaveLength(1);
  });

  it('blocks navigation to a refused scheme', () => {
    const { added } = makeHost();
    const event = { preventDefault: vi.fn() };
    added[0].webContents.emit('will-navigate', event, 'file:///etc/passwd');
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('tells the user why a navigation was blocked instead of doing nothing visible', () => {
    const { host, added } = makeHost();
    added[0].webContents.emit('will-navigate', { preventDefault: vi.fn() }, 'file:///etc/passwd');
    expect(host.getState().tabs[0].error?.description).toContain('only opens http and https');
  });

  it('allows ordinary https navigation', () => {
    const { added } = makeHost();
    const event = { preventDefault: vi.fn() };
    added[0].webContents.emit('will-navigate', event, 'https://uncw.edu/');
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('forwards find-in-page results so the counter has a source', () => {
    const { added, onFindResult } = makeHost();
    added[0].webContents.emit('found-in-page', {}, { activeMatchOrdinal: 3, matches: 17 });
    expect(onFindResult).toHaveBeenCalledWith({ activeMatchOrdinal: 3, matches: 17 });
  });
});

describe('session configuration', () => {
  it('installs both permission handlers', () => {
    makeHost();
    expect(fakeSession.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(fakeSession.setPermissionCheckHandler).toHaveBeenCalledOnce();
  });

  it('listens for downloads', () => {
    makeHost();
    expect(fakeSession.on).toHaveBeenCalledWith('will-download', expect.any(Function));
  });
});

describe('readPage', () => {
  it('shapes a successful extraction', async () => {
    const { host, added } = makeHost();
    added[0].webContents.executeResult = {
      title: 'Registrar',
      text: 'Registration opens Monday.',
      truncated: false,
      isPdf: false,
      hasBody: true,
    };
    const result = await host.readPage();
    expect(result.status).toBe('ok');
    expect(result.text).toBe('Registration opens Monday.');
  });

  it('reports not-loaded when the script throws', async () => {
    const { host, added } = makeHost();
    added[0].webContents.executeError = new Error('no frame');
    const result = await host.readPage();
    expect(result.status).toBe('not-loaded');
  });

  it('reports not-loaded for an unknown tab id', async () => {
    const { host } = makeHost();
    const result = await host.readPage('does-not-exist');
    expect(result.status).toBe('not-loaded');
  });
});

describe('window lifecycle', () => {
  // On macOS, closing the main window (red button) does not quit the app,
  // and re-registration never happens -- app.on('activate') recreates the
  // window but handlersRegistered is already true. The host must survive
  // getWindow() returning null again after construction, not just at
  // construction time, or every later Electron call against it throws.
  it('does not throw when the window becomes null again after construction', () => {
    const added: FakeView[] = [];
    const removed: FakeView[] = [];
    let windowRef: ReturnType<typeof makeFakeWindow> | null = makeFakeWindow(added, removed);
    const { host } = makeHost({ getWindow: () => windowRef });

    windowRef = null;

    expect(() => host.openTab('https://uncw.edu/')).not.toThrow();
    // The new tab's view could not be attached to any window, so nothing
    // new was added -- but the call must degrade, not crash.
    expect(added).toHaveLength(1);

    const openedId = host.getState().tabs[1]?.id ?? host.getState().tabs[0].id;
    expect(() => host.closeTab(openedId)).not.toThrow();
  });

  it('resumes attaching views normally once the window comes back', () => {
    const added: FakeView[] = [];
    const removed: FakeView[] = [];
    let windowRef: ReturnType<typeof makeFakeWindow> | null = null;
    const { host } = makeHost({ getWindow: () => windowRef });

    // Constructed with no window: the initial blank tab's view exists but
    // could not be attached.
    expect(added).toHaveLength(0);

    windowRef = makeFakeWindow(added, removed);
    host.openTab('https://uncw.edu/');
    expect(added).toHaveLength(1);
  });
});

describe('destroyView resilience', () => {
  it('still closes webContents even when removeChildView throws', () => {
    const added: FakeView[] = [];
    const window = {
      contentView: {
        addChildView: (view: FakeView) => added.push(view),
        removeChildView: () => {
          throw new Error('window already destroyed');
        },
      },
    };
    const { host } = makeHost({ getWindow: () => window });

    const opened = host.openTab('https://uncw.edu/');
    const view = added[added.length - 1];

    expect(() => host.closeTab(opened)).not.toThrow();
    expect(view.webContents.closed).toBe(true);
  });
});
