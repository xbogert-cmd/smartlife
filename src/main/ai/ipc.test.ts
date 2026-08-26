import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const routerMocks = {
  getProvider: vi.fn(),
  resetProviderCache: vi.fn(),
  retryProviderEntry: vi.fn(),
};

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));
vi.mock('./router', () => routerMocks);

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null);');
  db.exec('create table ai_provider_ranking (rank integer primary key, provider text not null, model text not null);');
  db.exec(
    `create table ai_conversations (id text primary key, title text, created_at text not null default (datetime('now')), updated_at text not null default (datetime('now')));`
  );
  db.exec(
    `create table ai_messages (id text primary key, conversation_id text not null references ai_conversations(id) on delete cascade, role text not null, content text not null, created_at text not null default (datetime('now')));`
  );
  return db;
}

async function setup() {
  handlers.clear();
  vi.clearAllMocks();
  const { registerAiIpcHandlers } = await import('./ipc');
  const db = makeDb();
  registerAiIpcHandlers(db, () => null);
  return { call: (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as never, ...args) };
}

describe('AI provider IPC handlers', () => {
  it('reports the static catalog', async () => {
    const { call } = await setup();
    const catalog = await call('ai:get-catalog');
    expect(Array.isArray(catalog)).toBe(true);
    expect((catalog as unknown[]).length).toBeGreaterThan(0);
  });

  it('round-trips a Gemini key and resets the provider cache on both save and clear', async () => {
    const { call } = await setup();
    expect(await call('ai:get-gemini-key-status')).toBe(false);
    await call('ai:set-gemini-key', 'gm-test-key');
    expect(await call('ai:get-gemini-key-status')).toBe(true);
    expect(routerMocks.resetProviderCache).toHaveBeenCalledTimes(1);
    await call('ai:clear-gemini-key');
    expect(await call('ai:get-gemini-key-status')).toBe(false);
    expect(routerMocks.resetProviderCache).toHaveBeenCalledTimes(2);
  });

  it('round-trips the Ollama endpoint and resets the provider cache on save', async () => {
    const { call } = await setup();
    expect(await call('ai:get-ollama-endpoint')).toBe('http://localhost:11434');
    await call('ai:set-ollama-endpoint', 'http://192.168.1.50:11434');
    expect(await call('ai:get-ollama-endpoint')).toBe('http://192.168.1.50:11434');
    expect(routerMocks.resetProviderCache).toHaveBeenCalledTimes(1);
  });

  it('round-trips the ranked list and resets the provider cache on save', async () => {
    const { call } = await setup();
    expect(await call('ai:get-ranking')).toEqual([]);
    await call('ai:set-ranking', [{ providerId: 'anthropic', model: 'claude-sonnet-5' }]);
    expect(await call('ai:get-ranking')).toEqual([{ providerId: 'anthropic', model: 'claude-sonnet-5' }]);
    expect(routerMocks.resetProviderCache).toHaveBeenCalledTimes(1);
  });

  it('round-trips the pinned entry and resets the provider cache on both set and clear', async () => {
    const { call } = await setup();
    expect(await call('ai:get-pinned-entry')).toBeNull();
    await call('ai:set-pinned-entry', { providerId: 'gemini', model: 'gemini-2.5-pro' });
    expect(await call('ai:get-pinned-entry')).toEqual({ providerId: 'gemini', model: 'gemini-2.5-pro' });
    expect(routerMocks.resetProviderCache).toHaveBeenCalledTimes(1);
    await call('ai:clear-pinned-entry');
    expect(await call('ai:get-pinned-entry')).toBeNull();
    expect(routerMocks.resetProviderCache).toHaveBeenCalledTimes(2);
  });

  it('delegates a retry request to router.retryProviderEntry with the given provider and model', async () => {
    const { call } = await setup();
    await call('ai:retry-provider-entry', 'anthropic', 'claude-sonnet-5');
    expect(routerMocks.retryProviderEntry).toHaveBeenCalledWith(expect.anything(), 'anthropic', 'claude-sonnet-5');
  });
});
