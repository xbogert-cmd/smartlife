import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null);');
  return db;
}

describe('Gemini key storage', () => {
  it('round-trips a key through encryption', async () => {
    const { setGeminiKey, getGeminiKey, hasGeminiKey } = await import('./providerConfig');
    const db = makeDb();
    expect(hasGeminiKey(db)).toBe(false);
    setGeminiKey(db, 'test-gemini-key');
    expect(hasGeminiKey(db)).toBe(true);
    expect(getGeminiKey(db)).toBe('test-gemini-key');
  });

  it('clears a stored key', async () => {
    const { setGeminiKey, clearGeminiKey, hasGeminiKey } = await import('./providerConfig');
    const db = makeDb();
    setGeminiKey(db, 'test-gemini-key');
    clearGeminiKey(db);
    expect(hasGeminiKey(db)).toBe(false);
  });
});

describe('Ollama endpoint storage', () => {
  it('defaults to localhost:11434 when nothing is stored', async () => {
    const { getOllamaEndpoint } = await import('./providerConfig');
    const db = makeDb();
    expect(getOllamaEndpoint(db)).toBe('http://localhost:11434');
  });

  it('stores and returns a custom endpoint', async () => {
    const { setOllamaEndpoint, getOllamaEndpoint } = await import('./providerConfig');
    const db = makeDb();
    setOllamaEndpoint(db, 'http://192.168.1.50:11434');
    expect(getOllamaEndpoint(db)).toBe('http://192.168.1.50:11434');
  });

  it('rejects an empty endpoint', async () => {
    const { setOllamaEndpoint } = await import('./providerConfig');
    const db = makeDb();
    expect(() => setOllamaEndpoint(db, '   ')).toThrow('Ollama endpoint is required.');
  });
});

describe('pinned provider/model', () => {
  it('returns null when nothing is pinned', async () => {
    const { getPinnedEntry } = await import('./providerConfig');
    const db = makeDb();
    expect(getPinnedEntry(db)).toBeNull();
  });

  it('round-trips a pinned entry', async () => {
    const { setPinnedEntry, getPinnedEntry } = await import('./providerConfig');
    const db = makeDb();
    setPinnedEntry(db, { providerId: 'anthropic', model: 'claude-opus-5' });
    expect(getPinnedEntry(db)).toEqual({ providerId: 'anthropic', model: 'claude-opus-5' });
  });

  it('clears a pinned entry back to "Auto"', async () => {
    const { setPinnedEntry, clearPinnedEntry, getPinnedEntry } = await import('./providerConfig');
    const db = makeDb();
    setPinnedEntry(db, { providerId: 'gemini', model: 'gemini-2.5-pro' });
    clearPinnedEntry(db);
    expect(getPinnedEntry(db)).toBeNull();
  });

  it('treats a half-written pair (only one of the two keys set) as not pinned', async () => {
    const { getPinnedEntry } = await import('./providerConfig');
    const db = makeDb();
    db.prepare('insert into settings (key, value) values (?, ?)').run('ai_pinned_provider', 'anthropic');
    expect(getPinnedEntry(db)).toBeNull();
  });
});
