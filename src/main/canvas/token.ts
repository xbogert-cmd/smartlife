import { safeStorage } from 'electron';
import type Database from 'better-sqlite3';
import type { CanvasCredentials } from './client';

const TOKEN_KEY = 'canvas_token_encrypted';
const BASE_URL_KEY = 'canvas_base_url';
const SAVED_AT_KEY = 'canvas_token_saved_at';

/** UNCW caps personal access tokens at 90 days; warn a week ahead. */
export const TOKEN_WARN_AFTER_DAYS = 83;

const MS_PER_DAY = 86_400_000;

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

export function normalizeBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) throw new Error('Canvas URL is required.');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error('Canvas URL is not a valid address.');
  }
  if (!parsed.hostname) throw new Error('Canvas URL is required.');
  return parsed.origin;
}

export function hasCanvasToken(db: Database.Database): boolean {
  return readSetting(db, TOKEN_KEY) !== null;
}

export function getCanvasToken(db: Database.Database): string | null {
  const stored = readSetting(db, TOKEN_KEY);
  if (stored === null || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    return null;
  }
}

export function setCanvasToken(db: Database.Database, token: string, now: Date = new Date()): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system.');
  }
  const encrypted = safeStorage.encryptString(token).toString('base64');
  writeSetting(db, TOKEN_KEY, encrypted);
  writeSetting(db, SAVED_AT_KEY, now.toISOString());
}

export function clearCanvasToken(db: Database.Database): void {
  db.prepare('delete from settings where key in (?, ?)').run(TOKEN_KEY, SAVED_AT_KEY);
}

export function getCanvasBaseUrl(db: Database.Database): string | null {
  return readSetting(db, BASE_URL_KEY);
}

export function setCanvasBaseUrl(db: Database.Database, rawUrl: string): void {
  writeSetting(db, BASE_URL_KEY, normalizeBaseUrl(rawUrl));
}

export function getTokenAgeDays(db: Database.Database, now: Date = new Date()): number | null {
  const savedAt = readSetting(db, SAVED_AT_KEY);
  if (savedAt === null) return null;
  const saved = Date.parse(savedAt);
  if (Number.isNaN(saved)) return null;
  return Math.floor((now.getTime() - saved) / MS_PER_DAY);
}

/** Returns null unless BOTH a base URL and a decryptable token are present. */
export function getCanvasCredentials(db: Database.Database): CanvasCredentials | null {
  const baseUrl = getCanvasBaseUrl(db);
  const token = getCanvasToken(db);
  if (baseUrl === null || token === null) return null;
  return { baseUrl, token };
}
