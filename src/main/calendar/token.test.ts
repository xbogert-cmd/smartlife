import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('Google client config storage', () => {
  it('returns null until both the ID and secret are stored', async () => {
    const { getGoogleClientConfig, setGoogleClientConfig } = await import('./token');
    const db = makeDb();
    expect(getGoogleClientConfig(db)).toBeNull();

    setGoogleClientConfig(db, 'client-123.apps.googleusercontent.com', 'secret-abc');
    expect(getGoogleClientConfig(db)).toEqual({
      clientId: 'client-123.apps.googleusercontent.com',
      clientSecret: 'secret-abc',
    });
  });

  it('stores the client secret encrypted, not in plaintext', async () => {
    const { setGoogleClientConfig } = await import('./token');
    const db = makeDb();
    setGoogleClientConfig(db, 'client-123', 'secret-abc');

    const rows = db.prepare('select value from settings').all() as Array<{ value: string }>;
    for (const row of rows) {
      expect(row.value).not.toContain('secret-abc');
    }
  });

  it('rejects a blank client ID or secret', async () => {
    const { setGoogleClientConfig } = await import('./token');
    const db = makeDb();
    expect(() => setGoogleClientConfig(db, '  ', 'secret')).toThrow('Client ID is required');
    expect(() => setGoogleClientConfig(db, 'client', '  ')).toThrow('Client secret is required');
  });
});

describe('Google refresh token storage', () => {
  it('round-trips the refresh token', async () => {
    const { getGoogleRefreshToken, setGoogleRefreshToken, hasGoogleAuth } = await import('./token');
    const db = makeDb();
    expect(hasGoogleAuth(db)).toBe(false);
    expect(getGoogleRefreshToken(db)).toBeNull();

    setGoogleRefreshToken(db, 'refresh-xyz');
    expect(getGoogleRefreshToken(db)).toBe('refresh-xyz');
    expect(hasGoogleAuth(db)).toBe(true);
  });

  it('clearGoogleAuth removes the token and email but keeps the client config', async () => {
    const mod = await import('./token');
    const db = makeDb();
    mod.setGoogleClientConfig(db, 'client-123', 'secret-abc');
    mod.setGoogleRefreshToken(db, 'refresh-xyz');
    mod.setGoogleAccountEmail(db, 'me@example.com');

    mod.clearGoogleAuth(db);

    expect(mod.getGoogleRefreshToken(db)).toBeNull();
    expect(mod.getGoogleAccountEmail(db)).toBeNull();
    // Re-connecting must not require re-typing the client credentials.
    expect(mod.getGoogleClientConfig(db)).toEqual({
      clientId: 'client-123',
      clientSecret: 'secret-abc',
    });
  });
});

describe('access token cache', () => {
  beforeEach(async () => {
    const { clearCachedAccessToken } = await import('./token');
    clearCachedAccessToken();
  });

  it('returns the cached token while it is still valid', async () => {
    const { getCachedAccessToken, setCachedAccessToken } = await import('./token');
    setCachedAccessToken('access-1', 3600, 1_000_000);
    expect(getCachedAccessToken(1_000_000 + 60_000)).toBe('access-1');
  });

  it('returns null once the token is within the safety margin of expiry', async () => {
    const { getCachedAccessToken, setCachedAccessToken } = await import('./token');
    setCachedAccessToken('access-1', 100, 1_000_000);
    // 100s lifetime, 60s margin -> treated as expired from t+40s onward.
    expect(getCachedAccessToken(1_000_000 + 39_000)).toBe('access-1');
    expect(getCachedAccessToken(1_000_000 + 41_000)).toBeNull();
  });

  it('clearCachedAccessToken drops the token immediately', async () => {
    const { clearCachedAccessToken, getCachedAccessToken, setCachedAccessToken } = await import('./token');
    setCachedAccessToken('access-1', 3600, 1_000_000);
    clearCachedAccessToken();
    expect(getCachedAccessToken(1_000_000)).toBeNull();
  });
});
