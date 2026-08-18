import { safeStorage } from 'electron';
import type Database from 'better-sqlite3';

const SETTINGS_KEY = 'anthropic_api_key_encrypted';

export function hasStoredApiKey(db: Database.Database): boolean {
  const row = db.prepare('select 1 from settings where key = ?').get(SETTINGS_KEY);
  return !!row;
}

export function getStoredApiKey(db: Database.Database): string | null {
  const row = db.prepare('select value from settings where key = ?').get(SETTINGS_KEY) as
    | { value: string }
    | undefined;
  if (!row || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(row.value, 'base64'));
  } catch {
    return null;
  }
}

export function setStoredApiKey(db: Database.Database, apiKey: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system.');
  }
  const encrypted = safeStorage.encryptString(apiKey).toString('base64');
  db.prepare(
    'insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
  ).run(SETTINGS_KEY, encrypted);
}
