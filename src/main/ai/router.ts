import type Database from 'better-sqlite3';
import { getStoredApiKey } from './apiKey';
import { getGeminiKey, getOllamaEndpoint, getPinnedEntry } from './providerConfig';
import { getRanking } from './providerRanking';
import { OLLAMA_COST_RANK, findCatalogEntry } from './providers/catalog';
import { createClaudeProvider } from './providers/claude';
import { createFallbackProvider, type RankedEntry } from './providers/fallback';
import { createGeminiProvider } from './providers/gemini';
import { createOllamaProvider } from './providers/ollama';
import { ProviderError, type AIProvider, type ProviderId } from './providers/types';

function displayNameFor(providerId: ProviderId, model: string): string {
  if (providerId === 'ollama') return `Ollama — ${model}`;
  return findCatalogEntry(providerId, model)?.displayName ?? `${providerId} — ${model}`;
}

function costRankFor(providerId: ProviderId, model: string): number {
  if (providerId === 'ollama') return OLLAMA_COST_RANK;
  return findCatalogEntry(providerId, model)?.costRank ?? Number.MAX_SAFE_INTEGER;
}

function buildProvider(db: Database.Database, providerId: ProviderId, model: string): AIProvider | null {
  if (providerId === 'anthropic') {
    const apiKey = getStoredApiKey(db);
    return apiKey === null ? null : createClaudeProvider(apiKey, model);
  }
  if (providerId === 'gemini') {
    const apiKey = getGeminiKey(db);
    return apiKey === null ? null : createGeminiProvider(apiKey, model);
  }
  return createOllamaProvider(getOllamaEndpoint(db), model);
}

let cached: AIProvider | null = null;

/**
 * Builds (or reuses) a single FallbackProvider wired to whatever is
 * currently configured. Cached until resetProviderCache() is called so the
 * in-session failure memory a FallbackProvider accumulates survives across
 * turns -- constructing a brand new one on every message would throw that
 * memory away and defeat the whole point of "remember and skip" (see this
 * task's own Global Constraint). Every AI-provider Settings write must call
 * resetProviderCache() after persisting.
 */
export function getProvider(db: Database.Database): AIProvider {
  if (cached) return cached;

  const ranking = getRanking(db);
  const entries: RankedEntry[] = [];
  for (const { providerId, model } of ranking) {
    const provider = buildProvider(db, providerId, model);
    if (provider === null) continue; // credentials missing for this entry -- skip, don't fail the whole list
    entries.push({
      providerId,
      model,
      displayName: displayNameFor(providerId, model),
      costRank: costRankFor(providerId, model),
      provider,
    });
  }

  if (entries.length === 0) {
    cached = {
      async streamTurn() {
        throw new ProviderError('No AI provider is configured — add one in Settings.');
      },
    };
    return cached;
  }

  const pinned = getPinnedEntry(db) ?? undefined;
  cached = createFallbackProvider(entries, { pinned });
  return cached;
}

/** Called by the AI-provider Settings IPC handlers after any config change
 *  (a new key, a reordered ranking, a new pin) so the next message picks up
 *  the change immediately instead of reusing a stale cached provider. */
export function resetProviderCache(): void {
  cached = null;
}

/** Exposes the live FallbackProvider's retry hook to Settings' "retry"
 *  button, if the current provider actually is one (it might be the single
 *  not-configured stub, which has no failure memory to clear). */
export function retryProviderEntry(db: Database.Database, providerId: ProviderId, model: string): void {
  const provider = getProvider(db);
  if ('retryEntry' in provider) {
    (provider as { retryEntry: (p: ProviderId, m: string) => void }).retryEntry(providerId, model);
  }
}
