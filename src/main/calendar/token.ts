import { safeStorage } from 'electron';
import type Database from 'better-sqlite3';

const REFRESH_TOKEN_KEY = 'google_refresh_token_encrypted';
const CLIENT_ID_KEY = 'google_client_id_encrypted';
const CLIENT_SECRET_KEY = 'google_client_secret_encrypted';
const ACCOUNT_EMAIL_KEY = 'google_account_email';

/**
 * Refresh a little before the token actually dies. Without a margin, a token
 * that passes the check and then spends 30s in a slow request arrives expired.
 */
const EXPIRY_MARGIN_MS = 60_000;

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
}

function readSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('select value from settings where key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

function writeSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    'insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
  ).run(key, value);
}

function writeEncrypted(db: Database.Database, key: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system.');
  }
  writeSetting(db, key, safeStorage.encryptString(value).toString('base64'));
}

function readEncrypted(db: Database.Database, key: string): string | null {
  const stored = readSetting(db, key);
  if (stored === null || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    return null;
  }
}

/**
 * Google issues a client secret even for Desktop clients and the token
 * exchange requires it. It is explicitly not confidential for installed apps,
 * but there is no reason to leave it sitting in the database in plaintext.
 */
export function setGoogleClientConfig(
  db: Database.Database,
  clientId: string,
  clientSecret: string
): void {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (id.length === 0) throw new Error('Client ID is required.');
  if (secret.length === 0) throw new Error('Client secret is required.');
  writeEncrypted(db, CLIENT_ID_KEY, id);
  writeEncrypted(db, CLIENT_SECRET_KEY, secret);
}

export function getGoogleClientConfig(db: Database.Database): GoogleClientConfig | null {
  const clientId = readEncrypted(db, CLIENT_ID_KEY);
  const clientSecret = readEncrypted(db, CLIENT_SECRET_KEY);
  if (clientId === null || clientSecret === null) return null;
  return { clientId, clientSecret };
}

export function setGoogleRefreshToken(db: Database.Database, token: string): void {
  writeEncrypted(db, REFRESH_TOKEN_KEY, token);
}

export function getGoogleRefreshToken(db: Database.Database): string | null {
  return readEncrypted(db, REFRESH_TOKEN_KEY);
}

export function hasGoogleAuth(db: Database.Database): boolean {
  return readSetting(db, REFRESH_TOKEN_KEY) !== null;
}

export function setGoogleAccountEmail(db: Database.Database, email: string): void {
  writeSetting(db, ACCOUNT_EMAIL_KEY, email);
}

export function getGoogleAccountEmail(db: Database.Database): string | null {
  return readSetting(db, ACCOUNT_EMAIL_KEY);
}

/**
 * Disconnects the account but deliberately keeps the client ID and secret:
 * those describe the user's Google Cloud project, not their grant, and making
 * them retype both to reconnect would be pointless friction.
 */
export function clearGoogleAuth(db: Database.Database): void {
  db.prepare('delete from settings where key in (?, ?)').run(REFRESH_TOKEN_KEY, ACCOUNT_EMAIL_KEY);
  clearCachedAccessToken();
}

// Access tokens are short-lived and must never be persisted, so this cache is
// module-scoped and dies with the process.
// ponytail: one slot is enough -- there is exactly one Google account.
let accessTokenCache: { token: string; expiresAtMs: number } | null = null;

export function setCachedAccessToken(
  token: string,
  expiresInSeconds: number,
  now: number = Date.now()
): void {
  accessTokenCache = { token, expiresAtMs: now + expiresInSeconds * 1000 };
}

export function getCachedAccessToken(now: number = Date.now()): string | null {
  if (accessTokenCache === null) return null;
  if (now >= accessTokenCache.expiresAtMs - EXPIRY_MARGIN_MS) return null;
  return accessTokenCache.token;
}

export function clearCachedAccessToken(): void {
  accessTokenCache = null;
}
