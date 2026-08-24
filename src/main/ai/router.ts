import type Database from 'better-sqlite3';
import { getStoredApiKey } from './apiKey';
import { createClaudeProvider } from './providers/claude';
import { ProviderError, type AIProvider } from './providers/types';

export function getProvider(db: Database.Database): AIProvider {
  const apiKey = getStoredApiKey(db);
  if (apiKey === null) {
    return {
      async streamTurn() {
        throw new ProviderError('No API key configured — add one in Settings.');
      },
    };
  }
  return createClaudeProvider(apiKey, 'claude-sonnet-5');
}
