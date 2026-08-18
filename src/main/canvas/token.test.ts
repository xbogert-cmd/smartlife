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

describe('normalizeBaseUrl', () => {
  it('adds https and strips a trailing slash', async () => {
    const { normalizeBaseUrl } = await import('./token');
    expect(normalizeBaseUrl('uncw.instructure.com')).toBe('https://uncw.instructure.com');
    expect(normalizeBaseUrl('https://uncw.instructure.com/')).toBe('https://uncw.instructure.com');
    expect(normalizeBaseUrl('  https://uncw.instructure.com  ')).toBe('https://uncw.instructure.com');
  });

  it('strips a pasted path so only the origin survives', async () => {
    const { normalizeBaseUrl } = await import('./token');
    expect(normalizeBaseUrl('https://uncw.instructure.com/profile/settings')).toBe(
      'https://uncw.instructure.com'
    );
  });

  it('rejects a blank host', async () => {
    const { normalizeBaseUrl } = await import('./token');
    expect(() => normalizeBaseUrl('   ')).toThrow('Canvas URL is required');
  });
});

describe('Canvas token storage', () => {
  it('reports no token stored by default', async () => {
    const { hasCanvasToken, getCanvasToken, getCanvasBaseUrl } = await import('./token');
    const db = makeDb();
    expect(hasCanvasToken(db)).toBe(false);
    expect(getCanvasToken(db)).toBeNull();
    expect(getCanvasBaseUrl(db)).toBeNull();
  });

  it('round-trips a token through encryption', async () => {
    const { setCanvasToken, getCanvasToken, hasCanvasToken } = await import('./token');
    const db = makeDb();
    setCanvasToken(db, 'canvas-test-token');
    expect(hasCanvasToken(db)).toBe(true);
    expect(getCanvasToken(db)).toBe('canvas-test-token');
  });

  it('stores the base URL normalized', async () => {
    const { setCanvasBaseUrl, getCanvasBaseUrl } = await import('./token');
    const db = makeDb();
    setCanvasBaseUrl(db, 'uncw.instructure.com/');
    expect(getCanvasBaseUrl(db)).toBe('https://uncw.instructure.com');
  });

  it('clears the token and its saved-at stamp but keeps the base URL', async () => {
    const { setCanvasToken, setCanvasBaseUrl, clearCanvasToken, hasCanvasToken, getCanvasBaseUrl, getTokenAgeDays } =
      await import('./token');
    const db = makeDb();
    setCanvasBaseUrl(db, 'uncw.instructure.com');
    setCanvasToken(db, 'canvas-test-token');
    clearCanvasToken(db);
    expect(hasCanvasToken(db)).toBe(false);
    expect(getTokenAgeDays(db)).toBeNull();
    expect(getCanvasBaseUrl(db)).toBe('https://uncw.instructure.com');
  });

  it('computes token age in whole days from the saved-at stamp', async () => {
    const { setCanvasToken, getTokenAgeDays } = await import('./token');
    const db = makeDb();
    setCanvasToken(db, 'canvas-test-token', new Date('2026-08-18T00:00:00Z'));
    expect(getTokenAgeDays(db, new Date('2026-08-18T00:00:00Z'))).toBe(0);
    expect(getTokenAgeDays(db, new Date('2026-09-10T00:00:00Z'))).toBe(23);
  });

  it('returns null age when no token is stored', async () => {
    const { getTokenAgeDays } = await import('./token');
    expect(getTokenAgeDays(makeDb())).toBeNull();
  });
});
