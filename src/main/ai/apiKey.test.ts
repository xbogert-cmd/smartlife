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
  db.exec('create table settings (key text primary key, value text not null)');
  return db;
}

describe('API key storage', () => {
  it('reports no key stored by default', async () => {
    const { hasStoredApiKey, getStoredApiKey } = await import('./apiKey');
    const db = makeDb();
    expect(hasStoredApiKey(db)).toBe(false);
    expect(getStoredApiKey(db)).toBeNull();
  });

  it('round-trips a stored key through encryption', async () => {
    const { setStoredApiKey, getStoredApiKey, hasStoredApiKey } = await import('./apiKey');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test-key');
    expect(hasStoredApiKey(db)).toBe(true);
    expect(getStoredApiKey(db)).toBe('sk-ant-test-key');
  });

  it('overwrites a previously stored key', async () => {
    const { setStoredApiKey, getStoredApiKey } = await import('./apiKey');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-first');
    setStoredApiKey(db, 'sk-ant-second');
    expect(getStoredApiKey(db)).toBe('sk-ant-second');
  });

  it('throws when encryption is unavailable', async () => {
    vi.doMock('electron', () => ({
      safeStorage: { isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() },
    }));
    vi.resetModules();
    const { setStoredApiKey } = await import('./apiKey');
    const db = makeDb();
    expect(() => setStoredApiKey(db, 'sk-ant-test')).toThrow('Secure storage is not available');
  });
});
