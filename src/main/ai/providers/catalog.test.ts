import { describe, expect, it } from 'vitest';
import { CATALOG, findCatalogEntry, isKnownGoodForTools } from './catalog';

describe('CATALOG', () => {
  it('every entry has a non-empty model id, display name, and a non-negative cost rank', () => {
    expect(CATALOG.length).toBeGreaterThan(0);
    for (const entry of CATALOG) {
      expect(entry.model.length).toBeGreaterThan(0);
      expect(entry.displayName.length).toBeGreaterThan(0);
      expect(entry.costRank).toBeGreaterThanOrEqual(0);
    }
  });

  it('has no duplicate (providerId, model) pairs', () => {
    const seen = new Set<string>();
    for (const entry of CATALOG) {
      const key = `${entry.providerId}:${entry.model}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe('findCatalogEntry', () => {
  it('finds a known entry', () => {
    const entry = findCatalogEntry('anthropic', 'claude-sonnet-5');
    expect(entry?.displayName).toBe('Claude Sonnet 5');
  });

  it('returns undefined for an unknown model', () => {
    expect(findCatalogEntry('anthropic', 'not-a-real-model')).toBeUndefined();
  });

  it('returns undefined for ollama, which is never in the static catalog', () => {
    expect(findCatalogEntry('ollama', 'llama3.1')).toBeUndefined();
  });
});

describe('isKnownGoodForTools', () => {
  it('matches known-good model name prefixes case-insensitively', () => {
    expect(isKnownGoodForTools('llama3.1:8b')).toBe(true);
    expect(isKnownGoodForTools('Qwen2.5-Coder')).toBe(true);
  });

  it('does not match an unrecognized model name', () => {
    expect(isKnownGoodForTools('tinyllama')).toBe(false);
  });
});
