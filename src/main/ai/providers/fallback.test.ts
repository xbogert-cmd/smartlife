import { describe, expect, it, vi } from 'vitest';
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

  it('throws a clear error and calls nothing when the entry list is empty', async () => {
    const fallback = createFallbackProvider([]);
    await expect(fallback.streamTurn(baseParams())).rejects.toThrow(/No AI provider is configured/);
  });
});
