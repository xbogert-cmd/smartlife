import type { ProviderId } from './types';

export interface CatalogEntry {
  providerId: 'anthropic' | 'gemini';
  model: string;
  displayName: string;
  costRank: number;
  /** Whether this entry's hosted web-search tool may be offered on a turn.
   *  Verified against docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool
   *  and ai.google.dev/gemini-api/docs/grounding at plan time (2026-08-26) --
   *  re-verify before adjusting, same rule as costRank below. */
  supportsWebSearch: boolean;
  /** Whether this entry accepts image input (uploaded images, screenshots). */
  supportsVision: boolean;
}

/**
 * Static, hand-verified list -- not queried live. Anthropic and Gemini's
 * model catalogs are small and change rarely enough that hardcoding is the
 * right call (matches how claude.ts already hardcoded a single MODEL
 * constant before this phase). Re-verify against current docs before
 * adjusting: https://docs.claude.com/en/docs/about-claude/models and
 * https://ai.google.dev/gemini-api/docs/models.
 *
 * costRank is ordinal, not a real price: lower means cheaper/smaller. The
 * only thing that matters is the relative ordering between entries -- it is
 * what stops automatic fallback from silently crossing from a cheap model
 * into an expensive one without being asked.
 */
export const CATALOG: CatalogEntry[] = [
  {
    providerId: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5',
    costRank: 1,
    supportsWebSearch: false,
    supportsVision: true,
  },
  {
    providerId: 'gemini',
    model: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    costRank: 1,
    supportsWebSearch: true,
    supportsVision: true,
  },
  {
    providerId: 'anthropic',
    model: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    costRank: 3,
    supportsWebSearch: true,
    supportsVision: true,
  },
  {
    providerId: 'gemini',
    model: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    costRank: 3,
    supportsWebSearch: true,
    supportsVision: true,
  },
  {
    providerId: 'anthropic',
    model: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    costRank: 5,
    supportsWebSearch: true,
    supportsVision: true,
  },
];

/** Ollama models are never in the static CATALOG -- they're whatever the user
 *  has actually pulled locally, fetched live via /api/tags (see ollama.ts). */
export const OLLAMA_COST_RANK = 0;

/**
 * Model-name prefixes known to support tool-calling reasonably well. This is
 * advisory only -- Settings shows a warning for any pulled Ollama model that
 * doesn't match, but never blocks selecting it. Does not apply to Anthropic
 * or Gemini entries above; only models already known to support tool-calling
 * well are ever added to CATALOG in the first place.
 */
const KNOWN_GOOD_FOR_TOOLS_PREFIXES = ['llama3.1', 'llama3.2', 'qwen2.5', 'mistral-nemo'];

export function isKnownGoodForTools(ollamaModelName: string): boolean {
  const lower = ollamaModelName.toLowerCase();
  return KNOWN_GOOD_FOR_TOOLS_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Model-name prefixes known to handle image input well. Same advisory-only
 *  status as KNOWN_GOOD_FOR_TOOLS_PREFIXES -- browser_screenshot and image
 *  attachments are simply not offered to an Ollama model that doesn't match,
 *  never a hard block on selecting the model itself. */
const KNOWN_VISION_PREFIXES = ['llava', 'qwen2.5vl', 'qwen2-vl', 'llama3.2-vision', 'bakllava', 'moondream', 'minicpm-v'];

export function isKnownGoodForVision(ollamaModelName: string): boolean {
  const lower = ollamaModelName.toLowerCase();
  return KNOWN_VISION_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function findCatalogEntry(providerId: ProviderId, model: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.providerId === providerId && entry.model === model);
}
