// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { setStoredApiKey } from './apiKey';
import { ProviderError } from './providers/types';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

const INIT_SQL = `create table settings (key text primary key, value text not null);`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db, [{ filename: '0001_init.sql', sql: INIT_SQL }]);
  return db;
}

describe('getProvider', () => {
  it('throws a ProviderError when no API key is stored', async () => {
    const { getProvider } = await import('./router');
    const db = makeDb();
    const provider = getProvider(db);
    await expect(
      provider.streamTurn({
        system: 's',
        history: [],
        userText: 'hi',
        tools: [],
        ctx: { db, conversationId: 'c1', mode: 'ask', requestConfirmation: vi.fn() },
        onEvent: vi.fn(),
      })
    ).rejects.toThrow(ProviderError);
  });

  it('returns a working Claude provider when an API key is stored', async () => {
    const { getProvider } = await import('./router');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const provider = getProvider(db);
    expect(typeof provider.streamTurn).toBe('function');
  });
});
