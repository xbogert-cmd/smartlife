# Phase 8: Multi-Provider AI — Design Spec

## Goal

SmartLife's AI assistant currently has exactly one hardcoded provider: Anthropic Claude, wired through `router.ts::getProvider()`, which always returns the single `claudeProvider` instance. The user hit a real wall — their Anthropic account ran out of API credits mid-use, and chat was simply unusable until they added funds.

This phase adds two more providers (Google Gemini, and local models via Ollama) alongside Anthropic, plus automatic ordered fallback between them so a failure in one doesn't mean the assistant stops working. The user configures a ranked list of specific (provider, model) choices — not just providers — since even two models under the same account can fail independently (e.g. a rate-limited Opus while Sonnet on the same key still works).

## Context: why this is simpler than it looks

The existing `ai_messages` table already stores only the *final* content of each completed turn — `chatController.ts` calls `appendMessage` exactly once per side per turn. Intermediate tool-call/tool-result exchanges within a single turn are never persisted; they live only inside that turn's own provider SDK call and are discarded once the turn completes. This means conversation history handed to a provider as `history` is, in practice, already close to a plain list of user/assistant text turns — it does not need a deep rearchitecture to become provider-neutral.

The one real requirement this phase adds: every provider's `streamTurn` must return its final answer in one shared, minimal shape, not its own SDK's native content blocks — so a *different* provider reading that history back later (on the next turn, or after a fallback) never needs to understand another provider's format.

Also confirmed clean going in: `viewContext.ts`'s system prompt (`BASE_PROMPT`) contains no Claude/Anthropic-specific language — it is already provider-neutral prose and needs no changes for this phase.

## Out of scope

- **In-chat quick-switcher UI** (mode picker, or a future provider/model picker inside the chat surface itself). The user asked for this, but it's an independent piece of work tied to a broader permission-mode redesign (the current `ask`/`assist`/`auto` naming and behavior needs its own rework — `assist` currently behaves identically to `ask`, a real gap this phase does not touch). That becomes its own follow-up spec, brainstormed separately, after this phase ships. Provider/model configuration in this phase lives in Settings only.
- **Automatically detecting that a task "needs" a bigger model.** No model can reliably self-report this as a standard capability. When automatic fallback would otherwise need to cross a cost/capability boundary, the app stops and tells the user plainly, rather than guessing.
- **A live model-catalog query for Anthropic or Gemini.** Their model lists are small, hardcoded constants (mirroring how `claude.ts` already hardcodes `MODEL = 'claude-sonnet-5'` today), verified against current documentation at implementation time. Only Ollama's model list is queried live (`/api/tags`), since that's genuinely dynamic — it's whatever the user has actually pulled locally.
- **OpenRouter or any other aggregator.** Explicitly declined by the user (its free tier isn't actually free without payment on file, so it doesn't solve anything Anthropic-alone doesn't already offer).
- **Resuming a partially-completed turn across providers.** If a turn fails mid-flight (e.g. after some tool calls already executed), the retry on the next provider starts that same user message over from scratch. Any tool call that already ran with a real side effect stays as-is — this is safe because `ALWAYS_CONFIRM`-tier tools require a fresh confirmation on any attempt regardless, and `READ`-tier tools are idempotent.

## Architecture

### Canonical content shape

`providers/types.ts` gains a canonical content-block type:

```typescript
export interface CanonicalTextBlock {
  type: 'text';
  text: string;
}
```

Every `AIProvider.streamTurn` implementation must:
- Accept `history: TurnMessage[]` where `content` is an array of `CanonicalTextBlock` (occasionally other block types may appear from an edge case — e.g. a turn that happened to end on a trailing tool-call with no follow-up text — and providers should simply ignore any block they don't recognize when building their own outgoing request, rather than erroring).
- Return `finalContent` as `CanonicalTextBlock[]`, never its own SDK's native block shape.

This keeps `conversation.ts` and the `ai_messages` table completely unchanged — no migration needed for message content itself, only a contractual change enforced at each provider's boundary.

### FallbackProvider

A new `src/main/ai/providers/fallback.ts` exports `createFallbackProvider(entries: RankedEntry[], options): AIProvider`. It itself implements `AIProvider`, wrapping an ordered list of concrete provider instances internally. `chatController.ts` is completely unaware fallback exists — it calls `.streamTurn()` on whatever `router.ts` hands it, exactly as it does today.

```typescript
interface RankedEntry {
  providerId: 'anthropic' | 'gemini' | 'ollama';
  model: string;
  costRank: number; // lower = cheaper/smaller; see Model Catalog below
  provider: AIProvider; // the constructed instance for this entry
}
```

Behavior on each `streamTurn` call:
1. Determine the starting point: the pinned/manual entry if one is set, otherwise the top of the ranked list.
2. Try that entry. On success, return normally.
3. On failure (any thrown error — not just `ProviderError`; a raw network error from Gemini being down, or a connection-refused from Ollama not running, must trigger fallback too, not only errors a provider explicitly recognizes and wraps), record that entry as failed for the rest of this app session (in-memory, resets on restart — no new DB state needed for this).
4. Move to the next entry in rank order whose `costRank <= startingEntry.costRank` and that hasn't already failed this session. If found, retry the same user message against it, emitting a `provider-switched` stream event first (see below) so the failure and switch are visible in the conversation, not silent.
5. If no such entry exists (everything at or below the starting cost rank has failed), stop and report clearly which entries were tried and that everything failed — do not silently cross into a higher cost rank. `ProviderError`'s message (when available) is included in what's shown.

A "retry" affordance in Settings clears the in-session failure memory for one specific entry (e.g. after the user adds credits), without requiring an app restart.

### StreamEvent addition

`StreamEvent`'s union gains one new member:

```typescript
{ type: 'provider-switched'; from: string; to: string; reason: string }
```

`from`/`to` are display names (e.g. "Claude Opus 5", "Gemini Flash"), `reason` is the failed provider's error message when available, otherwise a generic "unavailable." The renderer's `useConversation.ts` renders this as a plain system-style note in the message list, the same way it already renders assistant text — no new UI component needed beyond a new message-kind case.

### router.ts

Rewritten to:
1. Read the ranked-list rows and provider credentials from the database.
2. Construct one concrete provider instance per ranked entry (`createClaudeProvider(apiKey, model)`, `createGeminiProvider(apiKey, model)`, `createOllamaProvider(endpoint, model)` — each entry gets its own instance even if two entries share the same provider with different models).
3. Wrap them in `createFallbackProvider(...)`, passing the pinned-entry setting if one is configured.
4. Return that as the single `AIProvider` `chatController.ts` uses, same as today.

If no credentials are configured for any provider at all, `router.ts` returns a provider whose `streamTurn` immediately throws a clear `ProviderError` ("No AI provider is configured — add one in Settings"), so `chatController.ts`'s existing error-handling path covers this case with zero special-casing.

## Provider adapters

Each provider adapter exports a factory function (not a fixed singleton, since ranking now needs potentially multiple instances of the same provider type at different models):

### claude.ts (modified)

- `MODEL` constant becomes a constructor parameter: `createClaudeProvider(apiKey: string, model: string): AIProvider`.
- `streamTurn` keeps its existing Tool Runner logic exactly as-is.
- `finalContent` is normalized to `CanonicalTextBlock[]` before returning (Anthropic's own final-turn content is already predominantly `{type:'text', text}` blocks in practice, so this is a shape-narrowing pass, not a behavior change).
- The existing `describeError`/`ProviderError` handling (added this session for the credit-balance case) stays as-is — it already fits this design's fallback trigger (any thrown error) without modification.

### gemini.ts (new)

- Uses `@google/genai` (verified against the SDK's own repository, not guessed).
- `createGeminiProvider(apiKey: string, model: string): AIProvider`.
- Uses `ai.chats.create({ model, config: { systemInstruction, tools: [{ functionDeclarations }] } })` for a session that keeps tool-calling working across the turn's internal exchanges, then streams via that chat session.
- Tools translate from the existing `ToolDefinition.schema` (already plain JSON Schema — no core registry change needed) into Gemini's `functionDeclarations` shape, mirroring `claude.ts`'s existing `toBetaTools()` pattern with a Gemini-specific equivalent.
- A function call surfaces via `response.functionCalls`; results are sent back through the same chat session's history mechanism.
- **Implementation-time verification required:** re-check the exact current SDK method signatures and model catalog against `https://ai.google.dev/gemini-api/docs` and the `@google/genai` repository before writing the final task code — my own research for this spec surfaced one clearly hallucinated API shape from a summarized fetch (a fictitious "interactions" API) before a second, cross-checked fetch against the SDK's actual repository gave a consistent, credible answer. Do not trust a single source; cross-check.

### ollama.ts (new)

- No SDK — plain `fetch` against the user-configured endpoint (default `http://localhost:11434`).
- `createOllamaProvider(endpoint: string, model: string): AIProvider`.
- `/api/chat` with OpenAI-shaped `tools: [{type:'function', function:{name, description, parameters}}]`, streaming NDJSON response body, tool calls appear in `message.tool_calls`, results sent back as `{role: 'tool', content, tool_name}` messages — same translation pattern as the other two adapters.
- `/api/tags` lists locally-pulled models, used by the Settings UI (see below) to populate a real dropdown instead of free text.
- A connection failure (endpoint unreachable) is a normal, expected failure path for fallback purposes — same treatment as any other provider's failure.

## Model catalog and cost ranking

A new `src/main/ai/providers/catalog.ts` defines the static catalog for Anthropic and Gemini:

```typescript
export interface CatalogEntry {
  providerId: 'anthropic' | 'gemini';
  model: string;
  displayName: string;
  costRank: number;
}

export const CATALOG: CatalogEntry[] = [
  { providerId: 'anthropic', model: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', costRank: 1 },
  { providerId: 'gemini', model: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', costRank: 1 },
  { providerId: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', costRank: 3 },
  { providerId: 'gemini', model: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', costRank: 3 },
  { providerId: 'anthropic', model: 'claude-opus-5', displayName: 'Claude Opus 5', costRank: 5 },
];
```

Exact `costRank` values and the presence of any newer model (e.g. a later Gemini or Claude release current at implementation time) are to be verified and adjusted at implementation time — the ordinal *relationships* (Haiku/Flash cheapest, Sonnet/Pro mid, Opus priciest) are what this design depends on, not the literal list above being exhaustive or final.

Ollama entries are not in this static catalog — they're generated live from `/api/tags` at Settings-render time and always get `costRank: 0` (free/local, always the cheapest possible fallback floor).

### Tool-support warning (Ollama only)

A small hardcoded list of model-name patterns known to support tool-calling reasonably well (e.g. matching `llama3.1`, `qwen2.5`, `mistral-nemo` prefixes). Any locally-pulled Ollama model not matching this list is still fully selectable in Settings, but shows a clear "may not support tool-calling well" warning next to it — this app's core value (Canvas, Calendar, browser actions) depends on reliable tool use, so the user should know before picking a model that's unlikely to support it, without being blocked from trying anyway. This warning does not apply to Anthropic or Gemini catalog entries, since only models already known to support tool-calling well are ever added to that static catalog.

## Storage

Following this codebase's established convention — list-shaped config gets its own table (as Google Calendar's enabled-calendars list already does), not a JSON blob in the flat `settings` table.

**New `settings` rows** (existing flat key-value table):
- `gemini_api_key_encrypted` — same encryption pattern as the existing `anthropic_api_key_encrypted`.
- `ollama_endpoint` — plain string, defaults to `http://localhost:11434` when absent.
- `ai_pinned_provider`, `ai_pinned_model` — both nullable; when both are set, this is the manual override entry `FallbackProvider` starts from instead of the ranked list's top. Clearing them (setting to null) returns to "Auto."

**New table**, migration `0007_ai_providers.sql`:

```sql
create table ai_provider_ranking (
  rank integer primary key,
  provider text not null,
  model text not null
);
```

One row per ranked entry, ordered by `rank`. Rank values are simply re-sequenced (0, 1, 2, ...) whenever the user reorders the list in Settings — no gaps-and-renumbering complexity needed, the whole table is small (at most a handful of rows) and cheap to rewrite on every reorder.

## Settings UI

The existing single "Claude API key" block becomes part of a new "AI Providers" section, following this app's established per-integration "region" pattern already used for Canvas, Google Calendar, and Browser settings:

- **Three credential/config cards**: Anthropic (API key — the existing field, unchanged), Gemini (API key, new), Ollama (endpoint, defaulting to `http://localhost:11434`, with a live "test connection" affordance that calls `/api/tags` and reports either the count of locally-available models or a clear "couldn't reach Ollama — is it running?" message).
- **A ranked-list builder**: add an entry by picking a provider, then a model for it (from the static catalog for Anthropic/Gemini, or the live `/api/tags` result for Ollama, with the tool-support warning shown inline for any unlisted Ollama model); reorder entries with up/down controls; remove an entry. Any entry that has failed this session shows a clear "unavailable — retry" affordance right on its row, clearing that entry's in-session failure memory without needing an app restart. The list always shows at least the ability to be empty (falls through to `router.ts`'s "no provider configured" `ProviderError` path).
- **A manual override control**: "Auto" (default, uses the ranked list as designed) or pin one specific entry from the list.

## Testing approach

Following the pattern already established this session (no real network calls in the suite):

- `catalog.ts` — a sanity test confirming every entry has the required fields and a non-negative `costRank`.
- `gemini.ts` / `ollama.ts` — unit tests for the pure helper functions (tool-schema translation, response-shape parsing), with the SDK/`fetch` mocked, mirroring how `claude.test.ts`'s `describeError` is tested this session — not integration tests against real APIs.
- `fallback.ts` — the most important test target. Fake `AIProvider`s that succeed/fail in controlled ways, verifying: tries entries in rank order; sticky-skips an already-failed entry for the rest of the session; stops rather than crossing a cost-rank boundary automatically; a manual pin changes the starting point but the same cost-rank ceiling still applies from there; emits `provider-switched` with the right `from`/`to`/`reason`; the "retry" affordance actually clears an entry's failure memory.
- `router.ts` — construction tests: given various combinations of configured settings rows, builds the right set of provider instances and hands them to `FallbackProvider` correctly; the "nothing configured" path throws the expected `ProviderError`.
- Settings UI — new tests following the existing per-section "region" query pattern (`screen.getByRole('region', { name: 'AI Providers settings' })`, etc.), covering: adding/reordering/removing ranked entries, the Ollama live-model-list fetch and its failure/warning states, and the manual pin control.

## Global constraints carried forward

- The 4-tier permission system (`READ`/`SAFE_WRITE`/`CONSEQUENTIAL`/`ALWAYS_CONFIRM`) and `gate()` stay completely provider-agnostic — nothing in this phase touches `permissions.ts`, and every browser action tool's `ALWAYS_CONFIRM` tier must keep pausing in every mode regardless of which provider is currently answering.
- No provider adapter may introduce any pacing, artificial delay, or typing-simulation of any kind — the same standing constraint from Phase 5b's design applies to any and all AI-driven behavior in this app, not just browsing.
- `ToolDefinition`, `TOOLS`, and `ToolContext` (`src/main/ai/tools/*`) require zero changes — the existing JSON-Schema-shaped `schema` field is already provider-neutral enough for each adapter's own translation layer.
