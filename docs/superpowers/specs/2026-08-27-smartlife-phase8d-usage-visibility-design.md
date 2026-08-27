# Phase 8d: Cost & Usage Visibility — Design

**Status:** Approved (defaults chosen in the user's absence per their standing authorization; open for revision on review), ready for planning.

## Motivation

Phase 8 made the assistant multi-provider (Anthropic, Gemini, Ollama), and Phase 8's fallback logic can silently move a turn from one provider to another. Nothing in the app today shows which provider actually answered a given message, or what any of this is costing. With 2-3 paid providers now wired up, that's a real gap: there's no way to notice a conversation quietly ran up against Sonnet or Opus pricing, and no way to tell, after the fact, which model produced a given answer.

## Global Constraints

- Tests run via `npm test` (sets `ELECTRON_RUN_AS_NODE=1`) — never `npx vitest run`.
- No new table. Four new nullable columns on `ai_messages`: `provider text`, `model text`, `input_tokens integer`, `output_tokens integer` — populated only for assistant messages (a user message's row leaves all four `null`). This reuses the same row both for the per-message "answered by" UI tag and for the aggregate usage query, instead of a parallel usage-log table that would need its own join logic for no added benefit.
- Real per-model `$` pricing (`inputPricePerMTok`/`outputPricePerMTok` on each `CatalogEntry`) must be verified against current Anthropic (`docs.claude.com/en/docs/about-claude/pricing`) and Google (`ai.google.dev/gemini-api/docs/pricing`) pricing pages at implementation time — not guessed, not carried over from training-data recall. This is the same rule `catalog.ts` already states for `costRank` and Phase 8b stated for `supportsWebSearch`/`supportsVision`.
- Ollama entries are never priced — local inference is always shown as $0.00, no pricing fields needed for it.
- Usage totals are lifetime cumulative, no date-range filtering, no charts. Deleting a conversation (Phase 8c) removes its messages via the existing cascade, which correctly reduces the totals — this is expected, not a bug to guard against.
- Token counts come from each provider's own reported usage for the turn (summing every round of a multi-round tool-calling loop into one number), not estimated by counting characters or re-implementing a tokenizer.

## Architecture

### 1. `AIProvider.streamTurn` return shape

Changes from `Promise<CanonicalTextBlock[]>` to:

```ts
export interface TurnResult {
  content: CanonicalTextBlock[];
  usage: { inputTokens: number; outputTokens: number };
  providerId: ProviderId;
  model: string;
}
// AIProvider.streamTurn(...): Promise<TurnResult>
```

`providerId`/`model` are constant per adapter instance (fixed at construction, e.g. `createClaudeProvider(apiKey, model)`), so each of `claude.ts`/`gemini.ts`/`ollama.ts` fills them from its own closure — no new parameter threading needed inside a single adapter. `usage` is accumulated across every round of that adapter's internal tool-calling loop (each SDK's response carries per-call usage — Anthropic's `response.usage.{input_tokens,output_tokens}`, Gemini's `response.usageMetadata.{promptTokenCount,candidatesTokenCount}`, Ollama's final streamed chunk `{prompt_eval_count, eval_count}` — verify exact field names against each SDK's current types at implementation time, same discipline as Phase 8's Gemini shape verification).

`fallback.ts`'s `createFallbackProvider` needs **no change** beyond the type flowing through: it already does `return await current.provider.streamTurn(params)` verbatim, so whichever entry actually served the turn is the one whose `providerId`/`model`/`usage` come back — exactly what "which provider answered" needs, including on a mid-turn fallback.

### 2. `conversation.appendMessage`

Gains an optional 5th parameter, only meaningful for `role: 'assistant'`:

```ts
export function appendMessage(
  db: Database.Database,
  conversationId: string,
  role: 'user' | 'assistant',
  content: unknown[],
  meta?: { providerId: string; model: string; inputTokens: number; outputTokens: number }
): void
```

Writes `provider`/`model`/`input_tokens`/`output_tokens` when `meta` is present, leaves them `null` otherwise (every existing call site for `role: 'user'` is unaffected).

### 3. `chatController.handleSendMessage`

After `const result = await provider.streamTurn({...})` (using the `TurnResult` shape above instead of today's bare array):

```ts
appendMessage(db, conversationId, 'assistant', result.content, {
  providerId: result.providerId,
  model: result.model,
  inputTokens: result.usage.inputTokens,
  outputTokens: result.usage.outputTokens,
});
```

### 4. Usage query and IPC

New function in `conversation.ts`:

```ts
export interface UsageRow {
  providerId: string;
  model: string;
  displayName: string;       // CATALOG's displayName, or the raw model string for Ollama/unrecognized models
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;  // 0 for Ollama or any entry without pricing
}
export function getUsageSummary(db: Database.Database): UsageRow[]
```

Implemented as one `select provider, model, sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens from ai_messages where provider is not null group by provider, model` query, then each row's cost computed by looking up `findCatalogEntry(providerId, model)`'s pricing fields (0 if not found, which naturally covers Ollama since it's never in `CATALOG`).

New IPC handler: `ai:get-usage-summary` → `getUsageSummary(db)`.

### 5. Settings UI: `UsageSection.tsx`

New component alongside the existing `settings/AIProvidersSection.tsx`, following the same self-contained-section pattern. Fetches `ai:get-usage-summary` on mount, renders a simple table: Model | Input tokens | Output tokens | Est. cost, one row per provider+model that has ever answered, plus a totals row summing estimated cost across all rows. No refresh button needed — Settings already re-mounts this section fresh each time the user navigates to it.

### 6. Per-message "answered by" tag

`ai:get-history`'s returned message shape gains `providerId`/`model` (already stored, just not currently returned) alongside the existing `role`/`content`. `useConversation.ts`'s `ChatMessage` gains an optional `answeredBy?: string` field, set from `findCatalogEntry(providerId, model)?.displayName` computed renderer-side from a `CATALOG` lookup already available via `ai:get-catalog` (Phase 2), falling back to the raw `model` string when not found (covers Ollama). `ChatPanel.tsx` renders it as a small muted caption under each assistant bubble, e.g. "Claude Sonnet 5" — same visual weight as the existing switch-notice text, not a badge or chip.

## Testing approach

- `providers/claude.test.ts` / `gemini.test.ts` / `ollama.test.ts`: existing tests asserting on `streamTurn`'s return value update to the new `TurnResult` shape; new tests assert `usage.inputTokens`/`usage.outputTokens` are correctly summed across a multi-round tool-calling turn (mock the SDK to return non-zero usage on each round, assert the total).
- `fallback.test.ts`: existing tests updated for the new return shape; a new test asserts that when the *second* entry serves the turn (first one failed), the returned `providerId`/`model` reflect the second entry, not the first.
- `conversation.test.ts`: new tests for `appendMessage` writing the four new columns only when `meta` is passed, and `getUsageSummary`'s grouping/summing/cost math (including the Ollama-shows-$0 case).
- `chatController.test.ts`: existing tests updated to assert `appendMessage` is called with the new `meta` argument populated from the (mocked) provider's `TurnResult`.
- `ipc.test.ts`: new test for `ai:get-usage-summary` delegating to `getUsageSummary`.
- `UsageSection.test.tsx` (new file, matching `AIProvidersSection`'s existing test file if one exists, else the general Settings test pattern): renders the fetched rows, computes and shows a totals row, shows $0.00 for an Ollama row.
- `ChatPanel.test.tsx`: new test that an assistant message with `answeredBy` set renders the caption; one without it (e.g. from before this phase shipped, or Ollama with no catalog match falling back to raw model name) doesn't crash and shows something sensible.

## Deferred (explicitly out of scope for this phase)

- Any per-conversation or date-ranged cost breakdown — lifetime totals only.
- A spending cap / budget alert. ROADMAP's Phase 8 entry already lists "cost controls" as a distinct, not-yet-built idea; this phase is visibility only, not enforcement.
