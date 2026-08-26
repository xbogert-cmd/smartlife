// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { setStoredApiKey } from './apiKey';
import { setGeminiKey, setOllamaEndpoint } from './providerConfig';
import { setRanking } from './providerRanking';
import { ProviderError } from './providers/types';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

const INIT_SQL = `create table settings (key text primary key, value text not null);`;
const RANKING_SQL = `create table ai_provider_ranking (rank integer primary key, provider text not null, model text not null);`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db, [
    { filename: '0001_init.sql', sql: INIT_SQL },
    { filename: '0007_ai_providers.sql', sql: RANKING_SQL },
  ]);
  return db;
}

function fakeParams() {
  return {
    system: 's',
    history: [],
    userText: 'hi',
    tools: [],
    ctx: { db: {} as never, conversationId: 'c1', mode: 'ask' as const, requestConfirmation: vi.fn() },
    onEvent: vi.fn(),
  };
}

describe('getProvider', () => {
  beforeEach(async () => {
    const { resetProviderCache } = await import('./router');
    resetProviderCache();
  });

  it('throws when nothing is ranked at all', async () => {
    const { getProvider } = await import('./router');
    const db = makeDb();
    await expect(getProvider(db).streamTurn(fakeParams())).rejects.toThrow(ProviderError);
  });

  it('skips a ranked entry whose credentials are missing rather than failing the whole list', async () => {
    const { getProvider } = await import('./router');
    const db = makeDb();
    setGeminiKey(db, 'gm-test');
    setRanking(db, [
      { providerId: 'anthropic', model: 'claude-sonnet-5' }, // no Anthropic key stored
      { providerId: 'gemini', model: 'gemini-2.5-flash' },
    ]);
    const provider = getProvider(db);
    expect(typeof provider.streamTurn).toBe('function');
  });

  it('caches the provider across calls so in-session failure memory survives, until reset', async () => {
    const { getProvider } = await import('./router');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    setRanking(db, [{ providerId: 'anthropic', model: 'claude-sonnet-5' }]);
    const first = getProvider(db);
    const second = getProvider(db);
    expect(first).toBe(second);
  });

  it('resetProviderCache forces the next call to rebuild from current settings', async () => {
    const { getProvider, resetProviderCache } = await import('./router');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    setRanking(db, [{ providerId: 'anthropic', model: 'claude-sonnet-5' }]);
    const first = getProvider(db);
    resetProviderCache();
    const second = getProvider(db);
    expect(first).not.toBe(second);
  });

  it('builds an Ollama entry using the configured endpoint, needing no key', async () => {
    const { getProvider } = await import('./router');
    const db = makeDb();
    setOllamaEndpoint(db, 'http://192.168.1.50:11434');
    setRanking(db, [{ providerId: 'ollama', model: 'llama3.1' }]);
    const provider = getProvider(db);
    expect(typeof provider.streamTurn).toBe('function');
  });
});

describe('hasUsableProvider', () => {
  it('returns false when nothing is ranked', async () => {
    const { hasUsableProvider } = await import('./router');
    const db = makeDb();
    expect(hasUsableProvider(db)).toBe(false);
  });

  it('returns false when something is ranked but has no valid credentials', async () => {
    const { hasUsableProvider } = await import('./router');
    const db = makeDb();
    setRanking(db, [{ providerId: 'anthropic', model: 'claude-sonnet-5' }]); // no Anthropic key stored
    expect(hasUsableProvider(db)).toBe(false);
  });

  it('returns true when a Gemini entry is ranked with a key stored, even with no Anthropic key at all', async () => {
    const { hasUsableProvider } = await import('./router');
    const db = makeDb();
    setGeminiKey(db, 'gm-test');
    setRanking(db, [
      { providerId: 'anthropic', model: 'claude-sonnet-5' }, // no Anthropic key stored
      { providerId: 'gemini', model: 'gemini-2.5-flash' },
    ]);
    expect(hasUsableProvider(db)).toBe(true);
  });

  it('returns true for an Ollama entry, which needs no key', async () => {
    const { hasUsableProvider } = await import('./router');
    const db = makeDb();
    setOllamaEndpoint(db, 'http://192.168.1.50:11434');
    setRanking(db, [{ providerId: 'ollama', model: 'llama3.1' }]);
    expect(hasUsableProvider(db)).toBe(true);
  });
});

describe("retryProviderEntry", () => {
  it("clears one entry's failure memory without wiping the whole cache", async () => {
    const { getProvider, resetProviderCache, retryProviderEntry } = await import('./router');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    setGeminiKey(db, 'gm-test');
    resetProviderCache();
    setRanking(db, [
      { providerId: 'anthropic', model: 'claude-sonnet-5' },
      { providerId: 'gemini', model: 'gemini-2.5-flash' },
    ]);
    const before = getProvider(db);
    retryProviderEntry(db, 'anthropic', 'claude-sonnet-5');
    const after = getProvider(db);
    // retryProviderEntry must not have reset the whole cache -- same instance.
    expect(before).toBe(after);
  });
});

describe("getActiveCapabilities", () => {
  it("reflects the starting (first-ranked) entry's catalog flags", async () => {
    const { getActiveCapabilities } = await import('./router');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    setRanking(db, [{ providerId: 'anthropic', model: 'claude-haiku-4-5-20251001' }]);
    expect(getActiveCapabilities(db)).toEqual({ supportsVision: true, supportsWebSearch: false });
  });

  it("prefers the pinned entry over ranking[0] when a pin is set", async () => {
    const { getActiveCapabilities } = await import('./router');
    const { setPinnedEntry } = await import('./providerConfig');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    setRanking(db, [
      { providerId: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      { providerId: 'anthropic', model: 'claude-sonnet-5' },
    ]);
    setPinnedEntry(db, { providerId: 'anthropic', model: 'claude-sonnet-5' });
    expect(getActiveCapabilities(db).supportsWebSearch).toBe(true);
  });

  it("detects Ollama vision support by model-name prefix, and never offers web search", async () => {
    const { getActiveCapabilities } = await import('./router');
    const db = makeDb();
    setOllamaEndpoint(db, 'http://localhost:11434');
    setRanking(db, [{ providerId: 'ollama', model: 'llava:13b' }]);
    expect(getActiveCapabilities(db)).toEqual({ supportsVision: true, supportsWebSearch: false });
  });

  it("returns both false when nothing is ranked", async () => {
    const { getActiveCapabilities } = await import('./router');
    const db = makeDb();
    expect(getActiveCapabilities(db)).toEqual({ supportsVision: false, supportsWebSearch: false });
  });
});
