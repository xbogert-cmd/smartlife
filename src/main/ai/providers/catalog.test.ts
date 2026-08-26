import { describe, expect, it } from 'vitest';
import { CATALOG, findCatalogEntry, isKnownGoodForTools, isKnownGoodForVision } from './catalog';

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

describe('capability flags', () => {
  it('every entry declares both capability flags as booleans', () => {
    for (const entry of CATALOG) {
      expect(typeof entry.supportsWebSearch).toBe('boolean');
      expect(typeof entry.supportsVision).toBe('boolean');
    }
  });

  it('Claude Haiku 4.5 does not support the hosted web-search tool (not in Anthropic\'s current model list for it)', () => {
    expect(findCatalogEntry('anthropic', 'claude-haiku-4-5-20251001')?.supportsWebSearch).toBe(false);
  });

  it('Claude Sonnet 5 and Opus 5 support the hosted web-search tool', () => {
    expect(findCatalogEntry('anthropic', 'claude-sonnet-5')?.supportsWebSearch).toBe(true);
    expect(findCatalogEntry('anthropic', 'claude-opus-5')?.supportsWebSearch).toBe(true);
  });

  it('both Gemini entries support search grounding and vision', () => {
    expect(findCatalogEntry('gemini', 'gemini-2.5-flash')?.supportsWebSearch).toBe(true);
    expect(findCatalogEntry('gemini', 'gemini-2.5-pro')?.supportsWebSearch).toBe(true);
    expect(findCatalogEntry('gemini', 'gemini-2.5-flash')?.supportsVision).toBe(true);
    expect(findCatalogEntry('gemini', 'gemini-2.5-pro')?.supportsVision).toBe(true);
  });

  it('every Anthropic entry supports vision (the whole Claude 3+ lineup is multimodal)', () => {
    for (const entry of CATALOG.filter((e) => e.providerId === 'anthropic')) {
      expect(entry.supportsVision).toBe(true);
    }
  });
});

describe('isKnownGoodForVision', () => {
  it('matches known vision-capable local model prefixes case-insensitively', () => {
    expect(isKnownGoodForVision('llava:13b')).toBe(true);
    expect(isKnownGoodForVision('Qwen2.5vl')).toBe(true);
    expect(isKnownGoodForVision('llama3.2-vision')).toBe(true);
  });

  it('does not match a text-only model', () => {
    expect(isKnownGoodForVision('llama3.1')).toBe(false);
  });
});
