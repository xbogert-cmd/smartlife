import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const fakeSession = {
  clearStorageData: vi.fn(async () => {}),
  clearCache: vi.fn(async () => {}),
};

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  session: { fromPartition: () => fakeSession },
  app: { getPath: (name: string) => `/tmp/${name}` },
}));

const hostStub = {
  getState: vi.fn(() => ({ tabs: [], activeTabId: 'tab-1' })),
  openTab: vi.fn(() => 'tab-2'),
  closeTab: vi.fn(),
  activateTab: vi.fn(),
  navigate: vi.fn(),
  goBack: vi.fn(),
  goForward: vi.fn(),
  reload: vi.fn(),
  stop: vi.fn(),
  find: vi.fn(),
  stopFind: vi.fn(),
  setBounds: vi.fn(),
  setRouteActive: vi.fn(),
  suspend: vi.fn(),
  resume: vi.fn(),
  resetSuspend: vi.fn(),
  readPage: vi.fn(async () => ({ url: '', title: '', text: '', truncated: false, status: 'ok' as const })),
  destroy: vi.fn(),
};

let capturedOptions: Record<string, unknown> = {};
vi.mock('./view', () => ({
  createBrowserHost: (options: Record<string, unknown>) => {
    capturedOptions = options;
    return hostStub;
  },
}));

const { registerBrowserIpcHandlers } = await import('./ipc');

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

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({}, ...args);
}

let sent: { channel: string; payload: unknown }[] = [];
function makeWindow() {
  return { webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } };
}

beforeEach(() => {
  handlers.clear();
  sent = [];
  vi.clearAllMocks();
});

describe('registerBrowserIpcHandlers', () => {
  it('registers every channel the preload bridge calls', () => {
    registerBrowserIpcHandlers(makeDb(), () => makeWindow() as never);
    for (const channel of [
      'browser:get-state',
      'browser:open-tab',
      'browser:close-tab',
      'browser:activate-tab',
      'browser:navigate',
      'browser:go-back',
      'browser:go-forward',
      'browser:reload',
      'browser:stop',
      'browser:find',
      'browser:stop-find',
      'browser:set-bounds',
      'browser:set-route-active',
      'browser:suspend',
      'browser:resume',
      'browser:find-history',
      'browser:clear-data',
      'browser:download-response',
    ]) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  it('delegates tab actions to the host', () => {
    registerBrowserIpcHandlers(makeDb(), () => makeWindow() as never);
    invoke('browser:open-tab', 'https://uncw.edu/');
    invoke('browser:close-tab', 'tab-1');
    invoke('browser:navigate', 'tab-1', 'uncw.edu');
    expect(hostStub.openTab).toHaveBeenCalledWith('https://uncw.edu/');
    expect(hostStub.closeTab).toHaveBeenCalledWith('tab-1');
    expect(hostStub.navigate).toHaveBeenCalledWith('tab-1', 'uncw.edu');
  });

  it('passes bounds straight through to the host', () => {
    registerBrowserIpcHandlers(makeDb(), () => makeWindow() as never);
    invoke('browser:set-bounds', { x: 1, y: 2, width: 3, height: 4 });
    expect(hostStub.setBounds).toHaveBeenCalledWith({ x: 1, y: 2, width: 3, height: 4 });
  });

  it('broadcasts state changes to the renderer', () => {
    registerBrowserIpcHandlers(makeDb(), () => makeWindow() as never);
    const onStateChange = capturedOptions.onStateChange as (state: unknown) => void;
    onStateChange({ tabs: [], activeTabId: 'tab-1' });
    expect(sent).toContainEqual({
      channel: 'browser:state-changed',
      payload: { tabs: [], activeTabId: 'tab-1' },
    });
  });

  it('broadcasts find results to the renderer', () => {
    registerBrowserIpcHandlers(makeDb(), () => makeWindow() as never);
    const onFindResult = capturedOptions.onFindResult as (result: unknown) => void;
    onFindResult({ activeMatchOrdinal: 2, matches: 9 });
    expect(sent).toContainEqual({
      channel: 'browser:find-result',
      payload: { activeMatchOrdinal: 2, matches: 9 },
    });
  });

  it('prunes history older than 90 days at registration', () => {
    const db = makeDb();
    db.prepare('insert into browser_history (url, title, visited_at) values (?, ?, ?)').run(
      'https://ancient.test/',
      'Ancient',
      '2020-01-01 00:00:00'
    );
    db.prepare('insert into browser_history (url, title, visited_at) values (?, ?, ?)').run(
      'https://fresh.test/',
      'Fresh',
      new Date().toISOString().replace('T', ' ').slice(0, 19)
    );

    registerBrowserIpcHandlers(db, () => makeWindow() as never);

    const rows = db.prepare('select url from browser_history').all() as { url: string }[];
    expect(rows.map((row) => row.url)).toEqual(['https://fresh.test/']);
  });

  it('returns history suggestions', () => {
    const db = makeDb();
    db.prepare('insert into browser_history (url, title, visited_at) values (?, ?, ?)').run(
      'https://uncw.edu/registrar',
      'Registrar',
      new Date().toISOString().replace('T', ' ').slice(0, 19)
    );
    registerBrowserIpcHandlers(db, () => makeWindow() as never);
    const results = invoke('browser:find-history', 'uncw') as { url: string }[];
    expect(results.map((row) => row.url)).toEqual(['https://uncw.edu/registrar']);
  });

  it('clears history, storage and cache together', async () => {
    const db = makeDb();
    db.prepare('insert into browser_history (url, title) values (?, ?)').run('https://x.test/', 'X');
    registerBrowserIpcHandlers(db, () => makeWindow() as never);

    await invoke('browser:clear-data');

    const count = db.prepare('select count(*) as n from browser_history').get() as { n: number };
    expect(count.n).toBe(0);
    expect(fakeSession.clearStorageData).toHaveBeenCalledOnce();
    expect(fakeSession.clearCache).toHaveBeenCalledOnce();
  });
});

describe('download confirmation round-trip', () => {
  it('asks the renderer and resolves with the answer', async () => {
    registerBrowserIpcHandlers(makeDb(), () => makeWindow() as never);
    const confirmDownload = capturedOptions.confirmDownload as (
      request: unknown
    ) => Promise<boolean>;

    const pending = confirmDownload({
      filename: 'syllabus.pdf',
      sizeBytes: 1024,
      sourceUrl: 'https://uncw.edu/syllabus.pdf',
    });

    const request = sent.find((message) => message.channel === 'browser:download-request');
    expect(request).toBeDefined();
    const { id } = request!.payload as { id: string };
    expect(id).toBeTruthy();

    invoke('browser:download-response', id, true);
    await expect(pending).resolves.toBe(true);
  });

  it('resolves false when the user declines', async () => {
    registerBrowserIpcHandlers(makeDb(), () => makeWindow() as never);
    const confirmDownload = capturedOptions.confirmDownload as (
      request: unknown
    ) => Promise<boolean>;

    const pending = confirmDownload({ filename: 'a.pdf', sizeBytes: 1, sourceUrl: 'https://x.test/a.pdf' });
    const { id } = sent.find((m) => m.channel === 'browser:download-request')!.payload as { id: string };
    invoke('browser:download-response', id, false);
    await expect(pending).resolves.toBe(false);
  });

  it('declines a download when the window has closed since registration', async () => {
    let windowRef: ReturnType<typeof makeWindow> | null = makeWindow();
    const getWindow = () => windowRef;
    registerBrowserIpcHandlers(makeDb(), getWindow as never);
    const confirmDownload = capturedOptions.confirmDownload as (
      request: unknown
    ) => Promise<boolean>;

    // Window exists at registration time, but close it before sending a download
    windowRef = null;
    sent = [];

    const result = await confirmDownload({ filename: 'a.pdf', sizeBytes: 1, sourceUrl: 'https://x.test/a.pdf' });

    // A download that cannot be confirmed must never default to "yes"
    expect(result).toBe(false);
    // No download request should have been sent
    expect(sent.find((m) => m.channel === 'browser:download-request')).toBeUndefined();
  });

  it('throws when registering with no window', () => {
    expect(() => registerBrowserIpcHandlers(makeDb(), () => null)).toThrow(
      'registerBrowserIpcHandlers must be called after the main window exists.'
    );
  });

  it('ignores a response for an unknown id', () => {
    registerBrowserIpcHandlers(makeDb(), () => makeWindow() as never);
    expect(() => invoke('browser:download-response', 'nope', true)).not.toThrow();
  });
});
