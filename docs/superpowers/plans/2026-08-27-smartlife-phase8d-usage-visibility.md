# Phase 8d: Cost & Usage Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show which provider/model answered each assistant message, and a lifetime running total of token usage and estimated cost per provider+model in Settings.

**Architecture:** `AIProvider.streamTurn` changes its return shape from a bare `CanonicalTextBlock[]` to a `TurnResult` carrying `content`, `usage`, and the `providerId`/`model` that actually served the turn. Each provider adapter fills `providerId`/`model` from its own fixed construction-time values and accumulates `usage` across every round of its internal tool-calling loop. `fallback.ts` needs no logic change — it already forwards whatever the underlying provider returns verbatim, so the correct entry's identity and usage flow through automatically even after a mid-turn fallback. `chatController.ts` persists that identity/usage onto the assistant's stored message row; a new query sums it per provider+model for a Settings table, and a per-message caption reuses the same stored fields.

**Tech Stack:** Electron + React + better-sqlite3 (existing stack, no new dependencies).

## Global Constraints

- Tests run via `npm test` (sets `ELECTRON_RUN_AS_NODE=1`) — never `npx vitest run`.
- No new table. Four new nullable columns on `ai_messages`: `provider text`, `model text`, `input_tokens integer`, `output_tokens integer` — populated only for assistant messages.
- Real per-model `$` pricing (`inputPricePerMTok`/`outputPricePerMTok` on each `CatalogEntry`) must be verified against current Anthropic (`docs.claude.com/en/docs/about-claude/pricing`) and Google (`ai.google.dev/gemini-api/docs/pricing`) pricing pages at implementation time — not guessed. Same rule `catalog.ts` already states for `costRank`.
- Ollama entries are never priced — always $0.00, no pricing fields needed for it (it's never in `CATALOG`, so a pricing lookup miss already means $0 with no special-casing required).
- Usage totals are lifetime cumulative, no date-range filtering, no charts.
- Token counts come from each provider's own reported usage for the turn, summed across every round of a multi-round tool-calling loop, not estimated by counting characters.
- Verified against the installed SDKs at plan time (2026-08-27): Anthropic's `BetaMessage.usage` has non-optional `input_tokens: number` / `output_tokens: number` (`node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts`). Gemini's streamed `GenerateContentResponse.usageMetadata` has optional `promptTokenCount?: number` / `candidatesTokenCount?: number` (`node_modules/@google/genai/dist/node/node.d.ts`) — default to 0 when absent. Ollama's REST API (no installed SDK/types — same hand-rolled-interface precedent this codebase's `OllamaChatChunk` already uses) reports `prompt_eval_count`/`eval_count` on the final `done: true` streamed chunk of `/api/chat`, per Ollama's stable public API.

---

### Task 1: `TurnResult` type and fallback propagation

**Files:**
- Modify: `src/main/ai/providers/types.ts`
- Modify: `src/main/ai/providers/fallback.test.ts`

**Interfaces:**
- Produces: `TurnResult { content: CanonicalTextBlock[]; usage: { inputTokens: number; outputTokens: number }; providerId: ProviderId; model: string }`. `AIProvider.streamTurn(...): Promise<TurnResult>` (changed from `Promise<CanonicalTextBlock[]>`). Tasks 2-4 (each provider adapter) and Task 5 (chatController) consume this.
- Consumes: nothing new.

`fallback.ts` itself needs **no source change** — `return await current.provider.streamTurn(params);` already forwards whatever shape the interface says `streamTurn` returns, whatever that is. Only its test needs updating, since its fake providers construct return values inline and must match the new interface to typecheck.

- [ ] **Step 1: Change the type**

In `src/main/ai/providers/types.ts`, add this new interface (place it right before `export interface AIProvider`):

```ts
export interface TurnResult {
  content: CanonicalTextBlock[];
  usage: { inputTokens: number; outputTokens: number };
  providerId: ProviderId;
  model: string;
}
```

Change `AIProvider.streamTurn`'s return type from `Promise<CanonicalTextBlock[]>` to `Promise<TurnResult>`:

```ts
export interface AIProvider {
  streamTurn(params: {
    system: string;
    history: TurnMessage[];
    userText: string;
    attachments?: CanonicalContentBlock[];
    tools: ToolDefinition[];
    ctx: ToolContext;
    onEvent: (event: StreamEvent) => void;
  }): Promise<TurnResult>;
}
```

At this point `npm run typecheck` will show errors in `claude.ts`, `gemini.ts`, `ollama.ts`, `fallback.test.ts`, and `chatController.ts` — all expected, fixed by Tasks 2-5. This task only fixes `fallback.test.ts`; the rest are picked up by their own tasks.

- [ ] **Step 2: Update fallback.test.ts's fake providers and assertions**

Replace the entire contents of `src/main/ai/providers/fallback.test.ts` with:

```ts
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
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npm test -- fallback.test.ts`
Expected: PASS, all tests including the new `'reports the identity of whichever entry actually served the turn'` test.

- [ ] **Step 4: Commit**

```bash
git add src/main/ai/providers/types.ts src/main/ai/providers/fallback.test.ts
git commit -m "Add TurnResult type carrying usage and serving-provider identity; update fallback tests"
```

---

### Task 2: Claude provider — usage accumulation and identity

**Files:**
- Modify: `src/main/ai/providers/claude.ts`
- Modify: `src/main/ai/providers/claude.test.ts`

**Interfaces:**
- Consumes: `TurnResult` from Task 1.
- Produces: `createClaudeProvider(apiKey, model)`'s `streamTurn` now returns `TurnResult` (`providerId: 'anthropic'`, `model` from its own closure, `usage` summed across every round of the tool-runner loop).

- [ ] **Step 1: Update the failing assertions**

In `src/main/ai/providers/claude.test.ts`, the file's ONLY existing `toBetaTools`-level assertion on a `.run()` result (`describe('screenshot tool results', ...)`, `expect(result).toEqual([...])` and `expect(result).toBe('plain result')`) is checking a *tool's own* return value, not `streamTurn`'s — these do NOT change; leave them exactly as-is.

`claude.test.ts` currently has no test that asserts on `streamTurn`'s own return value at all (every existing `streamTurn` call either ignores the return or only inspects `toolRunner.mock.calls` / `onEvent` calls). This task's new test is the first one to assert on it — added below, no existing assertions need renaming.

Add this new test at the end of the file's `describe('createClaudeProvider', ...)` block:

```ts
describe('createClaudeProvider — usage tracking', () => {
  function fakeMessageStream(finalMessage: {
    content: Array<{ type: 'text'; text: string }>;
    usage: { input_tokens: number; output_tokens: number };
  }) {
    return {
      [Symbol.asyncIterator]: () => (async function* () {})(),
      finalMessage: async () => finalMessage,
    };
  }

  it('reports usage summed across every round the tool runner yields, and the identity it was constructed with', async () => {
    const round1 = fakeMessageStream({
      content: [{ type: 'text', text: '' }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const round2 = fakeMessageStream({
      content: [{ type: 'text', text: 'final answer' }],
      usage: { input_tokens: 130, output_tokens: 15 },
    });
    const toolRunner = vi.fn().mockReturnValue(
      (async function* () {
        yield round1;
        yield round2;
      })()
    );
    vi.mocked(Anthropic).mockReturnValue({ beta: { messages: { toolRunner } } } as never);

    const provider = createClaudeProvider('sk-ant-test', 'claude-sonnet-5');
    const result = await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'hi',
      tools: [],
      ctx: fakeCtx(),
      onEvent: vi.fn(),
    });

    expect(result.content).toEqual([{ type: 'text', text: 'final answer' }]);
    expect(result.usage).toEqual({ inputTokens: 230, outputTokens: 35 });
    expect(result.providerId).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-5');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- claude.test.ts`
Expected: FAIL — `result.content` is `undefined` (current code returns a bare array), and `result.usage` is `undefined`.

- [ ] **Step 3: Implement**

In `src/main/ai/providers/claude.ts`, change the import to include `TurnResult`:

```ts
import { ProviderError, type AIProvider, type CanonicalTextBlock, type StreamEvent, type TurnResult } from './types';
```

Replace the body of `streamTurn` from `let finalText = '';` through the end of the function with:

```ts
      let finalText = '';
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      try {
        for await (const messageStream of runner) {
          for await (const event of messageStream) {
            if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
              const toolName = event.content_block.name;
              const toolLabel = toolLabels.get(toolName) ?? toolName;
              onEvent({ type: 'tool-status', toolName, toolLabel } satisfies StreamEvent);
            }
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              onEvent({ type: 'text-delta', text: event.delta.text } satisfies StreamEvent);
            }
          }
          const finalMessage = await messageStream.finalMessage();
          finalText = finalMessage.content
            .filter((block): block is Anthropic.Beta.Messages.BetaTextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('');
          totalInputTokens += finalMessage.usage.input_tokens;
          totalOutputTokens += finalMessage.usage.output_tokens;
        }
      } catch (error) {
        const message = describeError(error);
        throw message !== null ? new ProviderError(message) : error;
      }

      onEvent({ type: 'turn-complete' } satisfies StreamEvent);
      return {
        content: [{ type: 'text', text: finalText }],
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        providerId: 'anthropic',
        model,
      } satisfies TurnResult;
```

(`CanonicalTextBlock` stays imported and used inside the `content` array's type; the function's own return type is now inferred as `Promise<TurnResult>` via the `AIProvider` interface, matching Task 1.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- claude.test.ts`
Expected: PASS, all tests.

Run: `npm run typecheck`
Expected: `claude.ts` no longer appears in the error list (errors in `gemini.ts`/`ollama.ts`/`chatController.ts` are still expected until their own tasks).

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/providers/claude.ts src/main/ai/providers/claude.test.ts
git commit -m "Claude provider: return TurnResult with usage summed across tool-loop rounds"
```

---

### Task 3: Gemini provider — usage accumulation and identity

**Files:**
- Modify: `src/main/ai/providers/gemini.ts`
- Modify: `src/main/ai/providers/gemini.test.ts`

**Interfaces:**
- Consumes: `TurnResult` from Task 1.
- Produces: `createGeminiProvider(apiKey, model)`'s `streamTurn` now returns `TurnResult` (`providerId: 'gemini'`).

- [ ] **Step 1: Update the failing assertions and helper type**

In `src/main/ai/providers/gemini.test.ts`, the top-of-file `fakeStream` helper's chunk parameter type gains an optional `usageMetadata` field:

```ts
function fakeStream(
  chunks: Array<{
    text?: string;
    functionCalls?: Array<{ name: string; args: Record<string, unknown> }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  }>
) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}
```

Every existing `expect(result).toEqual([{ type: 'text', ... }])` becomes `expect(result.content).toEqual([{ type: 'text', ... }])`. There are four occurrences — in `'streams text and returns it as a canonical text block when no tools are called'`, `'runs a called tool and sends its result back before producing the final answer'`, `'stops at MAX_ROUNDS instead of looping forever against a model that keeps calling tools'`, and one further down the file in a screenshot/vision-related test (search the whole file for `expect(result).toEqual` to find all four — do not assume line numbers, they may have shifted).

Add this new test to the `describe('createGeminiProvider — streamTurn tool-calling loop', ...)` block:

```ts
  it('reports usage summed across every round of a multi-round function-calling turn', async () => {
    const tool: import('../tools/types').ToolDefinition = {
      name: 'get_weather',
      tier: 'READ',
      label: 'Get weather',
      schema: { name: 'get_weather', description: 'd', input_schema: { type: 'object', properties: {} } },
      run: async () => 'Sunny, 72F',
    };
    const sendMessageStream = vi
      .fn()
      .mockResolvedValueOnce(
        fakeStream([
          { functionCalls: [{ name: 'get_weather', args: { city: 'Tokyo' } }] },
          { usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 10 } },
        ])
      )
      .mockResolvedValueOnce(
        fakeStream([
          { text: 'It is sunny.' },
          { usageMetadata: { promptTokenCount: 95, candidatesTokenCount: 12 } },
        ])
      );
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    vi.mocked(GoogleGenAI).mockReturnValue({ chats: { create } } as never);

    const provider = createGeminiProvider('test-key', 'gemini-2.5-flash');
    const result = await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'weather?',
      tools: [tool],
      ctx: fakeCtx(),
      onEvent: vi.fn(),
    });

    expect(result.content).toEqual([{ type: 'text', text: 'It is sunny.' }]);
    expect(result.usage).toEqual({ inputTokens: 175, outputTokens: 22 });
    expect(result.providerId).toBe('gemini');
    expect(result.model).toBe('gemini-2.5-flash');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- gemini.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/main/ai/providers/gemini.ts`, add `TurnResult` to the type import:

```ts
import {
  ProviderError,
  type AIProvider,
  type CanonicalContentBlock,
  type CanonicalTextBlock,
  type StreamEvent,
  type TurnMessage,
  type TurnResult,
} from './types';
```

Inside `streamTurn`, add token accumulators next to `let finalText = '';`:

```ts
      let finalText = '';
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
```

Inside the `for await (const chunk of stream)` loop, accumulate from each chunk's `usageMetadata` (optional fields — default to 0, and since Gemini reports CUMULATIVE totals for the round on its later chunks, only the LAST seen value per round should count, not a running sum within the round — track "this round's usage" separately from the running cross-round total):

```ts
          let roundText = '';
          let roundInputTokens = 0;
          let roundOutputTokens = 0;
          const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

          for await (const chunk of stream) {
            if (chunk.text) {
              onEvent({ type: 'text-delta', text: chunk.text } satisfies StreamEvent);
              roundText += chunk.text;
            }
            for (const call of chunk.functionCalls ?? []) {
              if (call.name) functionCalls.push({ name: call.name, args: call.args ?? {} });
            }
            if (chunk.usageMetadata) {
              roundInputTokens = chunk.usageMetadata.promptTokenCount ?? 0;
              roundOutputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
            }
          }

          finalText = roundText;
          totalInputTokens += roundInputTokens;
          totalOutputTokens += roundOutputTokens;
```

(This replaces the existing `let roundText = ''; const functionCalls: ... = [];` declaration and the existing `for await (const chunk of stream) { ... }` loop body — read the current file to place this precisely; everything after `finalText = roundText;` in the existing code, i.e. the `if (functionCalls.length === 0) break;` line onward, stays exactly as-is, unchanged.)

Replace the final return statement:

```ts
      onEvent({ type: 'turn-complete' } satisfies StreamEvent);
      return {
        content: [{ type: 'text', text: finalText }],
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        providerId: 'gemini',
        model,
      } satisfies TurnResult;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- gemini.test.ts`
Expected: PASS, all tests.

Run: `npm run typecheck`
Expected: `gemini.ts` no longer appears in the error list.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/providers/gemini.ts src/main/ai/providers/gemini.test.ts
git commit -m "Gemini provider: return TurnResult with usage summed across function-calling rounds"
```

---

### Task 4: Ollama provider — usage accumulation and identity

**Files:**
- Modify: `src/main/ai/providers/ollama.ts`
- Modify: `src/main/ai/providers/ollama.test.ts`

**Interfaces:**
- Consumes: `TurnResult` from Task 1.
- Produces: `createOllamaProvider(endpoint, model)`'s `streamTurn` now returns `TurnResult` (`providerId: 'ollama'`).

- [ ] **Step 1: Update the failing assertions**

In `src/main/ai/providers/ollama.test.ts`, every `expect(result).toEqual([{ type: 'text', ... }])` becomes `expect(result.content).toEqual([{ type: 'text', ... }])`. There are four occurrences — in `'streams text and returns it as a canonical text block when no tools are called'`, `'runs a called tool and sends its result back before producing the final answer'`, `'correctly reassembles an NDJSON line that arrives split across two stream reads'`, and one further down the file in a screenshot/vision-related test (search the whole file for `expect(result).toEqual` to find all four — do not assume line numbers, they may have shifted).

Add this new test to the `describe('createOllamaProvider', ...)` block, using the file's existing `ndjsonResponse(lines: object[])` helper unchanged (it already accepts arbitrary extra fields on each line object):

```ts
  it('reports usage from the final done:true chunk of each round, summed across multiple rounds', async () => {
    const tool: ToolDefinition = {
      name: 'get_weather',
      tier: 'READ',
      label: 'Get weather',
      schema: { name: 'get_weather', description: 'd', input_schema: { type: 'object', properties: {} } },
      run: async () => 'Sunny, 72F',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        ndjsonResponse([
          {
            message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: {} } }] },
            done: true,
            prompt_eval_count: 50,
            eval_count: 8,
          },
        ])
      )
      .mockResolvedValueOnce(
        ndjsonResponse([
          { message: { role: 'assistant', content: 'It is sunny.' }, done: true, prompt_eval_count: 65, eval_count: 9 },
        ])
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOllamaProvider('http://localhost:11434', 'llama3.1');
    const result = await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'weather?',
      tools: [tool],
      ctx: fakeCtx(),
      onEvent: vi.fn(),
    });

    expect(result.content).toEqual([{ type: 'text', text: 'It is sunny.' }]);
    expect(result.usage).toEqual({ inputTokens: 115, outputTokens: 17 });
    expect(result.providerId).toBe('ollama');
    expect(result.model).toBe('llama3.1');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ollama.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/main/ai/providers/ollama.ts`, add `TurnResult` to the type import:

```ts
import { ProviderError, type AIProvider, type CanonicalContentBlock, type CanonicalTextBlock, type StreamEvent, type TurnMessage, type TurnResult } from './types';
```

Extend the `OllamaChatChunk` interface with the two usage fields (only present on the final `done: true` chunk):

```ts
interface OllamaChatChunk {
  message: OllamaMessage;
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}
```

Change `readChatStream`'s return type and body to also capture usage from whichever chunk has `done: true`:

```ts
async function readChatStream(
  response: Response,
  onTextDelta: (text: string) => void
): Promise<{ content: string; toolCalls: OllamaMessage['tool_calls']; usage: { inputTokens: number; outputTokens: number } }> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError('Ollama returned no response body.');
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let toolCalls: OllamaMessage['tool_calls'];
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const chunk = JSON.parse(line) as OllamaChatChunk;
      if (chunk.message.content) {
        onTextDelta(chunk.message.content);
        content += chunk.message.content;
      }
      if (chunk.message.tool_calls && chunk.message.tool_calls.length > 0) {
        toolCalls = chunk.message.tool_calls;
      }
      if (chunk.done) {
        inputTokens = chunk.prompt_eval_count ?? 0;
        outputTokens = chunk.eval_count ?? 0;
      }
    }
  }

  return { content, toolCalls, usage: { inputTokens, outputTokens } };
}
```

Inside `streamTurn`, add accumulators next to `let finalText = '';`:

```ts
      let finalText = '';
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
```

Where the code currently does:

```ts
          const { content, toolCalls } = await readChatStream(response, (text) => {
            onEvent({ type: 'text-delta', text } satisfies StreamEvent);
          });
          finalText = content;
          messages.push({ role: 'assistant', content });
```

change to:

```ts
          const { content, toolCalls, usage } = await readChatStream(response, (text) => {
            onEvent({ type: 'text-delta', text } satisfies StreamEvent);
          });
          finalText = content;
          totalInputTokens += usage.inputTokens;
          totalOutputTokens += usage.outputTokens;
          messages.push({ role: 'assistant', content });
```

Replace the final return statement:

```ts
      onEvent({ type: 'turn-complete' } satisfies StreamEvent);
      return {
        content: [{ type: 'text', text: finalText }],
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        providerId: 'ollama',
        model,
      } satisfies TurnResult;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ollama.test.ts`
Expected: PASS, all tests.

Run: `npm run typecheck`
Expected: `ollama.ts` no longer appears in the error list (only `chatController.ts` remains, fixed by Task 5).

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/providers/ollama.ts src/main/ai/providers/ollama.test.ts
git commit -m "Ollama provider: return TurnResult with usage from the final done:true chunk, summed across rounds"
```

---

### Task 5: Persist usage/identity — conversation.ts and chatController.ts

**Files:**
- Modify: `src/main/ai/conversation.ts`
- Modify: `src/main/ai/conversation.test.ts`
- Modify: `src/main/ai/chatController.ts`
- Modify: `src/main/ai/chatController.test.ts`

**Interfaces:**
- Consumes: `TurnResult` from Tasks 2-4 (via `provider.streamTurn`'s new return shape).
- Produces: `appendMessage(db, conversationId, role, content, meta?)` — `meta` is a new optional 5th param, `{ providerId: string; model: string; inputTokens: number; outputTokens: number }`, only meaningful for `role: 'assistant'`. `getUsageSummary(db): UsageRow[]` — new function, `UsageRow { providerId: string; model: string; displayName: string; inputTokens: number; outputTokens: number; estimatedCostUsd: number }`. Task 6 (IPC) consumes `getUsageSummary`; `chatController.ts` consumes `appendMessage`'s new `meta` param.

- [ ] **Step 1: Write the failing tests for conversation.ts**

Add to `src/main/ai/conversation.test.ts`, in a new `describe` block after the existing ones:

```ts
describe('usage tracking', () => {
  it('appendMessage stores provider/model/token columns only when meta is given', async () => {
    const { createConversation, appendMessage } = await import('./conversation');
    const db = makeDb();
    const id = createConversation(db);
    appendMessage(db, id, 'user', [{ type: 'text', text: 'hi' }]);
    appendMessage(db, id, 'assistant', [{ type: 'text', text: 'hello' }], {
      providerId: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 12,
      outputTokens: 34,
    });
    const rows = db
      .prepare('select role, provider, model, input_tokens, output_tokens from ai_messages order by created_at')
      .all() as Array<{ role: string; provider: string | null; model: string | null; input_tokens: number | null; output_tokens: number | null }>;
    expect(rows[0]).toEqual({ role: 'user', provider: null, model: null, input_tokens: null, output_tokens: null });
    expect(rows[1]).toEqual({ role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-5', input_tokens: 12, output_tokens: 34 });
  });

  it('getUsageSummary sums tokens grouped by provider and model, computing estimated cost', async () => {
    const { createConversation, appendMessage, getUsageSummary } = await import('./conversation');
    const db = makeDb();
    const id = createConversation(db);
    appendMessage(db, id, 'assistant', [{ type: 'text', text: 'a' }], {
      providerId: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    appendMessage(db, id, 'assistant', [{ type: 'text', text: 'b' }], {
      providerId: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 500_000,
      outputTokens: 500_000,
    });
    const summary = getUsageSummary(db);
    expect(summary).toHaveLength(1);
    expect(summary[0].providerId).toBe('anthropic');
    expect(summary[0].model).toBe('claude-haiku-4-5-20251001');
    expect(summary[0].inputTokens).toBe(1_500_000);
    expect(summary[0].outputTokens).toBe(1_500_000);
    expect(summary[0].displayName).toBe('Claude Haiku 4.5');
    expect(summary[0].estimatedCostUsd).toBeGreaterThan(0);
  });

  it('getUsageSummary reports $0 for a provider/model not in the static catalog (e.g. Ollama)', async () => {
    const { createConversation, appendMessage, getUsageSummary } = await import('./conversation');
    const db = makeDb();
    const id = createConversation(db);
    appendMessage(db, id, 'assistant', [{ type: 'text', text: 'a' }], {
      providerId: 'ollama',
      model: 'llama3.1',
      inputTokens: 10_000,
      outputTokens: 10_000,
    });
    const summary = getUsageSummary(db);
    expect(summary).toEqual([
      { providerId: 'ollama', model: 'llama3.1', displayName: 'llama3.1', inputTokens: 10_000, outputTokens: 10_000, estimatedCostUsd: 0 },
    ]);
  });

  it('getUsageSummary returns an empty list when nothing has ever answered', async () => {
    const { getUsageSummary } = await import('./conversation');
    const db = makeDb();
    expect(getUsageSummary(db)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- conversation.test.ts`
Expected: FAIL — `appendMessage` doesn't accept a 5th argument, `ai_messages` has no `provider`/`model`/`input_tokens`/`output_tokens` columns, `getUsageSummary` isn't exported.

- [ ] **Step 3: Implement conversation.ts**

In `src/main/ai/conversation.test.ts`'s own `makeDb()` (and every other test file's inline schema for `ai_messages` used across this codebase — see Step 3b below), the `ai_messages` table definition needs the four new columns. First, update the real migration.

Create `src/main/db/migrations/0008_ai_usage.sql`:

```sql
alter table ai_messages add column provider text;
alter table ai_messages add column model text;
alter table ai_messages add column input_tokens integer;
alter table ai_messages add column output_tokens integer;
```

In `src/main/ai/conversation.ts`, add `findCatalogEntry` and `CATALOG` imports:

```ts
import { CATALOG, findCatalogEntry } from './providers/catalog';
```

Replace `appendMessage`:

```ts
export function appendMessage(
  db: Database.Database,
  conversationId: string,
  role: 'user' | 'assistant',
  content: unknown[],
  meta?: { providerId: string; model: string; inputTokens: number; outputTokens: number }
): void {
  db.prepare(
    'insert into ai_messages (id, conversation_id, role, content, provider, model, input_tokens, output_tokens) values (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    randomUUID(),
    conversationId,
    role,
    JSON.stringify(content),
    meta?.providerId ?? null,
    meta?.model ?? null,
    meta?.inputTokens ?? null,
    meta?.outputTokens ?? null
  );
  db.prepare("update ai_conversations set updated_at = datetime('now') where id = ?").run(conversationId);
}
```

Add, after `appendMessage`:

```ts
export interface UsageRow {
  providerId: string;
  model: string;
  displayName: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export function getUsageSummary(db: Database.Database): UsageRow[] {
  const rows = db
    .prepare(
      `select provider, model, sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens
       from ai_messages
       where provider is not null
       group by provider, model`
    )
    .all() as Array<{ provider: string; model: string; input_tokens: number; output_tokens: number }>;

  return rows.map((row) => {
    const catalogEntry = CATALOG.find((entry) => entry.providerId === row.provider && entry.model === row.model);
    const inputPrice = catalogEntry?.inputPricePerMTok ?? 0;
    const outputPrice = catalogEntry?.outputPricePerMTok ?? 0;
    const estimatedCostUsd =
      (row.input_tokens / 1_000_000) * inputPrice + (row.output_tokens / 1_000_000) * outputPrice;
    return {
      providerId: row.provider,
      model: row.model,
      displayName: catalogEntry?.displayName ?? row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      estimatedCostUsd,
    };
  });
}
```

(`findCatalogEntry` isn't actually used above — `CATALOG.find(...)` is used directly since `findCatalogEntry`'s own signature takes a typed `ProviderId`, and `row.provider` here is a plain `string` from the DB. Remove the unused `findCatalogEntry` import — only import `CATALOG`: `import { CATALOG } from './providers/catalog';`.)

- [ ] **Step 3b: Add pricing fields to CatalogEntry**

In `src/main/ai/providers/catalog.ts`, add two new fields to the `CatalogEntry` interface:

```ts
export interface CatalogEntry {
  providerId: 'anthropic' | 'gemini';
  model: string;
  displayName: string;
  costRank: number;
  supportsWebSearch: boolean;
  supportsVision: boolean;
  /** USD per 1,000,000 input tokens. Verified against
   *  docs.claude.com/en/docs/about-claude/pricing and
   *  ai.google.dev/gemini-api/docs/pricing at plan time (2026-08-27) --
   *  re-verify before adjusting, same rule as costRank. */
  inputPricePerMTok: number;
  /** USD per 1,000,000 output tokens. Same verification rule as above. */
  outputPricePerMTok: number;
}
```

Add `inputPricePerMTok`/`outputPricePerMTok` to every existing `CATALOG` entry. **Verify these exact numbers against the live pricing pages at implementation time** — do not carry these placeholder-free-but-unverified values forward without checking:

```ts
export const CATALOG: CatalogEntry[] = [
  {
    providerId: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5',
    costRank: 1,
    supportsWebSearch: false,
    supportsVision: true,
    inputPricePerMTok: 1.0,
    outputPricePerMTok: 5.0,
  },
  {
    providerId: 'gemini',
    model: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    costRank: 1,
    supportsWebSearch: true,
    supportsVision: true,
    inputPricePerMTok: 0.3,
    outputPricePerMTok: 2.5,
  },
  {
    providerId: 'anthropic',
    model: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    costRank: 3,
    supportsWebSearch: true,
    supportsVision: true,
    inputPricePerMTok: 3.0,
    outputPricePerMTok: 15.0,
  },
  {
    providerId: 'gemini',
    model: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    costRank: 3,
    supportsWebSearch: true,
    supportsVision: true,
    inputPricePerMTok: 1.25,
    outputPricePerMTok: 10.0,
  },
  {
    providerId: 'anthropic',
    model: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    costRank: 5,
    supportsWebSearch: true,
    supportsVision: true,
    inputPricePerMTok: 5.0,
    outputPricePerMTok: 25.0,
  },
];
```

Add a test to `src/main/ai/providers/catalog.test.ts` (read the file first for its existing style/imports) asserting every entry has positive `inputPricePerMTok`/`outputPricePerMTok`:

```ts
  it('every catalog entry has a positive price per million tokens for both input and output', () => {
    for (const entry of CATALOG) {
      expect(entry.inputPricePerMTok).toBeGreaterThan(0);
      expect(entry.outputPricePerMTok).toBeGreaterThan(0);
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- conversation.test.ts`
Run: `npm test -- catalog.test.ts`
Expected: PASS. If `conversation.test.ts` still fails because its inline `AI_CORE_SQL`/`makeDb()` schema doesn't include the new columns, add them there too — every test file across this codebase that inlines the `ai_messages` schema (`conversation.test.ts`, `chatController.test.ts`, `ipc.test.ts`) needs `provider text, model text, input_tokens integer, output_tokens integer` added to its `create table ai_messages (...)` string. Do this now for `conversation.test.ts`; Steps 5-6 below handle `chatController.test.ts`.

- [ ] **Step 5: Write the failing test for chatController.ts**

Add to `src/main/ai/chatController.test.ts`, inside the existing `describe('handleSendMessage', ...)` block. First, update the file's `AI_CORE_SQL` constant (near the top) to include the four new columns:

```ts
const AI_CORE_SQL = `
create table ai_conversations (id text primary key, title text, created_at text not null default (datetime('now')), updated_at text not null default (datetime('now')));
create table ai_messages (id text primary key, conversation_id text not null references ai_conversations(id) on delete cascade, role text not null, content text not null, provider text, model text, input_tokens integer, output_tokens integer, created_at text not null default (datetime('now')));
`;
```

Every existing `AIProvider`/mock `streamTurn` in this file that resolves a bare array (e.g. `vi.fn().mockResolvedValue([{ type: 'text', text: 'Hi there!' }])`) needs updating to resolve a full `TurnResult`. Read the file and update EVERY such mock — there are several across the `handleSendMessage`, `system prompt`, and `attachments` describe blocks. Each becomes, e.g.:

```ts
vi.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'Hi there!' }],
  usage: { inputTokens: 1, outputTokens: 1 },
  providerId: 'anthropic',
  model: 'claude-sonnet-5',
})
```

(keep each test's original `text` value, just wrap it in this shape — the exact `usage`/`providerId`/`model` values don't matter for tests that aren't specifically about persistence, so use the same placeholder `{ inputTokens: 1, outputTokens: 1 }` / `'anthropic'` / `'claude-sonnet-5'` throughout unless a specific test needs different values).

Add a new test verifying persistence:

```ts
  it('persists the serving provider/model and token usage onto the assistant message row', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const conversationId = await makeConversation(db);
    const window = fakeWindow();
    const provider: AIProvider = {
      streamTurn: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { inputTokens: 42, outputTokens: 17 },
        providerId: 'gemini',
        model: 'gemini-2.5-pro',
      }),
    };
    await handleSendMessage(db, () => window as never, 'hi', null, conversationId, { provider });

    const row = db
      .prepare('select provider, model, input_tokens, output_tokens from ai_messages where role = ?')
      .get('assistant') as { provider: string; model: string; input_tokens: number; output_tokens: number };
    expect(row).toEqual({ provider: 'gemini', model: 'gemini-2.5-pro', input_tokens: 42, output_tokens: 17 });
  });
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- chatController.test.ts`
Expected: FAIL — every existing test that mocked `streamTurn` with a bare array now sees `finalResult.content` as `undefined`, and the new persistence test finds no `provider`/`model` columns populated.

- [ ] **Step 7: Implement chatController.ts**

In `src/main/ai/chatController.ts`, replace:

```ts
      const finalContent = await provider.streamTurn({
        system: buildSystemPrompt(db, view),
        history,
        userText,
        attachments: attachments.length > 0 ? attachments : undefined,
        tools: TOOLS,
        ctx,
        onEvent: send,
      });
      const userContent: CanonicalContentBlock[] = [
        { type: 'text', text: userText },
        ...persistedTextBlocks,
        ...(imagePlaceholders.length > 0 ? [{ type: 'text' as const, text: imagePlaceholders.join('\n') }] : []),
      ];
      appendMessage(db, conversationId, 'user', userContent);
      setConversationTitleIfUnset(db, conversationId, userText);
      appendMessage(db, conversationId, 'assistant', finalContent);
```

with:

```ts
      const result = await provider.streamTurn({
        system: buildSystemPrompt(db, view),
        history,
        userText,
        attachments: attachments.length > 0 ? attachments : undefined,
        tools: TOOLS,
        ctx,
        onEvent: send,
      });
      const userContent: CanonicalContentBlock[] = [
        { type: 'text', text: userText },
        ...persistedTextBlocks,
        ...(imagePlaceholders.length > 0 ? [{ type: 'text' as const, text: imagePlaceholders.join('\n') }] : []),
      ];
      appendMessage(db, conversationId, 'user', userContent);
      setConversationTitleIfUnset(db, conversationId, userText);
      appendMessage(db, conversationId, 'assistant', result.content, {
        providerId: result.providerId,
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test -- chatController.test.ts`
Expected: PASS, all tests.

Run: `npm run typecheck`
Expected: `chatController.ts` no longer appears in the error list.

- [ ] **Step 9: Commit**

```bash
git add src/main/db/migrations/0008_ai_usage.sql src/main/ai/conversation.ts src/main/ai/conversation.test.ts src/main/ai/chatController.ts src/main/ai/chatController.test.ts src/main/ai/providers/catalog.ts src/main/ai/providers/catalog.test.ts
git commit -m "Persist serving-provider identity and token usage per assistant message; add getUsageSummary"
```

---

### Task 6: IPC surface and preload for usage summary

**Files:**
- Modify: `src/main/ai/ipc.ts`
- Modify: `src/main/ai/ipc.test.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: `getUsageSummary` from Task 5.
- Produces: IPC channel `ai:get-usage-summary`; preload method `getUsageSummary(): Promise<UsageRow[]>`. Also: `ai:get-history`'s returned message shape gains `providerId`/`model` (already stored per-row since Task 5, just not yet returned). Task 7 (Settings UI) and Task 8 (per-message tag) consume these.

- [ ] **Step 1: Write the failing test**

Add to `src/main/ai/ipc.test.ts`, after the existing `describe('conversation lifecycle IPC handlers', ...)` block. First, update this file's inline `AI_CORE_SQL`/`ai_messages` schema (in its `makeDb()` function near the top) to include the four new columns, matching Task 5's pattern:

```ts
  db.exec(
    `create table ai_messages (id text primary key, conversation_id text not null references ai_conversations(id) on delete cascade, role text not null, content text not null, provider text, model text, input_tokens integer, output_tokens integer, created_at text not null default (datetime('now')));`
  );
```

(Read the file's current `makeDb()` to find and replace its exact existing `ai_messages` line.)

`ipc.test.ts`'s `setup()` constructs its own in-memory db internally without exposing it to the test, so the simplest, most direct way to verify this handler is a thin delegation is to mock `./conversation`'s `getUsageSummary` export the same way this file already mocks `./router` and `./attachments/pickAttachment`. Add this `vi.mock` call near the top of the file, alongside those two existing ones:

```ts
vi.mock('./conversation', async () => {
  const actual = await vi.importActual<typeof import('./conversation')>('./conversation');
  return { ...actual, getUsageSummary: vi.fn() };
});
```

Then add:

```ts
describe('ai:get-usage-summary', () => {
  it('delegates to conversation.getUsageSummary and returns its result', async () => {
    const { getUsageSummary } = await import('./conversation');
    vi.mocked(getUsageSummary).mockReturnValue([
      { providerId: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001 },
    ]);
    const { call } = await setup();
    const result = await call('ai:get-usage-summary');
    expect(result).toEqual([
      { providerId: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ipc.test.ts`
Expected: FAIL — `ai:get-usage-summary` is not a registered handler.

- [ ] **Step 3: Implement**

In `src/main/ai/ipc.ts`, change the import line to include `getUsageSummary`:

```ts
import { getMessages, createConversation, listConversations, renameConversation, deleteConversation, getUsageSummary } from './conversation';
```

Add, after the `ai:delete-conversation` handler:

```ts
  ipcMain.handle('ai:get-usage-summary', () => getUsageSummary(db));
```

Change the `ai:get-history` handler to also return `providerId`/`model` per message:

```ts
  ipcMain.handle('ai:get-history', (_event, conversationId: string) => {
    return getMessages(db, conversationId).map((m) => ({
      role: m.role,
      content: JSON.parse(m.content),
      providerId: m.providerId,
      model: m.model,
    }));
  });
```

This requires `getMessages`'s returned `StoredMessage` to actually carry `providerId`/`model` — check `conversation.ts`'s `StoredMessage` interface and `getMessages` function (read the current file first): add `providerId: string | null` and `model: string | null` to `StoredMessage`, select the two new columns in `getMessages`'s query, and map them onto the returned objects. Since this is a small addition to a function Task 5 already touched, make it here as part of this task (not a new task) — read `conversation.ts`'s current `getMessages` and `StoredMessage` and update them:

```ts
export interface StoredMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  providerId: string | null;
  model: string | null;
  createdAt: string;
}
```

```ts
export function getMessages(db: Database.Database, conversationId: string): StoredMessage[] {
  const rows = db
    .prepare(
      'select id, conversation_id, role, content, provider, model, created_at from ai_messages where conversation_id = ? order by created_at, rowid'
    )
    .all(conversationId) as Array<{
    id: string;
    conversation_id: string;
    role: string;
    content: string;
    provider: string | null;
    model: string | null;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as 'user' | 'assistant',
    content: row.content,
    providerId: row.provider,
    model: row.model,
    createdAt: row.created_at,
  }));
}
```

In `src/preload/index.ts`, add `providerId`/`model` to the `AiMessage` interface:

```ts
interface AiMessage {
  role: 'user' | 'assistant';
  content: unknown;
  providerId: string | null;
  model: string | null;
}
```

Add a `UsageRow` interface and the `getUsageSummary` method to the `ai: { ... }` object (immediately after `deleteConversation`):

```ts
interface UsageRow {
  providerId: string;
  model: string;
  displayName: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}
```

```ts
    getUsageSummary: (): Promise<UsageRow[]> => ipcRenderer.invoke('ai:get-usage-summary'),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- ipc.test.ts`
Run: `npm test -- conversation.test.ts` (re-run to confirm the `getMessages`/`StoredMessage` change doesn't break its existing tests — its `messages[0].role`/`.content` assertions are unaffected by adding two new fields)
Expected: PASS.

Run: `npm run typecheck`
Expected: clean, project-wide (this was the last main-process piece; only renderer-side pieces in Tasks 7-8 remain, which don't exist yet so can't be "broken").

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/ipc.ts src/main/ai/ipc.test.ts src/main/ai/conversation.ts src/preload/index.ts
git commit -m "Add ai:get-usage-summary IPC channel; get-history and getMessages now include providerId/model per message"
```

---

### Task 7: Settings usage table

**Files:**
- Create: `src/renderer/src/routes/settings/UsageSection.tsx`
- Create: `src/renderer/src/routes/settings/UsageSection.test.tsx`
- Modify: `src/renderer/src/routes/Settings.tsx`

**Interfaces:**
- Consumes: `window.smartlife.ai.getUsageSummary()` from Task 6.
- Produces: `<UsageSection>` component, rendered in `Settings.tsx` alongside `<AIProvidersSection>`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/routes/settings/UsageSection.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { UsageSection } from './UsageSection';

beforeEach(() => {
  Object.defineProperty(window, 'smartlife', {
    value: { ai: { getUsageSummary: vi.fn() } },
    writable: true,
    configurable: true,
  });
});

describe('UsageSection', () => {
  it('renders one row per provider/model with tokens and estimated cost', async () => {
    (window.smartlife.ai.getUsageSummary as ReturnType<typeof vi.fn>).mockResolvedValue([
      { providerId: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', inputTokens: 1500, outputTokens: 500, estimatedCostUsd: 0.012 },
      { providerId: 'ollama', model: 'llama3.1', displayName: 'llama3.1', inputTokens: 10000, outputTokens: 8000, estimatedCostUsd: 0 },
    ]);
    render(<UsageSection />);

    expect(await screen.findByText('Claude Sonnet 5')).toBeInTheDocument();
    expect(screen.getByText('1,500')).toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();
    expect(screen.getByText('$0.012')).toBeInTheDocument();
    expect(screen.getByText('llama3.1')).toBeInTheDocument();
    expect(screen.getByText('$0.000')).toBeInTheDocument();
  });

  it('shows a totals row summing estimated cost across all providers', async () => {
    (window.smartlife.ai.getUsageSummary as ReturnType<typeof vi.fn>).mockResolvedValue([
      { providerId: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', inputTokens: 1000, outputTokens: 1000, estimatedCostUsd: 0.01 },
      { providerId: 'gemini', model: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokens: 1000, outputTokens: 1000, estimatedCostUsd: 0.02 },
    ]);
    render(<UsageSection />);

    await waitFor(() => expect(screen.getByText('Total')).toBeInTheDocument());
    expect(screen.getByText('$0.030')).toBeInTheDocument();
  });

  it('shows nothing has been used yet when the summary is empty', async () => {
    (window.smartlife.ai.getUsageSummary as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    render(<UsageSection />);

    expect(await screen.findByText('No usage yet.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- UsageSection.test.tsx`
Expected: FAIL — `./UsageSection` does not exist yet.

- [ ] **Step 3: Implement**

Create `src/renderer/src/routes/settings/UsageSection.tsx`:

```tsx
import { useEffect, useState } from 'react';

interface UsageRow {
  providerId: string;
  model: string;
  displayName: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

function formatTokens(n: number): string {
  return n.toLocaleString();
}

function formatCost(n: number): string {
  return `$${n.toFixed(3)}`;
}

export function UsageSection() {
  const [rows, setRows] = useState<UsageRow[] | null>(null);

  useEffect(() => {
    window.smartlife.ai
      .getUsageSummary()
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  const totalCost = (rows ?? []).reduce((sum, row) => sum + row.estimatedCostUsd, 0);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
        Usage
      </h2>
      {rows === null ? null : rows.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>No usage yet.</p>
      ) : (
        <table className="w-full text-sm" style={{ color: 'var(--color-text)' }}>
          <thead>
            <tr style={{ color: 'var(--color-text-muted)' }}>
              <th className="pb-1 text-left font-normal">Model</th>
              <th className="pb-1 text-right font-normal">Input tokens</th>
              <th className="pb-1 text-right font-normal">Output tokens</th>
              <th className="pb-1 text-right font-normal">Est. cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.providerId}:${row.model}`} style={{ borderTop: '1px solid var(--color-border)' }}>
                <td className="py-1">{row.displayName}</td>
                <td className="py-1 text-right">{formatTokens(row.inputTokens)}</td>
                <td className="py-1 text-right">{formatTokens(row.outputTokens)}</td>
                <td className="py-1 text-right">{formatCost(row.estimatedCostUsd)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: '1px solid var(--color-border)', fontWeight: 600 }}>
              <td className="py-1">Total</td>
              <td className="py-1" />
              <td className="py-1" />
              <td className="py-1 text-right">{formatCost(totalCost)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}
```

In `src/renderer/src/routes/Settings.tsx`: read the file first to find where `<AIProvidersSection />` is rendered (import line and JSX usage). Add the import:

```tsx
import { UsageSection } from './settings/UsageSection';
```

Add `<UsageSection />` immediately after `<AIProvidersSection />` in the rendered JSX.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- UsageSection.test.tsx`
Run: `npm test -- Settings.test.tsx`
Expected: PASS. If `Settings.test.tsx` fails because its mock `window.smartlife.ai` object is missing `getUsageSummary`, add `getUsageSummary: vi.fn().mockResolvedValue([])` to its existing mock object (read the file first to find the exact mock structure and match its style).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/routes/settings/UsageSection.tsx src/renderer/src/routes/settings/UsageSection.test.tsx src/renderer/src/routes/Settings.tsx src/renderer/src/routes/Settings.test.tsx
git commit -m "Add Settings usage table: tokens and estimated cost per provider/model, lifetime totals"
```

---

### Task 8: Per-message "answered by" caption

**Files:**
- Modify: `src/renderer/src/ai/useConversation.ts`
- Modify: `src/renderer/src/ai/useConversation.test.ts`
- Modify: `src/renderer/src/ai/ChatPanel.tsx`
- Modify: `src/renderer/src/ai/ChatPanel.test.tsx`

**Interfaces:**
- Consumes: `ai:get-history`'s `providerId`/`model` fields (Task 6), `window.smartlife.ai.getCatalog()` (pre-existing, Phase 2).
- Produces: `ChatMessage` gains an optional `answeredBy?: string` field, set when loading history. `ChatPanel.tsx` renders it under assistant bubbles.

- [ ] **Step 1: Write the failing tests**

In `src/renderer/src/ai/useConversation.test.ts`, add `getCatalog` to the shared `ai` mock object at the top of the file (alongside the existing entries):

```ts
  getCatalog: vi.fn().mockResolvedValue([
    { providerId: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', costRank: 3 },
  ]),
```

Add this default in `beforeEach` too, alongside the other `ai.*.mockResolvedValue(...)` calls: `ai.getCatalog.mockResolvedValue([{ providerId: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', costRank: 3 }]);`.

Add a new test in the `'useConversation — switching conversations'` describe block:

```ts
  it('switchConversation attaches an answeredBy caption to assistant messages, looked up from the catalog', async () => {
    ai.getHistory.mockImplementation((id: string) =>
      Promise.resolve(
        id === 'conv-2'
          ? [
              { role: 'user', content: [{ type: 'text', text: 'question' }], providerId: null, model: null },
              {
                role: 'assistant',
                content: [{ type: 'text', text: 'answer' }],
                providerId: 'anthropic',
                model: 'claude-sonnet-5',
              },
            ]
          : []
      )
    );
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));

    await act(async () => {
      await result.current.switchConversation('conv-2');
    });

    const assistantMessage = result.current.messages.find((m) => m.role === 'assistant');
    expect(assistantMessage?.answeredBy).toBe('Claude Sonnet 5');
    const userMessage = result.current.messages.find((m) => m.role === 'user');
    expect(userMessage?.answeredBy).toBeUndefined();
  });

  it('falls back to the raw model name in answeredBy when it is not in the catalog (e.g. Ollama)', async () => {
    ai.getHistory.mockImplementation((id: string) =>
      Promise.resolve(
        id === 'conv-2'
          ? [{ role: 'assistant', content: [{ type: 'text', text: 'answer' }], providerId: 'ollama', model: 'llama3.1' }]
          : []
      )
    );
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));

    await act(async () => {
      await result.current.switchConversation('conv-2');
    });

    expect(result.current.messages[0].answeredBy).toBe('llama3.1');
  });
```

In `src/renderer/src/ai/ChatPanel.test.tsx`, add a new `describe` block at the end of the file, following the same local-`baseProps`-object convention the existing `describe('ChatPanel attachments', ...)` block already uses (there is no shared/exported default-props helper in this file — each describe block that needs one defines its own):

```tsx
describe('ChatPanel answeredBy caption', () => {
  const baseProps = {
    statusLabel: null,
    pendingConfirm: null,
    sending: false,
    apiKeyConfigured: true,
    input: '',
    onInputChange: vi.fn(),
    onSubmit: vi.fn(),
    onRespondToConfirm: vi.fn(),
    attachments: [] as { id: string; name: string; kind: 'text' | 'image' }[],
    attachError: null as string | null,
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
  };

  it('renders an answeredBy caption under an assistant message that has one', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} messages={[{ id: '1', role: 'assistant', text: 'hello', answeredBy: 'Claude Sonnet 5' }]} />
      </MemoryRouter>
    );
    expect(screen.getByText('Claude Sonnet 5')).toBeInTheDocument();
  });

  it('renders no caption under an assistant message that has none', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} messages={[{ id: '1', role: 'assistant', text: 'hello' }]} />
      </MemoryRouter>
    );
    expect(screen.queryByText('Claude Sonnet 5')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- useConversation.test.ts`
Run: `npm test -- ChatPanel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/renderer/src/ai/useConversation.ts`, add `answeredBy` to `ChatMessage`:

```ts
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  kind?: 'switch-notice';
  answeredBy?: string;
}
```

Add catalog state and a lookup helper. Near the top of `useConversation`, alongside the other `useState` calls:

```ts
  const [catalog, setCatalog] = useState<Array<{ providerId: string; model: string; displayName: string }>>([]);
```

Add a new effect, alongside the existing `hasUsableProvider` effect:

```ts
  useEffect(() => {
    window.smartlife.ai
      .getCatalog()
      .then(setCatalog)
      .catch(() => {});
  }, []);
```

Add a small helper function above `useConversation` (after `extractText`):

```ts
function displayNameFor(
  catalog: Array<{ providerId: string; model: string; displayName: string }>,
  providerId: string | null,
  model: string | null
): string | undefined {
  if (!providerId || !model) return undefined;
  return catalog.find((entry) => entry.providerId === providerId && entry.model === model)?.displayName ?? model;
}
```

In `switchConversation`, change the final `setMessages(...)` call from:

```ts
    setMessages(history.map((m, index) => ({ id: `history-${index}`, role: m.role, text: extractText(m.content) })));
```

to:

```ts
    setMessages(
      history.map((m, index) => ({
        id: `history-${index}`,
        role: m.role,
        text: extractText(m.content),
        answeredBy: displayNameFor(catalog, m.providerId, m.model),
      }))
    );
```

`catalog` needs to be in `switchConversation`'s `useCallback` dependency array — change:

```ts
  const switchConversation = useCallback(async (id: string) => {
```

to keep its body the same but its dependency array (currently `[]`, at the very end of the `useCallback` call) becomes `[catalog]`.

- [ ] **Step 4: Update ChatPanel.tsx**

In `src/renderer/src/ai/ChatPanel.tsx`, the non-switch-notice branch of the `.map((message) => ...)` currently returns the bubble `<div>` directly as the array item (it carries `alignSelf`/`maxWidth`/etc. itself, with `{message.text}` as its only child). It needs a thin wrapper so a caption can sit below the bubble as a sibling, still positioned as one flex item of the scrollable column. Replace:

```tsx
            <div
              key={message.id}
              style={{
                alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '70%',
                padding: '8px 12px',
                borderRadius: 8,
                whiteSpace: 'pre-wrap',
                backgroundColor: message.role === 'user' ? '#22D3EE' : 'var(--color-surface)',
                color: message.role === 'user' ? '#ffffff' : 'var(--color-text)',
                border: message.role === 'assistant' ? '1px solid var(--color-border)' : undefined,
              }}
            >
              {message.text}
            </div>
```

with:

```tsx
            <div
              key={message.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
                alignItems: message.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '70%',
              }}
            >
              <div
                style={{
                  padding: '8px 12px',
                  borderRadius: 8,
                  whiteSpace: 'pre-wrap',
                  backgroundColor: message.role === 'user' ? '#22D3EE' : 'var(--color-surface)',
                  color: message.role === 'user' ? '#ffffff' : 'var(--color-text)',
                  border: message.role === 'assistant' ? '1px solid var(--color-border)' : undefined,
                }}
              >
                {message.text}
              </div>
              {message.role === 'assistant' && message.answeredBy && (
                <div style={{ color: 'var(--color-text-muted)', fontSize: 11, marginTop: 2 }}>{message.answeredBy}</div>
              )}
            </div>
```

(The `key` moves from the bubble to the new outer wrapper, since the wrapper is now the array item `.map()` returns; `maxWidth: '70%'` moves from the bubble to the wrapper so the whole column — bubble plus caption — stays width-constrained together. The switch-notice branch above this one is untouched.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- useConversation.test.ts`
Run: `npm test -- ChatPanel.test.tsx`
Expected: PASS, all tests.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/ai/useConversation.ts src/renderer/src/ai/useConversation.test.ts src/renderer/src/ai/ChatPanel.tsx src/renderer/src/ai/ChatPanel.test.tsx
git commit -m "Show which provider/model answered each assistant message"
```

---

## Final steps (after all 8 tasks are complete)

- [ ] Run the full test suite: `npm test`. Expected: all tests pass (the pre-existing `Home.test.tsx` clock-dependent flake, if it fires, is known/unrelated to this phase — re-run just that file once to confirm before treating anything else as a real failure).
- [ ] Run `npm run typecheck`. Expected: clean, project-wide.
- [ ] Do NOT update `ROADMAP.md` yet — deferred to after Phase 8e per the controller's standing instruction to update it once for all three phases together.
