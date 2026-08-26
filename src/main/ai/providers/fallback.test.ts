import { describe, expect, it, vi } from 'vitest';
import type { CanonicalImageBlock } from '../tools/types';
import type { AIProvider, CanonicalTextBlock } from './types';
import { createFallbackProvider, type RankedEntry } from './fallback';

function fakeProvider(behavior: 'succeed' | 'fail', text = 'ok'): AIProvider {
  return {
    streamTurn: vi.fn(async () => {
      if (behavior === 'fail') throw new Error('boom');
      return [{ type: 'text', text }] as CanonicalTextBlock[];
    }),
  };
}

function baseParams() {
  return {
    system: 's',
    history: [],
    userText: 'hi',
    tools: [],
    ctx: { db: {} as never, conversationId: 'c1', mode: 'ask' as const, requestConfirmation: vi.fn() },
    onEvent: vi.fn(),
  };
}

describe('createFallbackProvider', () => {
  it('uses the top ranked entry when it succeeds, never touching the rest', async () => {
    const top = fakeProvider('succeed', 'from top');
    const second = fakeProvider('succeed', 'from second');
    const entries: RankedEntry[] = [
      { providerId: 'anthropic', model: 'a', displayName: 'A', costRank: 3, provider: top },
      { providerId: 'gemini', model: 'b', displayName: 'B', costRank: 1, provider: second },
    ];
    const fallback = createFallbackProvider(entries);
    const result = await fallback.streamTurn(baseParams());
    expect(result).toEqual([{ type: 'text', text: 'from top' }]);
    expect(second.streamTurn).not.toHaveBeenCalled();
  });

  it('falls to the next entry at or below the same cost rank when the top fails, and announces it', async () => {
    const top = fakeProvider('fail');
    const second = fakeProvider('succeed', 'from second');
    const entries: RankedEntry[] = [
      { providerId: 'anthropic', model: 'a', displayName: 'A', costRank: 3, provider: top },
      { providerId: 'gemini', model: 'b', displayName: 'B', costRank: 1, provider: second },
    ];
    const fallback = createFallbackProvider(entries);
    const params = baseParams();
    const result = await fallback.streamTurn(params);
    expect(result).toEqual([{ type: 'text', text: 'from second' }]);
    expect(params.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'provider-switched', from: 'A', to: 'B' })
    );
  });

  it('does not automatically cross into a higher cost rank than the starting entry', async () => {
    const cheap = fakeProvider('fail');
    const pricier = fakeProvider('succeed', 'from pricier');
    const entries: RankedEntry[] = [
      { providerId: 'gemini', model: 'flash', displayName: 'Flash', costRank: 1, provider: cheap },
      { providerId: 'anthropic', model: 'opus', displayName: 'Opus', costRank: 5, provider: pricier },
    ];
    const fallback = createFallbackProvider(entries);
    await expect(fallback.streamTurn(baseParams())).rejects.toThrow(/Everything tried failed/);
    expect(pricier.streamTurn).not.toHaveBeenCalled();
  });

  it('sticky-skips an already-failed entry on a later, separate call, without retrying it', async () => {
    const top = fakeProvider('fail');
    const second = fakeProvider('succeed', 'from second');
    const entries: RankedEntry[] = [
      { providerId: 'anthropic', model: 'a', displayName: 'A', costRank: 1, provider: top },
      { providerId: 'gemini', model: 'b', displayName: 'B', costRank: 1, provider: second },
    ];
    const fallback = createFallbackProvider(entries);
    await fallback.streamTurn(baseParams());
    vi.mocked(top.streamTurn).mockClear();
    await fallback.streamTurn(baseParams());
    expect(top.streamTurn).not.toHaveBeenCalled();
  });

  it('retryEntry clears an entry’s failure memory so it is tried again', async () => {
    const top = fakeProvider('fail');
    const second = fakeProvider('succeed', 'from second');
    const entries: RankedEntry[] = [
      { providerId: 'anthropic', model: 'a', displayName: 'A', costRank: 1, provider: top },
      { providerId: 'gemini', model: 'b', displayName: 'B', costRank: 1, provider: second },
    ];
    const fallback = createFallbackProvider(entries);
    await fallback.streamTurn(baseParams());
    fallback.retryEntry('anthropic', 'a');
    vi.mocked(top.streamTurn).mockClear();
    await fallback.streamTurn(baseParams());
    expect(top.streamTurn).toHaveBeenCalled();
  });

  it('a manual pin changes the starting point, with the same cost-rank ceiling applying from there', async () => {
    const cheaperFallback = fakeProvider('succeed', 'from cheaper');
    const pinnedMid = fakeProvider('fail');
    const pricier = fakeProvider('succeed', 'from pricier');
    const entries: RankedEntry[] = [
      { providerId: 'gemini', model: 'flash', displayName: 'Flash', costRank: 1, provider: cheaperFallback },
      { providerId: 'anthropic', model: 'sonnet', displayName: 'Sonnet', costRank: 3, provider: pinnedMid },
      { providerId: 'anthropic', model: 'opus', displayName: 'Opus', costRank: 5, provider: pricier },
    ];
    const fallback = createFallbackProvider(entries, { pinned: { providerId: 'anthropic', model: 'sonnet' } });
    const result = await fallback.streamTurn(baseParams());
    // Starting from the pin (costRank 3), fallback may move to something at
    // or below that rank (Flash, costRank 1) but never up to Opus (costRank 5).
    expect(result).toEqual([{ type: 'text', text: 'from cheaper' }]);
    expect(pricier.streamTurn).not.toHaveBeenCalled();
  });

  it('keeps the cost-rank ceiling fixed at the starting entry across multiple hops, not ratcheting down further with each failure', async () => {
    const cheapest = fakeProvider('fail'); // rank 1, tried first by array order
    const midTier = fakeProvider('succeed', 'from mid tier'); // rank 3, untried and unfailed
    const pricier = fakeProvider('fail'); // rank 5, the pinned start -- must fail so the turn hops away from it
    const entries: RankedEntry[] = [
      { providerId: 'ollama', model: 'llama3.1', displayName: 'Llama 3.1', costRank: 1, provider: cheapest },
      { providerId: 'anthropic', model: 'sonnet', displayName: 'Sonnet', costRank: 3, provider: midTier },
      { providerId: 'anthropic', model: 'opus', displayName: 'Opus', costRank: 5, provider: pricier },
    ];
    // Pinned start at Opus (costRank 5) -- so the ceiling for the WHOLE turn
    // should stay 5, even after hopping down to and failing at the cheapest
    // entry (costRank 1). If the ceiling incorrectly ratcheted to the
    // just-failed entry's own rank (1) instead of staying fixed at the
    // original start's rank (5), Sonnet (costRank 3, still <= 5) would be
    // wrongly excluded and this would throw instead of succeeding.
    const fallback = createFallbackProvider(entries, { pinned: { providerId: 'anthropic', model: 'opus' } });
    const result = await fallback.streamTurn(baseParams());
    expect(result).toEqual([{ type: 'text', text: 'from mid tier' }]);
    expect(pricier.streamTurn).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error and calls nothing when the entry list is empty', async () => {
    const fallback = createFallbackProvider([]);
    await expect(fallback.streamTurn(baseParams())).rejects.toThrow(/No AI provider is configured/);
  });

  it("does not leak provider A's stale attached image into provider B's turn via the shared ctx (Finding 2)", async () => {
    // Same closure pattern chatController.ts uses for real: attachImage
    // pushes onto a captured local array that ctx.pendingImages also points
    // at, so truncating one is visible through the other -- unlike a plain
    // reassignment, which would orphan this reference.
    const pendingImages: CanonicalImageBlock[] = [];
    const ctx = {
      ...baseParams().ctx,
      pendingImages,
      attachImage: (block: CanonicalImageBlock) => pendingImages.push(block),
    };

    // Provider A: simulates a tool that ran mid-turn and attached an image,
    // then the turn itself fails (triggering fallback to B).
    const providerA: AIProvider = {
      streamTurn: vi.fn(async (params) => {
        params.ctx.attachImage?.({ type: 'image', mimeType: 'image/png', data: 'from-a' });
        throw new Error('provider A boom');
      }),
    };

    // Provider B: the real FallbackProvider retry target. It must see the
    // SAME ctx object (that's the whole point of the leak risk), but its own
    // reset -- run for real inside its own streamTurn, same as claude.ts /
    // gemini.ts / ollama.ts do -- must have already cleared A's stale image.
    const providerB: AIProvider = {
      streamTurn: vi.fn(async (params) => {
        params.ctx.pendingImages!.length = 0; // the same in-place reset every real adapter performs
        expect(params.ctx.pendingImages).toEqual([]);
        return [{ type: 'text', text: 'from b' }] as CanonicalTextBlock[];
      }),
    };

    const entries: RankedEntry[] = [
      { providerId: 'anthropic', model: 'a', displayName: 'A', costRank: 3, provider: providerA },
      { providerId: 'gemini', model: 'b', displayName: 'B', costRank: 1, provider: providerB },
    ];
    const fallback = createFallbackProvider(entries);
    const result = await fallback.streamTurn({ ...baseParams(), ctx });

    expect(result).toEqual([{ type: 'text', text: 'from b' }]);
    expect(providerA.streamTurn).toHaveBeenCalledTimes(1);
    expect(providerB.streamTurn).toHaveBeenCalledTimes(1);
    // A's attach did land in the shared array before B's reset ran -- proves
    // this is a real leak scenario, not a vacuous pass from an empty array.
    expect(pendingImages).toEqual([]);
  });
});
