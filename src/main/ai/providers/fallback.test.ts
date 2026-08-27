import { describe, expect, it, vi } from 'vitest';
import type { CanonicalImageBlock } from '../tools/types';
import type { AIProvider, ProviderId, TurnResult } from './types';
import { createFallbackProvider, type RankedEntry } from './fallback';

function fakeProvider(
  behavior: 'succeed' | 'fail',
  text = 'ok',
  providerId: ProviderId = 'anthropic',
  model = 'model'
): AIProvider {
  return {
    streamTurn: vi.fn(async () => {
      if (behavior === 'fail') throw new Error('boom');
      return {
        content: [{ type: 'text', text }],
        usage: { inputTokens: 10, outputTokens: 5 },
        providerId,
        model,
      } satisfies TurnResult;
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
    expect(result.content).toEqual([{ type: 'text', text: 'from top' }]);
    expect(second.streamTurn).not.toHaveBeenCalled();
  });

  it('falls to the next entry at or below the same cost rank when the top fails, and announces it', async () => {
    const top = fakeProvider('fail');
    const second = fakeProvider('succeed', 'from second', 'gemini', 'b');
    const entries: RankedEntry[] = [
      { providerId: 'anthropic', model: 'a', displayName: 'A', costRank: 3, provider: top },
      { providerId: 'gemini', model: 'b', displayName: 'B', costRank: 1, provider: second },
    ];
    const fallback = createFallbackProvider(entries);
    const params = baseParams();
    const result = await fallback.streamTurn(params);
    expect(result.content).toEqual([{ type: 'text', text: 'from second' }]);
    expect(params.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'provider-switched', from: 'A', to: 'B' })
    );
  });

  it('reports the identity of whichever entry actually served the turn, not the starting one', async () => {
    const top = fakeProvider('fail', 'unused', 'anthropic', 'a');
    const second = fakeProvider('succeed', 'from second', 'gemini', 'b');
    const entries: RankedEntry[] = [
      { providerId: 'anthropic', model: 'a', displayName: 'A', costRank: 3, provider: top },
      { providerId: 'gemini', model: 'b', displayName: 'B', costRank: 1, provider: second },
    ];
    const fallback = createFallbackProvider(entries);
    const result = await fallback.streamTurn(baseParams());
    expect(result.providerId).toBe('gemini');
    expect(result.model).toBe('b');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
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
    expect(result.content).toEqual([{ type: 'text', text: 'from cheaper' }]);
    expect(pricier.streamTurn).not.toHaveBeenCalled();
  });

  it('keeps the cost-rank ceiling fixed at the starting entry across multiple hops, not ratcheting down further with each failure', async () => {
    const cheapest = fakeProvider('fail');
    const midTier = fakeProvider('succeed', 'from mid tier');
    const pricier = fakeProvider('fail');
    const entries: RankedEntry[] = [
      { providerId: 'ollama', model: 'llama3.1', displayName: 'Llama 3.1', costRank: 1, provider: cheapest },
      { providerId: 'anthropic', model: 'sonnet', displayName: 'Sonnet', costRank: 3, provider: midTier },
      { providerId: 'anthropic', model: 'opus', displayName: 'Opus', costRank: 5, provider: pricier },
    ];
    const fallback = createFallbackProvider(entries, { pinned: { providerId: 'anthropic', model: 'opus' } });
    const result = await fallback.streamTurn(baseParams());
    expect(result.content).toEqual([{ type: 'text', text: 'from mid tier' }]);
    expect(pricier.streamTurn).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error and calls nothing when the entry list is empty', async () => {
    const fallback = createFallbackProvider([]);
    await expect(fallback.streamTurn(baseParams())).rejects.toThrow(/No AI provider is configured/);
  });

  it("does not leak provider A's stale attached image into provider B's turn via the shared ctx (Finding 2)", async () => {
    const pendingImages: CanonicalImageBlock[] = [];
    const ctx = {
      ...baseParams().ctx,
      pendingImages,
      attachImage: (block: CanonicalImageBlock) => pendingImages.push(block),
    };

    const providerA: AIProvider = {
      streamTurn: vi.fn(async (params) => {
        params.ctx.attachImage?.({ type: 'image', mimeType: 'image/png', data: 'from-a' });
        throw new Error('provider A boom');
      }),
    };

    const providerB: AIProvider = {
      streamTurn: vi.fn(async (params) => {
        params.ctx.pendingImages!.length = 0;
        expect(params.ctx.pendingImages).toEqual([]);
        return {
          content: [{ type: 'text', text: 'from b' }],
          usage: { inputTokens: 1, outputTokens: 1 },
          providerId: 'gemini',
          model: 'b',
        } satisfies TurnResult;
      }),
    };

    const entries: RankedEntry[] = [
      { providerId: 'anthropic', model: 'a', displayName: 'A', costRank: 3, provider: providerA },
      { providerId: 'gemini', model: 'b', displayName: 'B', costRank: 1, provider: providerB },
    ];
    const fallback = createFallbackProvider(entries);
    const result = await fallback.streamTurn({ ...baseParams(), ctx });

    expect(result.content).toEqual([{ type: 'text', text: 'from b' }]);
    expect(providerA.streamTurn).toHaveBeenCalledTimes(1);
    expect(providerB.streamTurn).toHaveBeenCalledTimes(1);
    expect(pendingImages).toEqual([]);
  });
});
