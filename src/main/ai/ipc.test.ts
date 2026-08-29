import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const routerMocks = {
  getProvider: vi.fn(),
  resetProviderCache: vi.fn(),
  retryProviderEntry: vi.fn(),
  hasUsableProvider: vi.fn(),
  getActiveCapabilities: vi.fn(),
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
const pickAttachmentMock = vi.fn();
vi.mock('./attachments/pickAttachment', () => ({ pickAttachment: pickAttachmentMock }));
vi.mock('./conversation', async () => {
  const actual = await vi.importActual<typeof import('./conversation')>('./conversation');
  return { ...actual, getUsageSummary: vi.fn() };
});
vi.mock('./voice/transcribe', () => ({ transcribeAudio: vi.fn() }));

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null);');
  db.exec('create table ai_provider_ranking (rank integer primary key, provider text not null, model text not null);');
  db.exec(
    `create table ai_conversations (id text primary key, title text, created_at text not null default (datetime('now')), updated_at text not null default (datetime('now')));`
  );
  db.exec(
    `create table ai_messages (id text primary key, conversation_id text not null references ai_conversations(id) on delete cascade, role text not null, content text not null, provider text, model text, input_tokens integer, output_tokens integer, created_at text not null default (datetime('now')));`
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

  it('round-trips the Anthropic key and resets the provider cache on save', async () => {
    const { call } = await setup();
    expect(await call('ai:get-api-key-status')).toBe(false);
    await call('ai:set-api-key', 'sk-ant-test');
    expect(await call('ai:get-api-key-status')).toBe(true);
    expect(routerMocks.resetProviderCache).toHaveBeenCalledTimes(1);
  });

  it('seeds the ranked list with the saved Anthropic key when the list was empty, so chat works without a separate visit to the list builder', async () => {
    const { call } = await setup();
    expect(await call('ai:get-ranking')).toEqual([]);
    await call('ai:set-api-key', 'sk-ant-test');
    expect(await call('ai:get-ranking')).toEqual([{ providerId: 'anthropic', model: 'claude-haiku-4-5-20251001' }]);
  });

  it('does not touch an already-populated ranked list when a key is saved', async () => {
    const { call } = await setup();
    await call('ai:set-ranking', [{ providerId: 'gemini', model: 'gemini-2.5-pro' }]);
    await call('ai:set-api-key', 'sk-ant-test');
    expect(await call('ai:get-ranking')).toEqual([{ providerId: 'gemini', model: 'gemini-2.5-pro' }]);
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

  it('seeds the ranked list with the saved Gemini key when the list was empty', async () => {
    const { call } = await setup();
    expect(await call('ai:get-ranking')).toEqual([]);
    await call('ai:set-gemini-key', 'gm-test-key');
    expect(await call('ai:get-ranking')).toEqual([{ providerId: 'gemini', model: 'gemini-2.5-flash' }]);
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

  it('delegates ai:has-usable-provider to router.hasUsableProvider and returns its result', async () => {
    const { call } = await setup();
    routerMocks.hasUsableProvider.mockReturnValue(true);
    expect(await call('ai:has-usable-provider')).toBe(true);
    expect(routerMocks.hasUsableProvider).toHaveBeenCalledWith(expect.anything());
  });
});

describe('ai:pick-attachment', () => {
  it('calls pickAttachment with the current window and the active vision capability', async () => {
    const { call } = await setup();
    routerMocks.getActiveCapabilities.mockReturnValue({ supportsVision: true, supportsWebSearch: false });
    pickAttachmentMock.mockResolvedValue({ ok: true, id: 'attach-1', name: 'notes.txt', kind: 'text' });

    const result = await call('ai:pick-attachment');

    // setup() registers handlers via registerAiIpcHandlers(db, () => null),
    // so the window argument pickAttachment receives is null.
    expect(pickAttachmentMock).toHaveBeenCalledWith(null, true);
    expect(result).toEqual({ ok: true, id: 'attach-1', name: 'notes.txt', kind: 'text' });
  });
});

describe('conversation lifecycle IPC handlers', () => {
  it('creates a conversation and lists it newest-first', async () => {
    const { call } = await setup();
    const id = await call('ai:create-conversation');
    expect(typeof id).toBe('string');
    const list = (await call('ai:list-conversations')) as Array<{ id: string; title: string | null }>;
    expect(list).toEqual([{ id, title: null, updatedAt: expect.any(String) }]);
  });

  it('renames a conversation', async () => {
    const { call } = await setup();
    const id = await call('ai:create-conversation');
    await call('ai:rename-conversation', id, 'My Chat');
    const list = (await call('ai:list-conversations')) as Array<{ title: string | null }>;
    expect(list[0].title).toBe('My Chat');
  });

  it('deletes a conversation', async () => {
    const { call } = await setup();
    const id = await call('ai:create-conversation');
    await call('ai:delete-conversation', id);
    expect(await call('ai:list-conversations')).toEqual([]);
  });

  it('gets history scoped to a specific conversation id', async () => {
    const { call } = await setup();
    const id = await call('ai:create-conversation');
    expect(await call('ai:get-history', id)).toEqual([]);
  });
});

describe('ai:get-usage-summary', () => {
  it('delegates to conversation.getUsageSummary and returns its result', async () => {
    const { getUsageSummary } = await import('./conversation');
    vi.mocked(getUsageSummary).mockReturnValue([
      { providerId: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001 },
    ]);
    const { call } = await setup();
    const result = await call('ai:get-usage-summary');
    expect(result).toEqual([
      { providerId: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001 },
    ]);
  });
});

describe('ai:transcribe-audio', () => {
  it('delegates to transcribeAudio and returns its result', async () => {
    const { transcribeAudio } = await import('./voice/transcribe');
    vi.mocked(transcribeAudio).mockResolvedValue({ ok: true, text: 'hello' });
    const { call } = await setup();
    const result = await call('ai:transcribe-audio', 'base64data', 'audio/wav');
    expect(result).toEqual({ ok: true, text: 'hello' });
    expect(transcribeAudio).toHaveBeenCalledWith(expect.anything(), 'base64data', 'audio/wav');
  });
});
