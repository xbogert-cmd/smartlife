import type { AIProvider, ProviderId, StreamEvent } from './types';

export interface RankedEntry {
  providerId: ProviderId;
  model: string;
  displayName: string;
  costRank: number;
  provider: AIProvider;
}

export interface FallbackOptions {
  /** When set, the entry FallbackProvider starts from instead of the ranked
   *  list's own top -- see providerConfig.ts's PinnedEntry. */
  pinned?: { providerId: ProviderId; model: string };
}

export interface RetryableFallbackProvider extends AIProvider {
  /** Clears one entry's in-session failure memory, e.g. after the user fixes
   *  whatever made it fail (added credits, started Ollama). */
  retryEntry(providerId: ProviderId, model: string): void;
}

/**
 * Implements AIProvider itself, wrapping an ordered list of real provider
 * instances -- chatController.ts stays completely unaware fallback exists,
 * it just calls streamTurn() on whatever router.ts hands it.
 *
 * A failed entry is remembered for the life of this instance (i.e. the rest
 * of the app session -- router.ts constructs and CACHES a single
 * FallbackProvider per session; see its Global Constraint). Automatic
 * fallback only ever moves to an entry whose costRank is <= the starting
 * entry's -- it never silently crosses into a pricier/more-capable tier. If
 * nothing at or below that cost rank remains untried, it stops and reports
 * what was tried rather than guessing whether escalating would help.
 */
export function createFallbackProvider(entries: RankedEntry[], options: FallbackOptions = {}): RetryableFallbackProvider {
  const failed = new Set<string>();
  const key = (e: RankedEntry): string => `${e.providerId}:${e.model}`;

  function startingEntry(): RankedEntry | undefined {
    if (options.pinned) {
      const pinned = entries.find(
        (e) => e.providerId === options.pinned!.providerId && e.model === options.pinned!.model
      );
      if (pinned) return pinned;
    }
    return entries[0];
  }

  function nextCandidate(atOrBelowCostRank: number, tried: Set<string>): RankedEntry | undefined {
    return entries.find((e) => e.costRank <= atOrBelowCostRank && !failed.has(key(e)) && !tried.has(key(e)));
  }

  return {
    async streamTurn(params) {
      const start = startingEntry();
      if (!start) {
        throw new Error('No AI provider is configured — add one in Settings.');
      }

      const triedThisTurn = new Set<string>();
      let current: RankedEntry | undefined = failed.has(key(start))
        ? nextCandidate(start.costRank, triedThisTurn)
        : start;

      while (current) {
        triedThisTurn.add(key(current));
        try {
          return await current.provider.streamTurn(params);
        } catch (error) {
          failed.add(key(current));
          const next = nextCandidate(start.costRank, triedThisTurn);
          if (!next) {
            const triedNames = [...triedThisTurn]
              .map((k) => entries.find((e) => key(e) === k)?.displayName ?? k)
              .join(', ');
            throw new Error(
              `Everything tried failed: ${triedNames}. ${error instanceof Error ? error.message : ''}`.trim()
            );
          }
          const reason = error instanceof Error ? error.message : 'unavailable';
          params.onEvent({
            type: 'provider-switched',
            from: current.displayName,
            to: next.displayName,
            reason,
          } satisfies StreamEvent);
          current = next;
        }
      }

      throw new Error('No AI provider is configured — add one in Settings.');
    },
    retryEntry(providerId, model) {
      failed.delete(`${providerId}:${model}`);
    },
  };
}
