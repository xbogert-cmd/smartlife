import { safeStorage } from 'electron';
import type Database from 'better-sqlite3';
import type { ProviderId } from './providers/types';

const GEMINI_KEY = 'gemini_api_key_encrypted';
const OLLAMA_ENDPOINT_KEY = 'ollama_endpoint';
const PINNED_PROVIDER_KEY = 'ai_pinned_provider';
const PINNED_MODEL_KEY = 'ai_pinned_model';

export const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';

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

function deleteSetting(db: Database.Database, key: string): void {
  db.prepare('delete from settings where key = ?').run(key);
}

export function hasGeminiKey(db: Database.Database): boolean {
  return readSetting(db, GEMINI_KEY) !== null;
}

export function getGeminiKey(db: Database.Database): string | null {
  const stored = readSetting(db, GEMINI_KEY);
  if (stored === null || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    return null;
  }
}

export function setGeminiKey(db: Database.Database, apiKey: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system.');
  }
  const encrypted = safeStorage.encryptString(apiKey).toString('base64');
  writeSetting(db, GEMINI_KEY, encrypted);
}

export function clearGeminiKey(db: Database.Database): void {
  deleteSetting(db, GEMINI_KEY);
}

export function getOllamaEndpoint(db: Database.Database): string {
  return readSetting(db, OLLAMA_ENDPOINT_KEY) ?? DEFAULT_OLLAMA_ENDPOINT;
}

export function setOllamaEndpoint(db: Database.Database, endpoint: string): void {
  const trimmed = endpoint.trim();
  if (trimmed.length === 0) throw new Error('Ollama endpoint is required.');
  writeSetting(db, OLLAMA_ENDPOINT_KEY, trimmed);
}

export interface PinnedEntry {
  providerId: ProviderId;
  model: string;
}

const VALID_PROVIDER_IDS: ProviderId[] = ['anthropic', 'gemini', 'ollama'];

/** Returns null when nothing is pinned, or when only one of the pair is set --
 *  the pair is both-or-neither, so a corrupted half-write reads as "not pinned"
 *  rather than crashing on a missing model. */
export function getPinnedEntry(db: Database.Database): PinnedEntry | null {
  const providerId = readSetting(db, PINNED_PROVIDER_KEY);
  const model = readSetting(db, PINNED_MODEL_KEY);
  if (providerId === null || model === null) return null;
  if (!VALID_PROVIDER_IDS.includes(providerId as ProviderId)) return null;
  return { providerId: providerId as ProviderId, model };
}

export function setPinnedEntry(db: Database.Database, entry: PinnedEntry): void {
  writeSetting(db, PINNED_PROVIDER_KEY, entry.providerId);
  writeSetting(db, PINNED_MODEL_KEY, entry.model);
}

export function clearPinnedEntry(db: Database.Database): void {
  deleteSetting(db, PINNED_PROVIDER_KEY);
  deleteSetting(db, PINNED_MODEL_KEY);
}
