# Phase 8: Multi-Provider AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google Gemini and local Ollama as AI providers alongside Anthropic, with a user-ranked, automatic fallback engine so a failure in one provider (e.g. an out-of-credits account) doesn't stop the assistant from working.

**Architecture:** A canonical `{type:'text', text}` content shape keeps conversation history provider-neutral at zero cost (the app already only persists each turn's final text). A `FallbackProvider` wraps an ordered list of concrete provider instances and itself implements the same `AIProvider` interface `chatController.ts` already calls, so the controller never needs to know fallback exists. Credentials and the ranked list live in the database, following this codebase's existing conventions (encrypted settings rows for secrets, a dedicated table for the list).

**Tech Stack:** `@anthropic-ai/sdk` (existing), `@google/genai` (new, verified against its real installed type definitions), plain `fetch` for Ollama (no SDK), better-sqlite3, Vitest.

## Global Constraints

- Tests MUST be run with `npm test` (sets `ELECTRON_RUN_AS_NODE=1`) — **never** `npx vitest run`, which uses system Node and breaks better-sqlite3's native ABI, producing ~200 bogus failures.
- Run the FULL `npm test` (no path filter) before every commit, not just the task's own test file — a prior phase in this project shipped a task whose review only ran its scoped file, missing a regression in an unrelated file that surfaced two tasks later.
- No provider adapter may introduce any pacing, artificial delay, or typing-simulation of any kind, anywhere, for any reason — a standing constraint from Phase 5b that applies to all AI-driven behavior in this app.
- `ToolDefinition`, `TOOLS`, and `ToolContext` (`src/main/ai/tools/*`) must not change — every provider adapter translates the existing JSON-Schema-shaped `schema` field into its own wire format itself.
- The 4-tier permission system (`READ`/`SAFE_WRITE`/`CONSEQUENTIAL`/`ALWAYS_CONFIRM`) and `gate()` in `src/main/ai/permissions.ts` must not change — nothing in this phase touches tool permission gating, only which provider answers.
- Every provider's `streamTurn` must consume history as, and return its final answer as, `CanonicalTextBlock[]` (`{type:'text', text:string}[]`) — never its own SDK's native content-block shape. This is what keeps a second provider able to read history a different provider wrote.
- The in-session "sticky failure" memory a `FallbackProvider` accumulates must survive across chat turns within one app run — `router.ts::getProvider(db)` MUST cache and reuse the same `FallbackProvider` instance across calls (never construct a fresh one per message), and every settings-mutating IPC handler for AI providers MUST call `resetProviderCache()` after writing, so a config change takes effect on the next message without an app restart.
- Automatic fallback must never move to an entry whose `costRank` is higher than the entry it started from (pinned override, or the ranked list's top). If nothing at or below that cost rank remains, it must stop and report clearly — never silently escalate.
- Anthropic model IDs, verified against this session's own system context: `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`. Gemini model IDs `gemini-2.5-flash` and `gemini-2.5-pro` are cross-verified against three independent sources this session (consistent across all three) — re-verify against `https://ai.google.dev/gemini-api/docs/models` before adjusting the catalog, since newer Gemini version numbers showed real inconsistency across sources during this plan's own research.
- `@google/genai` version `^2.18.0` — its real type definitions were installed and inspected directly for this plan (not guessed, and not trusted from a single summarized web fetch — a first fetch during this plan's research surfaced a hallucinated API shape that a second, source-verified fetch caught).

---

## Task 1: Migrate the single-provider system onto the new interface

This task changes `AIProvider.streamTurn`'s contract (credentials move from a per-call parameter to construction time, since a ranked list can hold multiple instances of the same provider type) and converts `claude.ts` to a factory. It keeps the app single-provider (Anthropic only) and fully working — later tasks add Gemini, Ollama, and the ranking/fallback engine on top of this foundation.

**Files:**
- Modify: `src/main/ai/providers/types.ts`
- Modify: `src/main/ai/providers/claude.ts`
- Modify: `src/main/ai/providers/claude.test.ts`
- Modify: `src/main/ai/router.ts`
- Create: `src/main/ai/router.test.ts`
- Modify: `src/main/ai/chatController.ts`
- Modify: `src/main/ai/chatController.test.ts`

**Interfaces:**
- Produces: `CanonicalTextBlock { type: 'text'; text: string }`, `ProviderId = 'anthropic' | 'gemini' | 'ollama'`, `AIProvider.streamTurn(params: { system, history, userText, tools, ctx, onEvent }): Promise<CanonicalTextBlock[]>` (no `apiKey` field — dropped from this call), `StreamEvent` gains `'provider-switched'` with optional `from`/`to`/`reason` string fields, `createClaudeProvider(apiKey: string, model: string): AIProvider`, `getProvider(db: Database.Database): AIProvider`.
- Consumes: nothing from later tasks.

- [ ] **Step 1: Update the AIProvider interface and add the canonical content shape**

Replace the full contents of `src/main/ai/providers/types.ts`:

```typescript
import type { ToolContext, ToolDefinition } from '../tools/types';

export interface StreamEvent {
  type: 'text-delta' | 'tool-status' | 'turn-complete' | 'provider-switched';
  text?: string;
  toolName?: string;
  toolLabel?: string;
  from?: string;
  to?: string;
  reason?: string;
}

export interface TurnMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

/**
 * The only content-block shape any provider may read from or write to
 * conversation history. This -- not any provider's own SDK-native blocks --
 * is what gets persisted to ai_messages and handed back as `history` on a
 * later turn, so a second provider (whether on the next turn or after a
 * fallback) never needs to understand a different provider's format.
 */
export interface CanonicalTextBlock {
  type: 'text';
  text: string;
}

export type ProviderId = 'anthropic' | 'gemini' | 'ollama';

/**
 * Thrown by a provider to show its own message to the user verbatim, instead
 * of the generic "Something went wrong" fallback -- e.g. Anthropic's "credit
 * balance too low", which the user needs to actually read to know what to do
 * next. Anything else a provider throws stays generic; a raw error message
 * from an unrelated bug is not something to show a person.
 */
export class ProviderError extends Error {}

export interface AIProvider {
  streamTurn(params: {
    system: string;
    history: TurnMessage[];
    userText: string;
    tools: ToolDefinition[];
    ctx: ToolContext;
    onEvent: (event: StreamEvent) => void;
  }): Promise<CanonicalTextBlock[]>;
}
```

- [ ] **Step 2: Run the existing test suite to see what this breaks**

Run: `npm test -- src/main/ai/providers/claude.test.ts src/main/ai/chatController.test.ts`
Expected: FAIL — `claude.ts` still exports the old `claudeProvider`/`MODEL` shape and passes `apiKey` per call; `chatController.ts` still reads `apiKey` and calls `getProvider()` with no args.

- [ ] **Step 3: Convert claude.ts to a factory**

Replace the full contents of `src/main/ai/providers/claude.ts`:

```typescript
import Anthropic, { APIError } from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import type { ToolContext, ToolDefinition } from '../tools/types';
import { ProviderError, type AIProvider, type CanonicalTextBlock, type StreamEvent } from './types';

function toBetaTools(tools: ToolDefinition[], ctx: ToolContext) {
  return tools.map((tool) =>
    betaTool({
      name: tool.schema.name,
      description: tool.schema.description,
      inputSchema: tool.schema.input_schema as { type: 'object'; [key: string]: unknown },
      run: async (input: Record<string, unknown>) => tool.run(input, ctx),
    })
  );
}

/**
 * The SDK's own Error.message is the raw response JSON stringified (its
 * makeMessage() only reads a top-level `.message`, but Anthropic's actual
 * error body nests it one level deeper under `.error.message`) -- not
 * something to show a person. Anthropic-specific error shape stays here,
 * not in chatController.ts, so a second provider never has to know about it.
 */
export function describeError(error: unknown): string | null {
  if (!(error instanceof APIError)) return null;
  const body = error.error as { error?: { message?: unknown } } | undefined;
  const message = body?.error?.message;
  return typeof message === 'string' ? message : null;
}

/**
 * `apiKey` and `model` are fixed at construction, not passed per-call -- a
 * ranked fallback list can hold more than one Claude entry at different
 * models, each needing its own provider instance, and every other provider
 * needs a differently-shaped credential the generic AIProvider interface has
 * no business knowing about.
 */
export function createClaudeProvider(apiKey: string, model: string): AIProvider {
  const client = new Anthropic({ apiKey });

  return {
    async streamTurn({ system, history, userText, tools, ctx, onEvent }) {
      const toolLabels = new Map(tools.map((tool) => [tool.schema.name, tool.label]));

      const messages = [...history, { role: 'user' as const, content: userText }] as unknown as Anthropic.Beta.Messages.BetaMessageParam[];

      const runner = client.beta.messages.toolRunner({
        model,
        max_tokens: 4096,
        system,
        tools: toBetaTools(tools, ctx),
        messages,
        stream: true,
      });

      let finalText = '';

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
            .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
            .map((block) => block.text)
            .join('');
        }
      } catch (error) {
        const message = describeError(error);
        throw message !== null ? new ProviderError(message) : error;
      }

      onEvent({ type: 'turn-complete' } satisfies StreamEvent);
      return [{ type: 'text', text: finalText }] satisfies CanonicalTextBlock[];
    },
  };
}
```

- [ ] **Step 4: Add factory tests to claude.test.ts**

Append to `src/main/ai/providers/claude.test.ts` (the file already has `describe('describeError', ...)` from an earlier session — keep it unchanged, add this below it):

```typescript
import { createClaudeProvider } from './claude';

describe('createClaudeProvider', () => {
  it('returns a provider with a streamTurn function', () => {
    const provider = createClaudeProvider('sk-ant-test', 'claude-sonnet-5');
    expect(typeof provider.streamTurn).toBe('function');
  });
});
```

(Deep-mocking the Anthropic tool-runner's async-iterator streaming machinery for a full behavioral test is a large, low-value undertaking — the real integration behavior is covered by `chatController.test.ts`'s fake-provider tests below, matching this file's existing "test the pure logic, not the real network" pattern.)

- [ ] **Step 5: Rewrite router.ts for the new single-provider shape**

Replace the full contents of `src/main/ai/router.ts`:

```typescript
import type Database from 'better-sqlite3';
import { getStoredApiKey } from './apiKey';
import { createClaudeProvider } from './providers/claude';
import { ProviderError, type AIProvider } from './providers/types';

export function getProvider(db: Database.Database): AIProvider {
  const apiKey = getStoredApiKey(db);
  if (apiKey === null) {
    return {
      async streamTurn() {
        throw new ProviderError('No API key configured — add one in Settings.');
      },
    };
  }
  return createClaudeProvider(apiKey, 'claude-sonnet-5');
}
```

- [ ] **Step 6: Write router.test.ts**

Create `src/main/ai/router.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { setStoredApiKey } from './apiKey';
import { ProviderError } from './providers/types';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

const INIT_SQL = `create table settings (key text primary key, value text not null);`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db, [{ filename: '0001_init.sql', sql: INIT_SQL }]);
  return db;
}

describe('getProvider', () => {
  it('throws a ProviderError when no API key is stored', async () => {
    const { getProvider } = await import('./router');
    const db = makeDb();
    const provider = getProvider(db);
    await expect(
      provider.streamTurn({
        system: 's',
        history: [],
        userText: 'hi',
        tools: [],
        ctx: { db, conversationId: 'c1', mode: 'ask', requestConfirmation: vi.fn() },
        onEvent: vi.fn(),
      })
    ).rejects.toThrow(ProviderError);
  });

  it('returns a working Claude provider when an API key is stored', async () => {
    const { getProvider } = await import('./router');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const provider = getProvider(db);
    expect(typeof provider.streamTurn).toBe('function');
  });
});
```

- [ ] **Step 7: Update chatController.ts**

In `src/main/ai/chatController.ts`, remove the `getStoredApiKey` import and the early "no API key" check, stop passing `apiKey` into `streamTurn`, and pass `db` into `getProvider`. Replace the full contents:

```typescript
import type { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { getAiMode } from './mode';
import { getOrCreateConversationId, appendMessage, getMessages } from './conversation';
import { requestConfirmation as requestToolConfirmation } from './confirmations';
import { TOOLS } from './tools/registry';
import { getProvider } from './router';
import type { ToolContext } from './tools/types';
import { ProviderError, type AIProvider, type StreamEvent } from './providers/types';
import { buildSystemPrompt, type ViewContext } from './viewContext';
import { notifyIfUnfocused } from '../notify';
import { logError } from '../log';

// ponytail: single in-flight flag, only one conversation exists app-wide today.
// Upgrade to a Set keyed by conversation id if multi-conversation support lands.
let turnInFlight = false;

export async function handleSendMessage(
  db: Database.Database,
  getWindow: () => BrowserWindow | null,
  userText: string,
  view: ViewContext | null,
  provider: AIProvider = getProvider(db)
): Promise<void> {
  const send = (event: StreamEvent): void => getWindow()?.webContents.send('ai:stream-event', event);

  if (turnInFlight) {
    send({ type: 'text-delta', text: 'Still working on the last message — try again in a moment.' });
    send({ type: 'turn-complete' });
    return;
  }

  turnInFlight = true;
  try {
    const conversationId = getOrCreateConversationId(db);
    const mode = getAiMode(db);
    const history = getMessages(db, conversationId).map((m) => ({
      role: m.role,
      content: JSON.parse(m.content) as unknown,
    }));

    const ctx: ToolContext = {
      db,
      conversationId,
      mode,
      requestConfirmation: (toolName, description, timeoutMs) => {
        // If there's no window to show a confirmation UI in, there's no way for the
        // user to ever approve — resolve as declined instead of parking the promise
        // forever in confirmations.ts's pending map.
        if (!getWindow()) return Promise.resolve(false);
        notifyIfUnfocused(getWindow(), 'SmartLife needs your approval', description);
        return requestToolConfirmation(
          (payload) => getWindow()?.webContents.send('ai:confirm-request', payload),
          toolName,
          description,
          timeoutMs
        );
      },
    };

    try {
      const finalContent = await provider.streamTurn({
        system: buildSystemPrompt(db, view),
        history,
        userText,
        tools: TOOLS,
        ctx,
        onEvent: send,
      });
      appendMessage(db, conversationId, 'user', [{ type: 'text', text: userText }]);
      appendMessage(db, conversationId, 'assistant', finalContent);
    } catch (error) {
      // Every other main-process error path (browser, sync, downloads) is
      // persisted via logError so it survives past the session that hit it --
      // this one previously only went to console.error, which a packaged app
      // launched outside a terminal has no way to ever show anyone.
      logError('ai:turn-failed', error);
      // A provider opts into showing its own message (e.g. "credit balance
      // too low") by throwing ProviderError specifically -- anything else,
      // including a genuine bug, stays generic rather than putting a raw
      // internal error message in front of the user.
      const text = error instanceof ProviderError ? error.message : 'Something went wrong — try again.';
      send({ type: 'text-delta', text });
      send({ type: 'turn-complete' });
    }
  } finally {
    turnInFlight = false;
  }
}
```

- [ ] **Step 8: Update chatController.test.ts's "no API key" test**

In `src/main/ai/chatController.test.ts`, replace the test named `'shows a configuration prompt and never calls the provider when no API key is stored'` with:

```typescript
  it('shows a configuration prompt and never persists messages when no API key is stored', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    const window = fakeWindow();
    await handleSendMessage(db, () => window as never, 'hello', null);
    expect(window.sent.some((s) => JSON.stringify(s.payload).includes('Settings'))).toBe(true);
    const count = db.prepare('select count(*) as count from ai_messages').get() as { count: number };
    expect(count.count).toBe(0);
  });
```

This now exercises the real `getProvider(db)` default path (no explicit fake provider passed) instead of relying on a pre-check inside `handleSendMessage` itself, since that check moved into `router.ts`.

- [ ] **Step 9: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS, all green.

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/main/ai/providers/types.ts src/main/ai/providers/claude.ts src/main/ai/providers/claude.test.ts src/main/ai/router.ts src/main/ai/router.test.ts src/main/ai/chatController.ts src/main/ai/chatController.test.ts
git commit -m "Migrate the AI provider interface onto construction-time credentials"
```

---

## Task 2: Model catalog

**Files:**
- Create: `src/main/ai/providers/catalog.ts`
- Create: `src/main/ai/providers/catalog.test.ts`

**Interfaces:**
- Consumes: `ProviderId` (Task 1, `./types`).
- Produces: `CatalogEntry { providerId: 'anthropic' | 'gemini'; model: string; displayName: string; costRank: number }`, `CATALOG: CatalogEntry[]`, `OLLAMA_COST_RANK: number`, `isKnownGoodForTools(name: string): boolean`, `findCatalogEntry(providerId: ProviderId, model: string): CatalogEntry | undefined`.

- [ ] **Step 1: Write the failing tests**

Create `src/main/ai/providers/catalog.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/main/ai/providers/catalog.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/main/ai/providers/catalog.ts`:

```typescript
import type { ProviderId } from './types';

export interface CatalogEntry {
  providerId: 'anthropic' | 'gemini';
  model: string;
  displayName: string;
  costRank: number;
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
  { providerId: 'anthropic', model: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', costRank: 1 },
  { providerId: 'gemini', model: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', costRank: 1 },
  { providerId: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', costRank: 3 },
  { providerId: 'gemini', model: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', costRank: 3 },
  { providerId: 'anthropic', model: 'claude-opus-5', displayName: 'Claude Opus 5', costRank: 5 },
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

export function findCatalogEntry(providerId: ProviderId, model: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.providerId === providerId && entry.model === model);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/main/ai/providers/catalog.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/providers/catalog.ts src/main/ai/providers/catalog.test.ts
git commit -m "Add the static Anthropic/Gemini model catalog with cost ranks"
```

---

## Task 3: Gemini key, Ollama endpoint, and pinned-entry storage

**Files:**
- Create: `src/main/ai/providerConfig.ts`
- Create: `src/main/ai/providerConfig.test.ts`

**Interfaces:**
- Consumes: `ProviderId` (Task 1, `./providers/types`).
- Produces: `DEFAULT_OLLAMA_ENDPOINT: string`, `hasGeminiKey/getGeminiKey/setGeminiKey/clearGeminiKey(db, ...)`, `getOllamaEndpoint/setOllamaEndpoint(db, ...)`, `PinnedEntry { providerId: ProviderId; model: string }`, `getPinnedEntry/setPinnedEntry/clearPinnedEntry(db, ...)`.

- [ ] **Step 1: Write the failing tests**

Create `src/main/ai/providerConfig.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null);');
  return db;
}

describe('Gemini key storage', () => {
  it('round-trips a key through encryption', async () => {
    const { setGeminiKey, getGeminiKey, hasGeminiKey } = await import('./providerConfig');
    const db = makeDb();
    expect(hasGeminiKey(db)).toBe(false);
    setGeminiKey(db, 'test-gemini-key');
    expect(hasGeminiKey(db)).toBe(true);
    expect(getGeminiKey(db)).toBe('test-gemini-key');
  });

  it('clears a stored key', async () => {
    const { setGeminiKey, clearGeminiKey, hasGeminiKey } = await import('./providerConfig');
    const db = makeDb();
    setGeminiKey(db, 'test-gemini-key');
    clearGeminiKey(db);
    expect(hasGeminiKey(db)).toBe(false);
  });
});

describe('Ollama endpoint storage', () => {
  it('defaults to localhost:11434 when nothing is stored', async () => {
    const { getOllamaEndpoint } = await import('./providerConfig');
    const db = makeDb();
    expect(getOllamaEndpoint(db)).toBe('http://localhost:11434');
  });

  it('stores and returns a custom endpoint', async () => {
    const { setOllamaEndpoint, getOllamaEndpoint } = await import('./providerConfig');
    const db = makeDb();
    setOllamaEndpoint(db, 'http://192.168.1.50:11434');
    expect(getOllamaEndpoint(db)).toBe('http://192.168.1.50:11434');
  });

  it('rejects an empty endpoint', async () => {
    const { setOllamaEndpoint } = await import('./providerConfig');
    const db = makeDb();
    expect(() => setOllamaEndpoint(db, '   ')).toThrow('Ollama endpoint is required.');
  });
});

describe('pinned provider/model', () => {
  it('returns null when nothing is pinned', async () => {
    const { getPinnedEntry } = await import('./providerConfig');
    const db = makeDb();
    expect(getPinnedEntry(db)).toBeNull();
  });

  it('round-trips a pinned entry', async () => {
    const { setPinnedEntry, getPinnedEntry } = await import('./providerConfig');
    const db = makeDb();
    setPinnedEntry(db, { providerId: 'anthropic', model: 'claude-opus-5' });
    expect(getPinnedEntry(db)).toEqual({ providerId: 'anthropic', model: 'claude-opus-5' });
  });

  it('clears a pinned entry back to "Auto"', async () => {
    const { setPinnedEntry, clearPinnedEntry, getPinnedEntry } = await import('./providerConfig');
    const db = makeDb();
    setPinnedEntry(db, { providerId: 'gemini', model: 'gemini-2.5-pro' });
    clearPinnedEntry(db);
    expect(getPinnedEntry(db)).toBeNull();
  });

  it('treats a half-written pair (only one of the two keys set) as not pinned', async () => {
    const { getPinnedEntry } = await import('./providerConfig');
    const db = makeDb();
    db.prepare('insert into settings (key, value) values (?, ?)').run('ai_pinned_provider', 'anthropic');
    expect(getPinnedEntry(db)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/main/ai/providerConfig.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/main/ai/providerConfig.ts`:

```typescript
import { safeStorage } from 'electron';
import type Database from 'better-sqlite3';
import type { ProviderId } from './providers/types';

const GEMINI_KEY = 'gemini_api_key_encrypted';
const OLLAMA_ENDPOINT_KEY = 'ollama_endpoint';
const PINNED_PROVIDER_KEY = 'ai_pinned_provider';
const PINNED_MODEL_KEY = 'ai_pinned_model';

export const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';

function readSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('select value from settings where key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

function writeSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    'insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
  ).run(key, value);
}

function deleteSetting(db: Database.Database, key: string): void {
  db.prepare('delete from settings where key = ?').run(key);
}

export function hasGeminiKey(db: Database.Database): boolean {
  return readSetting(db, GEMINI_KEY) !== null;
}

export function getGeminiKey(db: Database.Database): string | null {
  const stored = readSetting(db, GEMINI_KEY);
  if (stored === null || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    return null;
  }
}

export function setGeminiKey(db: Database.Database, apiKey: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system.');
  }
  const encrypted = safeStorage.encryptString(apiKey).toString('base64');
  writeSetting(db, GEMINI_KEY, encrypted);
}

export function clearGeminiKey(db: Database.Database): void {
  deleteSetting(db, GEMINI_KEY);
}

export function getOllamaEndpoint(db: Database.Database): string {
  return readSetting(db, OLLAMA_ENDPOINT_KEY) ?? DEFAULT_OLLAMA_ENDPOINT;
}

export function setOllamaEndpoint(db: Database.Database, endpoint: string): void {
  const trimmed = endpoint.trim();
  if (trimmed.length === 0) throw new Error('Ollama endpoint is required.');
  writeSetting(db, OLLAMA_ENDPOINT_KEY, trimmed);
}

export interface PinnedEntry {
  providerId: ProviderId;
  model: string;
}

const VALID_PROVIDER_IDS: ProviderId[] = ['anthropic', 'gemini', 'ollama'];

/** Returns null when nothing is pinned, or when only one of the pair is set --
 *  the pair is both-or-neither, so a corrupted half-write reads as "not pinned"
 *  rather than crashing on a missing model. */
export function getPinnedEntry(db: Database.Database): PinnedEntry | null {
  const providerId = readSetting(db, PINNED_PROVIDER_KEY);
  const model = readSetting(db, PINNED_MODEL_KEY);
  if (providerId === null || model === null) return null;
  if (!VALID_PROVIDER_IDS.includes(providerId as ProviderId)) return null;
  return { providerId: providerId as ProviderId, model };
}

export function setPinnedEntry(db: Database.Database, entry: PinnedEntry): void {
  writeSetting(db, PINNED_PROVIDER_KEY, entry.providerId);
  writeSetting(db, PINNED_MODEL_KEY, entry.model);
}

export function clearPinnedEntry(db: Database.Database): void {
  deleteSetting(db, PINNED_PROVIDER_KEY);
  deleteSetting(db, PINNED_MODEL_KEY);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/main/ai/providerConfig.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/providerConfig.ts src/main/ai/providerConfig.test.ts
git commit -m "Add Gemini key, Ollama endpoint, and pinned-entry storage"
```

---

## Task 4: Ranked-list storage (migration + queries)

**Files:**
- Create: `src/main/db/migrations/0007_ai_providers.sql`
- Modify: `src/main/db/index.ts`
- Create: `src/main/ai/providerRanking.ts`
- Create: `src/main/ai/providerRanking.test.ts`

**Interfaces:**
- Consumes: `ProviderId` (Task 1, `./providers/types`).
- Produces: `RankingEntry { providerId: ProviderId; model: string }`, `getRanking(db): RankingEntry[]`, `setRanking(db, entries: RankingEntry[]): void`.

This codebase stores list-shaped config in its own table (see `google_calendars` from Phase 4), not a JSON blob in the flat `settings` table — this task follows that same convention.

- [ ] **Step 1: Write the failing tests**

Create `src/main/ai/providerRanking.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getRanking, setRanking } from './providerRanking';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(
    `create table ai_provider_ranking (
      rank integer primary key,
      provider text not null,
      model text not null
    );`
  );
  return db;
}

describe('provider ranking', () => {
  it('returns an empty list when nothing is configured', () => {
    const db = makeDb();
    expect(getRanking(db)).toEqual([]);
  });

  it('stores and returns entries in rank order', () => {
    const db = makeDb();
    setRanking(db, [
      { providerId: 'anthropic', model: 'claude-sonnet-5' },
      { providerId: 'gemini', model: 'gemini-2.5-flash' },
      { providerId: 'ollama', model: 'llama3.1' },
    ]);
    expect(getRanking(db)).toEqual([
      { providerId: 'anthropic', model: 'claude-sonnet-5' },
      { providerId: 'gemini', model: 'gemini-2.5-flash' },
      { providerId: 'ollama', model: 'llama3.1' },
    ]);
  });

  it('replaces the whole list, not just appending, on a second call', () => {
    const db = makeDb();
    setRanking(db, [{ providerId: 'anthropic', model: 'claude-opus-5' }]);
    setRanking(db, [{ providerId: 'gemini', model: 'gemini-2.5-pro' }]);
    expect(getRanking(db)).toEqual([{ providerId: 'gemini', model: 'gemini-2.5-pro' }]);
  });

  it('re-sequences ranks 0..n-1 to reflect reordering, regardless of insertion order passed in', () => {
    const db = makeDb();
    setRanking(db, [
      { providerId: 'gemini', model: 'gemini-2.5-flash' },
      { providerId: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    ]);
    const rows = db.prepare('select rank, provider from ai_provider_ranking order by rank').all() as Array<{
      rank: number;
      provider: string;
    }>;
    expect(rows).toEqual([
      { rank: 0, provider: 'gemini' },
      { rank: 1, provider: 'anthropic' },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/main/ai/providerRanking.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Add the migration**

Create `src/main/db/migrations/0007_ai_providers.sql`:

```sql
create table ai_provider_ranking (
  rank integer primary key,
  provider text not null,
  model text not null
);
```

- [ ] **Step 4: Register the migration**

In `src/main/db/index.ts`, add the import and register it in `openDb`'s `runMigrations` call:

```typescript
import migration0007 from './migrations/0007_ai_providers.sql?raw';
```

Add to the array passed to `runMigrations`, after `0006_submissions.sql`:

```typescript
    { filename: '0007_ai_providers.sql', sql: migration0007 },
```

- [ ] **Step 5: Implement providerRanking.ts**

Create `src/main/ai/providerRanking.ts`:

```typescript
import type Database from 'better-sqlite3';
import type { ProviderId } from './providers/types';

export interface RankingEntry {
  providerId: ProviderId;
  model: string;
}

const VALID_PROVIDER_IDS: ProviderId[] = ['anthropic', 'gemini', 'ollama'];

interface Row {
  rank: number;
  provider: string;
  model: string;
}

export function getRanking(db: Database.Database): RankingEntry[] {
  const rows = db.prepare('select rank, provider, model from ai_provider_ranking order by rank').all() as Row[];
  return rows
    .filter((row) => VALID_PROVIDER_IDS.includes(row.provider as ProviderId))
    .map((row) => ({ providerId: row.provider as ProviderId, model: row.model }));
}

/**
 * Replaces the whole ranked list in one transaction, in the order given.
 * The table is small (a handful of rows at most) and rewritten wholesale on
 * every add/remove/reorder in Settings -- simpler and safer than patching
 * individual rank values, and there is no concurrent writer to race with.
 */
export function setRanking(db: Database.Database, entries: RankingEntry[]): void {
  const replace = db.transaction((list: RankingEntry[]) => {
    db.prepare('delete from ai_provider_ranking').run();
    const insert = db.prepare('insert into ai_provider_ranking (rank, provider, model) values (?, ?, ?)');
    list.forEach((entry, index) => {
      insert.run(index, entry.providerId, entry.model);
    });
  });
  replace(entries);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- src/main/ai/providerRanking.test.ts`
Expected: PASS

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/db/migrations/0007_ai_providers.sql src/main/db/index.ts src/main/ai/providerRanking.ts src/main/ai/providerRanking.test.ts
git commit -m "Add the ranked provider list table and its query module"
```

---

## Task 5: Gemini provider adapter

**Files:**
- Modify: `package.json`
- Create: `src/main/ai/providers/gemini.ts`
- Create: `src/main/ai/providers/gemini.test.ts`

**Interfaces:**
- Consumes: `AIProvider`, `CanonicalTextBlock`, `StreamEvent`, `TurnMessage`, `ProviderError` (Task 1, `./types`); `ToolContext`, `ToolDefinition` (existing, `../tools/types`).
- Produces: `createGeminiProvider(apiKey: string, model: string): AIProvider`, `describeError(error: unknown): string | null`, `toFunctionDeclarations`, `toGeminiHistory` (exported for testing).

This task uses `@google/genai`'s real, installed type definitions (`Chats.create`, `Chat.sendMessageStream`, `FunctionDeclaration.parametersJsonSchema`, `response.functionCalls`, `ApiError`) — verified directly against the package's own `.d.ts` files during this plan's research, not guessed from documentation prose.

- [ ] **Step 1: Add the dependency**

In `package.json`, add to `"dependencies"`:

```json
"@google/genai": "^2.18.0",
```

Run: `npm install`

- [ ] **Step 2: Write the failing tests**

Create `src/main/ai/providers/gemini.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@google/genai';
import type { ToolDefinition } from '../tools/types';
import { createGeminiProvider, describeError, toFunctionDeclarations, toGeminiHistory } from './gemini';

describe('describeError', () => {
  it('returns the message from a real Gemini ApiError', () => {
    const error = new ApiError({ message: 'API key not valid.', status: 400 });
    expect(describeError(error)).toBe('API key not valid.');
  });

  it('returns null for an error that is not from the Gemini SDK', () => {
    expect(describeError(new Error('some unrelated bug'))).toBeNull();
    expect(describeError('not even an Error instance')).toBeNull();
  });
});

describe('toFunctionDeclarations', () => {
  it('translates a ToolDefinition into a Gemini function declaration using the JSON Schema verbatim', () => {
    const tool: ToolDefinition = {
      name: 'get_weather',
      tier: 'READ',
      label: 'Get weather',
      schema: {
        name: 'get_weather',
        description: 'Gets the weather for a city',
        input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
      run: async () => 'sunny',
    };
    expect(toFunctionDeclarations([tool])).toEqual([
      {
        name: 'get_weather',
        description: 'Gets the weather for a city',
        parametersJsonSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    ]);
  });
});

describe('toGeminiHistory', () => {
  it('maps assistant to the "model" role and keeps user as "user"', () => {
    const history = toGeminiHistory([
      { role: 'user', content: [{ type: 'text', text: 'question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ]);
    expect(history).toEqual([
      { role: 'user', parts: [{ text: 'question' }] },
      { role: 'model', parts: [{ text: 'answer' }] },
    ]);
  });

  it('ignores a non-text block rather than throwing', () => {
    const history = toGeminiHistory([{ role: 'assistant', content: [{ type: 'tool_use', id: 'x' }] }]);
    expect(history).toEqual([{ role: 'model', parts: [] }]);
  });
});

describe('createGeminiProvider', () => {
  it('returns a provider with a streamTurn function', () => {
    const provider = createGeminiProvider('test-gemini-key', 'gemini-2.5-flash');
    expect(typeof provider.streamTurn).toBe('function');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/main/ai/providers/gemini.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement**

Create `src/main/ai/providers/gemini.ts`:

```typescript
import { ApiError, GoogleGenAI, type Content, type FunctionDeclaration, type Part } from '@google/genai';
import type { ToolContext, ToolDefinition } from '../tools/types';
import { ProviderError, type AIProvider, type CanonicalTextBlock, type StreamEvent, type TurnMessage } from './types';

export function toFunctionDeclarations(tools: ToolDefinition[]): FunctionDeclaration[] {
  return tools.map((tool) => ({
    name: tool.schema.name,
    description: tool.schema.description,
    parametersJsonSchema: tool.schema.input_schema,
  }));
}

/** Only plain text blocks ever cross the history boundary (see
 *  CanonicalTextBlock in types.ts) -- a canonical assistant turn becomes one
 *  'model'-role Content with a text Part per block. */
export function toGeminiHistory(history: TurnMessage[]): Content[] {
  return history.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: (Array.isArray(message.content) ? message.content : [])
      .filter((block): block is CanonicalTextBlock => {
        return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text';
      })
      .map((block) => ({ text: block.text })),
  }));
}

/** Gemini's own ApiError.message is already a clean, human-readable string --
 *  unlike Anthropic's, which nests it inside a stringified JSON body. */
export function describeError(error: unknown): string | null {
  return error instanceof ApiError ? error.message : null;
}

async function runOneTool(
  tools: ToolDefinition[],
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const tool = tools.find((t) => t.schema.name === name);
  if (!tool) return `Unknown tool: ${name}`;
  return tool.run(args, ctx);
}

/**
 * `apiKey` and `model` are fixed at construction -- same reasoning as
 * createClaudeProvider: a ranked fallback list can hold more than one Gemini
 * entry at different models, each needing its own instance.
 */
export function createGeminiProvider(apiKey: string, model: string): AIProvider {
  const client = new GoogleGenAI({ apiKey });

  return {
    async streamTurn({ system, history, userText, tools, ctx, onEvent }) {
      const toolLabels = new Map(tools.map((tool) => [tool.schema.name, tool.label]));
      const functionDeclarations = toFunctionDeclarations(tools);

      const chat = client.chats.create({
        model,
        history: toGeminiHistory(history),
        config: {
          systemInstruction: system,
          tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
        },
      });

      let finalText = '';
      let nextMessage: Part[] | string = userText;
      // Gemini's tool loop is manual, unlike Anthropic's toolRunner -- each
      // round sends one message and gets back either text or function calls
      // that must be answered before the model will continue. A hard cap
      // avoids ever looping forever against a model that keeps calling tools.
      const MAX_ROUNDS = 20;

      try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const stream = await chat.sendMessageStream({ message: nextMessage });
          let roundText = '';
          const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

          for await (const chunk of stream) {
            if (chunk.text) {
              onEvent({ type: 'text-delta', text: chunk.text } satisfies StreamEvent);
              roundText += chunk.text;
            }
            for (const call of chunk.functionCalls ?? []) {
              if (call.name) functionCalls.push({ name: call.name, args: call.args ?? {} });
            }
          }

          finalText = roundText;

          if (functionCalls.length === 0) break;

          for (const call of functionCalls) {
            const toolLabel = toolLabels.get(call.name) ?? call.name;
            onEvent({ type: 'tool-status', toolName: call.name, toolLabel } satisfies StreamEvent);
          }

          nextMessage = await Promise.all(
            functionCalls.map(async (call) => ({
              functionResponse: {
                name: call.name,
                response: { output: await runOneTool(tools, ctx, call.name, call.args) },
              },
            }))
          );
        }
      } catch (error) {
        const message = describeError(error);
        throw message !== null ? new ProviderError(message) : error;
      }

      onEvent({ type: 'turn-complete' } satisfies StreamEvent);
      return [{ type: 'text', text: finalText }] satisfies CanonicalTextBlock[];
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/main/ai/providers/gemini.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS. If `parametersJsonSchema` or another field name in this task's code doesn't match the currently-installed `@google/genai` version's real types, re-verify by inspecting `node_modules/@google/genai/dist/node/node.d.ts` directly rather than guessing a fix — this task's code was written against that file's real content, not documentation prose.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/main/ai/providers/gemini.ts src/main/ai/providers/gemini.test.ts
git commit -m "Add the Gemini provider adapter"
```

---

## Task 6: Ollama provider adapter

**Files:**
- Create: `src/main/ai/providers/ollama.ts`
- Create: `src/main/ai/providers/ollama.test.ts`

**Interfaces:**
- Consumes: `AIProvider`, `CanonicalTextBlock`, `StreamEvent`, `TurnMessage`, `ProviderError` (Task 1, `./types`); `ToolContext`, `ToolDefinition` (existing, `../tools/types`).
- Produces: `createOllamaProvider(endpoint: string, model: string): AIProvider`, `toOllamaTools`, `toOllamaMessages` (exported for testing), `OllamaModelInfo { name: string }`, `listOllamaModels(endpoint: string): Promise<OllamaModelInfo[]>`.

No SDK — plain `fetch` against Ollama's own `/api/chat` (OpenAI-shaped `tools`/`tool_calls`/`role: 'tool'`, streamed as newline-delimited JSON) and `/api/tags` (lists locally-pulled models). Both verified against Ollama's own API docs during this plan's research.

- [ ] **Step 1: Write the failing tests**

Create `src/main/ai/providers/ollama.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../tools/types';
import { createOllamaProvider, listOllamaModels, toOllamaMessages, toOllamaTools } from './ollama';
import { ProviderError } from './types';

afterEach(() => {
  vi.unstubAllGlobals();
});

function ndjsonResponse(lines: object[]): Response {
  const body = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  return new Response(body, { status: 200 });
}

function fakeCtx() {
  return { db: {} as never, conversationId: 'c1', mode: 'ask' as const, requestConfirmation: vi.fn() };
}

describe('toOllamaTools', () => {
  it('translates a ToolDefinition into an OpenAI-shaped function tool', () => {
    const tool: ToolDefinition = {
      name: 'get_weather',
      tier: 'READ',
      label: 'Get weather',
      schema: { name: 'get_weather', description: 'Gets the weather', input_schema: { type: 'object', properties: {} } },
      run: async () => 'sunny',
    };
    expect(toOllamaTools([tool])).toEqual([
      {
        type: 'function',
        function: { name: 'get_weather', description: 'Gets the weather', parameters: { type: 'object', properties: {} } },
      },
    ]);
  });
});

describe('toOllamaMessages', () => {
  it('puts the system prompt first, translates history text blocks, then the new user message', () => {
    const messages = toOllamaMessages(
      'You are helpful.',
      [
        { role: 'user', content: [{ type: 'text', text: 'earlier question' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] },
      ],
      'new question'
    );
    expect(messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'new question' },
    ]);
  });
});

describe('createOllamaProvider', () => {
  it('streams text and returns it as a canonical text block when no tools are called', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      ndjsonResponse([
        { message: { role: 'assistant', content: 'Hel' }, done: false },
        { message: { role: 'assistant', content: 'lo!' }, done: true },
      ])
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOllamaProvider('http://localhost:11434', 'llama3.1');
    const onEvent = vi.fn();
    const result = await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'hi',
      tools: [],
      ctx: fakeCtx(),
      onEvent,
    });

    expect(result).toEqual([{ type: 'text', text: 'Hello!' }]);
    expect(onEvent).toHaveBeenCalledWith({ type: 'text-delta', text: 'Hel' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'text-delta', text: 'lo!' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'turn-complete' });
  });

  it('runs a called tool and sends its result back before producing the final answer', async () => {
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
          },
        ])
      )
      .mockResolvedValueOnce(ndjsonResponse([{ message: { role: 'assistant', content: 'It is sunny.' }, done: true }]));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOllamaProvider('http://localhost:11434', 'llama3.1');
    const onEvent = vi.fn();
    const result = await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'weather?',
      tools: [tool],
      ctx: fakeCtx(),
      onEvent,
    });

    expect(result).toEqual([{ type: 'text', text: 'It is sunny.' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledWith({ type: 'tool-status', toolName: 'get_weather', toolLabel: 'Get weather' });
  });

  it('throws a clear ProviderError when Ollama is not reachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const provider = createOllamaProvider('http://localhost:11434', 'llama3.1');
    await expect(
      provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx: fakeCtx(), onEvent: vi.fn() })
    ).rejects.toThrow(ProviderError);
  });

  it('throws a clear ProviderError on a non-ok HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    const provider = createOllamaProvider('http://localhost:11434', 'not-pulled-model');
    await expect(
      provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx: fakeCtx(), onEvent: vi.fn() })
    ).rejects.toThrow(ProviderError);
  });
});

describe('listOllamaModels', () => {
  it('returns the locally-pulled model names', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5:7b' }] }), { status: 200 }))
    );
    const models = await listOllamaModels('http://localhost:11434');
    expect(models).toEqual([{ name: 'llama3.1:8b' }, { name: 'qwen2.5:7b' }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/main/ai/providers/ollama.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/main/ai/providers/ollama.ts`:

```typescript
import type { ToolContext, ToolDefinition } from '../tools/types';
import { ProviderError, type AIProvider, type CanonicalTextBlock, type StreamEvent, type TurnMessage } from './types';

interface OllamaTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
}

interface OllamaChatChunk {
  message: OllamaMessage;
  done: boolean;
}

export function toOllamaTools(tools: ToolDefinition[]): OllamaTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.schema.name,
      description: tool.schema.description,
      parameters: tool.schema.input_schema,
    },
  }));
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is CanonicalTextBlock => {
      return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text';
    })
    .map((block) => block.text)
    .join('');
}

export function toOllamaMessages(system: string, history: TurnMessage[], userText: string): OllamaMessage[] {
  return [
    { role: 'system', content: system },
    ...history.map((m) => ({ role: m.role, content: textOf(m.content) }) as OllamaMessage),
    { role: 'user', content: userText },
  ];
}

/** Ollama's own body isn't valid JSON as a whole -- one JSON object per
 *  line, the last one carrying done:true. */
async function readChatStream(
  response: Response,
  onTextDelta: (text: string) => void
): Promise<{ content: string; toolCalls: OllamaMessage['tool_calls'] }> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError('Ollama returned no response body.');
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let toolCalls: OllamaMessage['tool_calls'];

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
    }
  }

  return { content, toolCalls };
}

async function runOneTool(
  tools: ToolDefinition[],
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const tool = tools.find((t) => t.schema.name === name);
  if (!tool) return `Unknown tool: ${name}`;
  return tool.run(args, ctx);
}

/**
 * `endpoint` and `model` are fixed at construction. Unlike the cloud
 * providers, there is no API key -- Ollama is trusted purely by which
 * machine can reach the endpoint, same as any other localhost service.
 */
export function createOllamaProvider(endpoint: string, model: string): AIProvider {
  return {
    async streamTurn({ system, history, userText, tools, ctx, onEvent }) {
      const toolLabels = new Map(tools.map((tool) => [tool.schema.name, tool.label]));
      const ollamaTools = toOllamaTools(tools);
      const messages = toOllamaMessages(system, history, userText);

      let finalText = '';
      // Same manual-tool-loop safety valve as gemini.ts -- a hard cap so a
      // model that keeps calling tools can never loop this turn forever.
      const MAX_ROUNDS = 20;

      try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const response = await fetch(`${endpoint}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model,
              messages,
              tools: ollamaTools.length > 0 ? ollamaTools : undefined,
              stream: true,
            }),
          });
          if (!response.ok) {
            throw new ProviderError(
              `Ollama returned an error (${response.status}). Is the model pulled and Ollama running?`
            );
          }

          const { content, toolCalls } = await readChatStream(response, (text) => {
            onEvent({ type: 'text-delta', text } satisfies StreamEvent);
          });
          finalText = content;
          messages.push({ role: 'assistant', content });

          if (!toolCalls || toolCalls.length === 0) break;

          for (const call of toolCalls) {
            const toolLabel = toolLabels.get(call.function.name) ?? call.function.name;
            onEvent({ type: 'tool-status', toolName: call.function.name, toolLabel } satisfies StreamEvent);
            const result = await runOneTool(tools, ctx, call.function.name, call.function.arguments);
            messages.push({ role: 'tool', content: result, tool_name: call.function.name });
          }
        }
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (error instanceof TypeError) {
          // fetch() throws a plain TypeError for a connection-level failure
          // (e.g. nothing listening at this endpoint) -- a normal, expected
          // fallback trigger, not a bug to show a raw stack trace for.
          throw new ProviderError(`Couldn't reach Ollama at ${endpoint}. Is it running?`);
        }
        throw error;
      }

      onEvent({ type: 'turn-complete' } satisfies StreamEvent);
      return [{ type: 'text', text: finalText }] satisfies CanonicalTextBlock[];
    },
  };
}

export interface OllamaModelInfo {
  name: string;
}

/** Powers Settings' live model dropdown -- what's actually pulled locally,
 *  not a static catalog (see catalog.ts). */
export async function listOllamaModels(endpoint: string): Promise<OllamaModelInfo[]> {
  const response = await fetch(`${endpoint}/api/tags`);
  if (!response.ok) throw new Error(`Ollama returned an error (${response.status}).`);
  const body = (await response.json()) as { models?: Array<{ name?: string }> };
  return (body.models ?? [])
    .filter((m): m is { name: string } => typeof m.name === 'string')
    .map((m) => ({ name: m.name }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/main/ai/providers/ollama.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/providers/ollama.ts src/main/ai/providers/ollama.test.ts
git commit -m "Add the Ollama provider adapter"
```

---

## Task 7: FallbackProvider (safety-critical — extra reviewer scrutiny warranted)

This is the task the Global Constraints' cost-rank-ceiling rule binds most directly. Give it the same extra scrutiny this project gave Phase 5b's `ALWAYS_CONFIRM` tier task.

**Files:**
- Create: `src/main/ai/providers/fallback.ts`
- Create: `src/main/ai/providers/fallback.test.ts`

**Interfaces:**
- Consumes: `AIProvider`, `StreamEvent`, `ProviderId` (Task 1, `./types`).
- Produces: `RankedEntry { providerId: ProviderId; model: string; displayName: string; costRank: number; provider: AIProvider }`, `FallbackOptions { pinned?: { providerId: ProviderId; model: string } }`, `RetryableFallbackProvider extends AIProvider { retryEntry(providerId: ProviderId, model: string): void }`, `createFallbackProvider(entries: RankedEntry[], options?: FallbackOptions): RetryableFallbackProvider`.

- [ ] **Step 1: Write the failing tests**

Create `src/main/ai/providers/fallback.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/main/ai/providers/fallback.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/main/ai/providers/fallback.ts`:

```typescript
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
          const next = nextCandidate(current.costRank, triedThisTurn);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/main/ai/providers/fallback.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/providers/fallback.ts src/main/ai/providers/fallback.test.ts
git commit -m "Add FallbackProvider: ordered retry with sticky failures and a cost-rank ceiling"
```

---

## Task 8: router.ts — wire everything together

This task rewrites `router.ts` (Task 1's simple single-provider version) into the full multi-provider, ranked, cached, cost-rank-aware router. It replaces Task 1's `router.test.ts` contents entirely.

**Files:**
- Modify: `src/main/ai/router.ts`
- Modify: `src/main/ai/router.test.ts`

**Interfaces:**
- Consumes: `getStoredApiKey` (existing, `./apiKey`); `getGeminiKey`, `getOllamaEndpoint`, `getPinnedEntry` (Task 3, `./providerConfig`); `getRanking` (Task 4, `./providerRanking`); `CATALOG`, `OLLAMA_COST_RANK`, `findCatalogEntry` (Task 2, `./providers/catalog`); `createClaudeProvider` (Task 1, `./providers/claude`); `createGeminiProvider` (Task 5, `./providers/gemini`); `createOllamaProvider` (Task 6, `./providers/ollama`); `createFallbackProvider`, `RankedEntry` (Task 7, `./providers/fallback`); `ProviderError`, `AIProvider`, `ProviderId` (Task 1, `./providers/types`).
- Produces: `getProvider(db: Database.Database): AIProvider` (same signature as Task 1, new implementation), `resetProviderCache(): void`, `retryProviderEntry(db: Database.Database, providerId: ProviderId, model: string): void`.

**A critical, easy-to-miss detail:** caching is not optional here — `createFallbackProvider`'s `failed` Set lives inside the object it returns. If `getProvider(db)` constructed a brand-new `FallbackProvider` on every call (i.e. every chat message), the sticky-failure memory required by this plan's Global Constraints would never actually persist across messages, silently defeating "remember and skip" and behaving like "always retry the top entry first" instead — exactly the behavior the user explicitly said they did not want. `resetProviderCache()` must be the *only* way the cache is cleared, and every settings-mutating IPC handler for AI providers (Task 9) must call it after writing.

- [ ] **Step 1: Write the failing tests (replacing router.test.ts entirely)**

Replace the full contents of `src/main/ai/router.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { setStoredApiKey } from './apiKey';
import { setGeminiKey, setOllamaEndpoint } from './providerConfig';
import { setRanking } from './providerRanking';
import { ProviderError } from './providers/types';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

const INIT_SQL = `create table settings (key text primary key, value text not null);`;
const RANKING_SQL = `create table ai_provider_ranking (rank integer primary key, provider text not null, model text not null);`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db, [
    { filename: '0001_init.sql', sql: INIT_SQL },
    { filename: '0007_ai_providers.sql', sql: RANKING_SQL },
  ]);
  return db;
}

function fakeParams() {
  return {
    system: 's',
    history: [],
    userText: 'hi',
    tools: [],
    ctx: { db: {} as never, conversationId: 'c1', mode: 'ask' as const, requestConfirmation: vi.fn() },
    onEvent: vi.fn(),
  };
}

describe('getProvider', () => {
  beforeEach(async () => {
    const { resetProviderCache } = await import('./router');
    resetProviderCache();
  });

  it('throws when nothing is ranked at all', async () => {
    const { getProvider } = await import('./router');
    const db = makeDb();
    await expect(getProvider(db).streamTurn(fakeParams())).rejects.toThrow(ProviderError);
  });

  it('skips a ranked entry whose credentials are missing rather than failing the whole list', async () => {
    const { getProvider } = await import('./router');
    const db = makeDb();
    setGeminiKey(db, 'gm-test');
    setRanking(db, [
      { providerId: 'anthropic', model: 'claude-sonnet-5' }, // no Anthropic key stored
      { providerId: 'gemini', model: 'gemini-2.5-flash' },
    ]);
    const provider = getProvider(db);
    expect(typeof provider.streamTurn).toBe('function');
  });

  it('caches the provider across calls so in-session failure memory survives, until reset', async () => {
    const { getProvider } = await import('./router');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    setRanking(db, [{ providerId: 'anthropic', model: 'claude-sonnet-5' }]);
    const first = getProvider(db);
    const second = getProvider(db);
    expect(first).toBe(second);
  });

  it('resetProviderCache forces the next call to rebuild from current settings', async () => {
    const { getProvider, resetProviderCache } = await import('./router');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    setRanking(db, [{ providerId: 'anthropic', model: 'claude-sonnet-5' }]);
    const first = getProvider(db);
    resetProviderCache();
    const second = getProvider(db);
    expect(first).not.toBe(second);
  });

  it('builds an Ollama entry using the configured endpoint, needing no key', async () => {
    const { getProvider } = await import('./router');
    const db = makeDb();
    setOllamaEndpoint(db, 'http://192.168.1.50:11434');
    setRanking(db, [{ providerId: 'ollama', model: 'llama3.1' }]);
    const provider = getProvider(db);
    expect(typeof provider.streamTurn).toBe('function');
  });
});

describe('retryProviderEntry', () => {
  it('clears one entry’s failure memory without wiping the whole cache', async () => {
    const { getProvider, resetProviderCache, retryProviderEntry } = await import('./router');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    setGeminiKey(db, 'gm-test');
    resetProviderCache();
    setRanking(db, [
      { providerId: 'anthropic', model: 'claude-sonnet-5' },
      { providerId: 'gemini', model: 'gemini-2.5-flash' },
    ]);
    const before = getProvider(db);
    retryProviderEntry(db, 'anthropic', 'claude-sonnet-5');
    const after = getProvider(db);
    // retryProviderEntry must not have reset the whole cache -- same instance.
    expect(before).toBe(after);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/main/ai/router.test.ts`
Expected: FAIL — `router.ts` still returns the simple single-provider shape from Task 1, with no `resetProviderCache`/`retryProviderEntry` exports.

- [ ] **Step 3: Implement**

Replace the full contents of `src/main/ai/router.ts`:

```typescript
import type Database from 'better-sqlite3';
import { getStoredApiKey } from './apiKey';
import { getGeminiKey, getOllamaEndpoint, getPinnedEntry } from './providerConfig';
import { getRanking } from './providerRanking';
import { OLLAMA_COST_RANK, findCatalogEntry } from './providers/catalog';
import { createClaudeProvider } from './providers/claude';
import { createFallbackProvider, type RankedEntry } from './providers/fallback';
import { createGeminiProvider } from './providers/gemini';
import { createOllamaProvider } from './providers/ollama';
import { ProviderError, type AIProvider, type ProviderId } from './providers/types';

function displayNameFor(providerId: ProviderId, model: string): string {
  if (providerId === 'ollama') return `Ollama — ${model}`;
  return findCatalogEntry(providerId, model)?.displayName ?? `${providerId} — ${model}`;
}

function costRankFor(providerId: ProviderId, model: string): number {
  if (providerId === 'ollama') return OLLAMA_COST_RANK;
  return findCatalogEntry(providerId, model)?.costRank ?? Number.MAX_SAFE_INTEGER;
}

function buildProvider(db: Database.Database, providerId: ProviderId, model: string): AIProvider | null {
  if (providerId === 'anthropic') {
    const apiKey = getStoredApiKey(db);
    return apiKey === null ? null : createClaudeProvider(apiKey, model);
  }
  if (providerId === 'gemini') {
    const apiKey = getGeminiKey(db);
    return apiKey === null ? null : createGeminiProvider(apiKey, model);
  }
  return createOllamaProvider(getOllamaEndpoint(db), model);
}

let cached: AIProvider | null = null;

/**
 * Builds (or reuses) a single FallbackProvider wired to whatever is
 * currently configured. Cached until resetProviderCache() is called so the
 * in-session failure memory a FallbackProvider accumulates survives across
 * turns -- constructing a brand new one on every message would throw that
 * memory away and defeat the whole point of "remember and skip" (see this
 * task's own Global Constraint). Every AI-provider Settings write must call
 * resetProviderCache() after persisting.
 */
export function getProvider(db: Database.Database): AIProvider {
  if (cached) return cached;

  const ranking = getRanking(db);
  const entries: RankedEntry[] = [];
  for (const { providerId, model } of ranking) {
    const provider = buildProvider(db, providerId, model);
    if (provider === null) continue; // credentials missing for this entry -- skip, don't fail the whole list
    entries.push({
      providerId,
      model,
      displayName: displayNameFor(providerId, model),
      costRank: costRankFor(providerId, model),
      provider,
    });
  }

  if (entries.length === 0) {
    cached = {
      async streamTurn() {
        throw new ProviderError('No AI provider is configured — add one in Settings.');
      },
    };
    return cached;
  }

  const pinned = getPinnedEntry(db) ?? undefined;
  cached = createFallbackProvider(entries, { pinned });
  return cached;
}

/** Called by the AI-provider Settings IPC handlers after any config change
 *  (a new key, a reordered ranking, a new pin) so the next message picks up
 *  the change immediately instead of reusing a stale cached provider. */
export function resetProviderCache(): void {
  cached = null;
}

/** Exposes the live FallbackProvider's retry hook to Settings' "retry"
 *  button, if the current provider actually is one (it might be the single
 *  not-configured stub, which has no failure memory to clear). */
export function retryProviderEntry(db: Database.Database, providerId: ProviderId, model: string): void {
  const provider = getProvider(db);
  if ('retryEntry' in provider) {
    (provider as { retryEntry: (p: ProviderId, m: string) => void }).retryEntry(providerId, model);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/main/ai/router.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/router.ts src/main/ai/router.test.ts
git commit -m "Wire the ranked provider list and fallback engine into router.ts"
```

---

## Task 9: IPC handlers and preload bridge

**Files:**
- Modify: `src/main/ai/ipc.ts`
- Create: `src/main/ai/ipc.test.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: `hasGeminiKey`, `getGeminiKey` (not exposed), `setGeminiKey`, `clearGeminiKey`, `getOllamaEndpoint`, `setOllamaEndpoint`, `PinnedEntry`, `getPinnedEntry`, `setPinnedEntry`, `clearPinnedEntry` (Task 3, `./providerConfig`); `RankingEntry`, `getRanking`, `setRanking` (Task 4, `./providerRanking`); `CATALOG` (Task 2, `./providers/catalog`); `listOllamaModels` (Task 6, `./providers/ollama`); `resetProviderCache`, `retryProviderEntry` (Task 8, `./router`); `ProviderId` (Task 1, `./providers/types`).
- Produces: new IPC channels `ai:get-catalog`, `ai:get-gemini-key-status`, `ai:set-gemini-key`, `ai:clear-gemini-key`, `ai:get-ollama-endpoint`, `ai:set-ollama-endpoint`, `ai:list-ollama-models`, `ai:get-ranking`, `ai:set-ranking`, `ai:get-pinned-entry`, `ai:set-pinned-entry`, `ai:clear-pinned-entry`, `ai:retry-provider-entry`; matching methods under `window.smartlife.ai`.

**Note on preload's own type duplication:** `src/preload/index.ts` does NOT import types from `src/main` — it deliberately defines its own local, duplicate interfaces for everything the bridge exposes (see the existing `StreamEvent`/`ConfirmRequest`/`AiMessage` interfaces near the top of the file). Follow that same convention for the new types below; do not import from `../main/...`.

- [ ] **Step 1: Write the failing tests**

Create `src/main/ai/ipc.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const routerMocks = {
  getProvider: vi.fn(),
  resetProviderCache: vi.fn(),
  retryProviderEntry: vi.fn(),
};

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));
vi.mock('./router', () => routerMocks);

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null);');
  db.exec('create table ai_provider_ranking (rank integer primary key, provider text not null, model text not null);');
  db.exec(
    `create table ai_conversations (id text primary key, title text, created_at text not null default (datetime('now')), updated_at text not null default (datetime('now')));`
  );
  db.exec(
    `create table ai_messages (id text primary key, conversation_id text not null references ai_conversations(id) on delete cascade, role text not null, content text not null, created_at text not null default (datetime('now')));`
  );
  return db;
}

async function setup() {
  handlers.clear();
  vi.clearAllMocks();
  const { registerAiIpcHandlers } = await import('./ipc');
  const db = makeDb();
  registerAiIpcHandlers(db, () => null);
  return { call: (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as never, ...args) };
}

describe('AI provider IPC handlers', () => {
  it('reports the static catalog', async () => {
    const { call } = await setup();
    const catalog = await call('ai:get-catalog');
    expect(Array.isArray(catalog)).toBe(true);
    expect((catalog as unknown[]).length).toBeGreaterThan(0);
  });

  it('round-trips a Gemini key and resets the provider cache on both save and clear', async () => {
    const { call } = await setup();
    expect(await call('ai:get-gemini-key-status')).toBe(false);
    await call('ai:set-gemini-key', 'gm-test-key');
    expect(await call('ai:get-gemini-key-status')).toBe(true);
    expect(routerMocks.resetProviderCache).toHaveBeenCalledTimes(1);
    await call('ai:clear-gemini-key');
    expect(await call('ai:get-gemini-key-status')).toBe(false);
    expect(routerMocks.resetProviderCache).toHaveBeenCalledTimes(2);
  });

  it('round-trips the Ollama endpoint and resets the provider cache on save', async () => {
    const { call } = await setup();
    expect(await call('ai:get-ollama-endpoint')).toBe('http://localhost:11434');
    await call('ai:set-ollama-endpoint', 'http://192.168.1.50:11434');
    expect(await call('ai:get-ollama-endpoint')).toBe('http://192.168.1.50:11434');
    expect(routerMocks.resetProviderCache).toHaveBeenCalledTimes(1);
  });

  it('round-trips the ranked list and resets the provider cache on save', async () => {
    const { call } = await setup();
    expect(await call('ai:get-ranking')).toEqual([]);
    await call('ai:set-ranking', [{ providerId: 'anthropic', model: 'claude-sonnet-5' }]);
    expect(await call('ai:get-ranking')).toEqual([{ providerId: 'anthropic', model: 'claude-sonnet-5' }]);
    expect(routerMocks.resetProviderCache).toHaveBeenCalledTimes(1);
  });

  it('round-trips the pinned entry and resets the provider cache on both set and clear', async () => {
    const { call } = await setup();
    expect(await call('ai:get-pinned-entry')).toBeNull();
    await call('ai:set-pinned-entry', { providerId: 'gemini', model: 'gemini-2.5-pro' });
    expect(await call('ai:get-pinned-entry')).toEqual({ providerId: 'gemini', model: 'gemini-2.5-pro' });
    expect(routerMocks.resetProviderCache).toHaveBeenCalledTimes(1);
    await call('ai:clear-pinned-entry');
    expect(await call('ai:get-pinned-entry')).toBeNull();
    expect(routerMocks.resetProviderCache).toHaveBeenCalledTimes(2);
  });

  it('delegates a retry request to router.retryProviderEntry with the given provider and model', async () => {
    const { call } = await setup();
    await call('ai:retry-provider-entry', 'anthropic', 'claude-sonnet-5');
    expect(routerMocks.retryProviderEntry).toHaveBeenCalledWith(expect.anything(), 'anthropic', 'claude-sonnet-5');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/main/ai/ipc.test.ts`
Expected: FAIL — the new channels don't exist yet.

- [ ] **Step 3: Add the new handlers to ipc.ts**

In `src/main/ai/ipc.ts`, add these imports alongside the existing ones:

```typescript
import { clearGeminiKey, clearPinnedEntry, getOllamaEndpoint, getPinnedEntry, hasGeminiKey, setGeminiKey, setOllamaEndpoint, setPinnedEntry, type PinnedEntry } from './providerConfig';
import { getRanking, setRanking, type RankingEntry } from './providerRanking';
import { CATALOG } from './providers/catalog';
import { listOllamaModels } from './providers/ollama';
import type { ProviderId } from './providers/types';
import { resetProviderCache, retryProviderEntry } from './router';
```

Add these handler registrations inside `registerAiIpcHandlers`, after the existing `ai:get-history` handler:

```typescript
  ipcMain.handle('ai:get-catalog', () => CATALOG);

  ipcMain.handle('ai:get-gemini-key-status', () => hasGeminiKey(db));
  ipcMain.handle('ai:set-gemini-key', (_event, apiKey: string) => {
    setGeminiKey(db, apiKey);
    resetProviderCache();
  });
  ipcMain.handle('ai:clear-gemini-key', () => {
    clearGeminiKey(db);
    resetProviderCache();
  });

  ipcMain.handle('ai:get-ollama-endpoint', () => getOllamaEndpoint(db));
  ipcMain.handle('ai:set-ollama-endpoint', (_event, endpoint: string) => {
    setOllamaEndpoint(db, endpoint);
    resetProviderCache();
  });
  ipcMain.handle('ai:list-ollama-models', () => listOllamaModels(getOllamaEndpoint(db)));

  ipcMain.handle('ai:get-ranking', () => getRanking(db));
  ipcMain.handle('ai:set-ranking', (_event, entries: RankingEntry[]) => {
    setRanking(db, entries);
    resetProviderCache();
  });

  ipcMain.handle('ai:get-pinned-entry', () => getPinnedEntry(db));
  ipcMain.handle('ai:set-pinned-entry', (_event, entry: PinnedEntry) => {
    setPinnedEntry(db, entry);
    resetProviderCache();
  });
  ipcMain.handle('ai:clear-pinned-entry', () => {
    clearPinnedEntry(db);
    resetProviderCache();
  });

  ipcMain.handle('ai:retry-provider-entry', (_event, providerId: ProviderId, model: string) => {
    retryProviderEntry(db, providerId, model);
  });
```

- [ ] **Step 4: Run the ipc tests to verify they pass**

Run: `npm test -- src/main/ai/ipc.test.ts`
Expected: PASS

- [ ] **Step 5: Extend the preload bridge**

In `src/preload/index.ts`, add these local interfaces near the top of the file, alongside the existing `StreamEvent`/`ConfirmRequest`/`AiMessage` interfaces (and extend `StreamEvent`'s existing `type` union to include `'provider-switched'` plus `from`/`to`/`reason?: string` fields):

```typescript
interface CatalogEntry {
  providerId: 'anthropic' | 'gemini';
  model: string;
  displayName: string;
  costRank: number;
}

interface OllamaModelInfo {
  name: string;
}

type ProviderId = 'anthropic' | 'gemini' | 'ollama';

interface RankingEntry {
  providerId: ProviderId;
  model: string;
}

interface PinnedEntry {
  providerId: ProviderId;
  model: string;
}
```

Update the existing `StreamEvent` interface's `type` field:

```typescript
interface StreamEvent {
  type: 'text-delta' | 'tool-status' | 'turn-complete' | 'provider-switched';
  text?: string;
  toolName?: string;
  toolLabel?: string;
  from?: string;
  to?: string;
  reason?: string;
}
```

Add these methods inside the existing `ai: {` object, after `getPendingConfirmation`/`onConfirmResolved`:

```typescript
    getCatalog: (): Promise<CatalogEntry[]> => ipcRenderer.invoke('ai:get-catalog'),
    getGeminiKeyStatus: (): Promise<boolean> => ipcRenderer.invoke('ai:get-gemini-key-status'),
    setGeminiKey: (apiKey: string): Promise<void> => ipcRenderer.invoke('ai:set-gemini-key', apiKey),
    clearGeminiKey: (): Promise<void> => ipcRenderer.invoke('ai:clear-gemini-key'),
    getOllamaEndpoint: (): Promise<string> => ipcRenderer.invoke('ai:get-ollama-endpoint'),
    setOllamaEndpoint: (endpoint: string): Promise<void> => ipcRenderer.invoke('ai:set-ollama-endpoint', endpoint),
    listOllamaModels: (): Promise<OllamaModelInfo[]> => ipcRenderer.invoke('ai:list-ollama-models'),
    getRanking: (): Promise<RankingEntry[]> => ipcRenderer.invoke('ai:get-ranking'),
    setRanking: (entries: RankingEntry[]): Promise<void> => ipcRenderer.invoke('ai:set-ranking', entries),
    getPinnedEntry: (): Promise<PinnedEntry | null> => ipcRenderer.invoke('ai:get-pinned-entry'),
    setPinnedEntry: (entry: PinnedEntry): Promise<void> => ipcRenderer.invoke('ai:set-pinned-entry', entry),
    clearPinnedEntry: (): Promise<void> => ipcRenderer.invoke('ai:clear-pinned-entry'),
    retryProviderEntry: (providerId: ProviderId, model: string): Promise<void> =>
      ipcRenderer.invoke('ai:retry-provider-entry', providerId, model),
```

(`src/preload/index.d.ts` needs no change — it re-exports `SmartlifeApi = typeof smartlife`, auto-inferred from the runtime object literal you just extended.)

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS. Some renderer test files that fully replace `window.smartlife` (e.g. `App.test.tsx`, `Settings.test.tsx`, `ThemeProvider.test.tsx`, `AI.test.tsx`) may now fail if they construct their `ai:` mock as a fixed object literal that TypeScript checks against the widened bridge type — if so, add the new methods (as `vi.fn()` returning sensible defaults: `getCatalog` → `[]`, `getGeminiKeyStatus` → `false`, `getOllamaEndpoint` → `'http://localhost:11434'`, `listOllamaModels` → `[]`, `getRanking` → `[]`, `getPinnedEntry` → `null`, the rest → `undefined`) to each one's stub. This is a known, recurring cost of widening the bridge interface in this codebase (see the ROADMAP's cleanup-pass entry from earlier this project).

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/ai/ipc.ts src/main/ai/ipc.test.ts src/preload/index.ts
git commit -m "Expose AI provider configuration and ranking over IPC"
```

---

## Task 10: Show provider switches in the chat

**Files:**
- Modify: `src/renderer/src/ai/useConversation.ts`
- Modify: `src/renderer/src/ai/ChatPanel.tsx`
- Modify: `src/renderer/src/ai/ChatPanel.test.tsx`

**Interfaces:**
- Consumes: `StreamEvent`'s new `'provider-switched'` variant (Task 9, preload's local interface — the renderer only ever sees the shape through `window.smartlife.ai.onStreamEvent`, which is already typed via preload).
- Produces: `ChatMessage` gains an optional `kind?: 'switch-notice'` field.

**A real UX bug to avoid, not just a feature to add:** `useConversation.ts` accumulates every `text-delta` event into ONE growing message via `streamingIdRef.current`, for the whole duration of a turn. If a provider fails partway through streaming and `FallbackProvider` retries the same turn on the next provider, that next provider's fresh text must NOT be appended onto the failed provider's partial text in the same bubble — it needs its own message. `streamingIdRef.current` must be reset to `null` on `provider-switched` so the next `text-delta` starts a new bubble.

- [ ] **Step 1: Update useConversation.ts**

In `src/renderer/src/ai/useConversation.ts`, update the `ChatMessage` interface:

```typescript
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  kind?: 'switch-notice';
}
```

In the `onStreamEvent` callback (the `useEffect` that currently handles `'text-delta'`, `'tool-status'`, `'turn-complete'`), add a branch for `'provider-switched'`:

```typescript
      } else if (event.type === 'provider-switched') {
        // Next text-delta must start a fresh bubble, not append onto the
        // failed provider's partial text.
        streamingIdRef.current = null;
        setMessages((prev) => [
          ...prev,
          {
            id: `switch-${Date.now()}-${Math.random()}`,
            role: 'assistant',
            text: `Switched to ${event.to} — ${event.from} was unavailable${event.reason ? ` (${event.reason})` : ''}.`,
            kind: 'switch-notice',
          },
        ]);
      }
```

(This is an additional `else if` branch alongside the existing `'text-delta'`/`'tool-status'`/`'turn-complete'` branches inside the same `if`/`else if` chain — not a replacement of any of them.)

- [ ] **Step 2: Update ChatPanel.tsx's rendering**

In `src/renderer/src/ai/ChatPanel.tsx`, replace the `messages.map((message) => (...))` block with a version that renders a `switch-notice` message as a centered, muted note instead of a normal chat bubble:

```tsx
        {messages.map((message) =>
          message.kind === 'switch-notice' ? (
            <div
              key={message.id}
              style={{ alignSelf: 'center', color: 'var(--color-text-muted)', fontSize: 13, textAlign: 'center' }}
            >
              {message.text}
            </div>
          ) : (
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
          )
        )}
```

- [ ] **Step 3: Write a test proving the fix**

`ChatPanel`'s real props (from `ChatPanelProps` in `src/renderer/src/ai/ChatPanel.tsx`) are `messages`, `statusLabel`, `pendingConfirm`, `sending`, `apiKeyConfigured`, `input`, `onInputChange`, `onSubmit`, `onRespondToConfirm`, `onNavigateAway?`. Add a new test to `ChatPanel.test.tsx`, matching whatever import/render pattern its existing tests already use:

```tsx
  it('renders a switch-notice message centered and muted, not as a normal chat bubble', () => {
    render(
      <ChatPanel
        messages={[
          { id: '1', role: 'assistant', text: 'Partial answer from the first provider' },
          { id: '2', role: 'assistant', text: 'Switched to Gemini — Claude Sonnet 5 was unavailable (credit balance too low).', kind: 'switch-notice' },
          { id: '3', role: 'assistant', text: 'Full fresh answer from Gemini' },
        ]}
        statusLabel={null}
        pendingConfirm={null}
        sending={false}
        apiKeyConfigured={true}
        input=""
        onInputChange={vi.fn()}
        onSubmit={vi.fn()}
        onRespondToConfirm={vi.fn()}
      />
    );
    expect(screen.getByText(/switched to gemini/i)).toBeInTheDocument();
    expect(screen.getByText('Partial answer from the first provider')).toBeInTheDocument();
    expect(screen.getByText('Full fresh answer from Gemini')).toBeInTheDocument();
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/renderer/src/ai/ChatPanel.test.tsx`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/ai/useConversation.ts src/renderer/src/ai/ChatPanel.tsx src/renderer/src/ai/ChatPanel.test.tsx
git commit -m "Show a provider switch as its own chat note, not appended to a partial answer"
```

---

## Task 11: AI Providers settings — credential cards

Relocates the existing Claude API key block out of `Settings.tsx` into a new, self-contained component (following the same pattern `CalendarToggles.tsx` already establishes for a settings sub-section), and adds Gemini and Ollama credential cards alongside it. Task 12 extends this same file with the ranked-list builder; Task 13 wires it into `Settings.tsx`.

**Files:**
- Create: `src/renderer/src/routes/settings/AIProvidersSection.tsx`
- Create: `src/renderer/src/routes/settings/AIProvidersSection.test.tsx`

**Interfaces:**
- Consumes: `window.smartlife.ai.getApiKeyStatus/setApiKey` (existing), `getGeminiKeyStatus/setGeminiKey/clearGeminiKey`, `getOllamaEndpoint/setOllamaEndpoint/listOllamaModels` (Task 9).
- Produces: `AIProvidersSection()` component, exported.

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/routes/settings/AIProvidersSection.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AIProvidersSection } from './AIProvidersSection';

beforeEach(() => {
  (window as unknown as { smartlife: typeof window.smartlife }).smartlife = {
    ai: {
      getApiKeyStatus: vi.fn().mockResolvedValue(false),
      setApiKey: vi.fn().mockResolvedValue(undefined),
      getGeminiKeyStatus: vi.fn().mockResolvedValue(false),
      setGeminiKey: vi.fn().mockResolvedValue(undefined),
      clearGeminiKey: vi.fn().mockResolvedValue(undefined),
      getOllamaEndpoint: vi.fn().mockResolvedValue('http://localhost:11434'),
      setOllamaEndpoint: vi.fn().mockResolvedValue(undefined),
      listOllamaModels: vi.fn().mockResolvedValue([]),
    },
  } as unknown as typeof window.smartlife;
});

describe('AIProvidersSection — credentials', () => {
  it('renders its own labeled region', async () => {
    render(<AIProvidersSection />);
    expect(await screen.findByRole('region', { name: 'AI Providers settings' })).toBeInTheDocument();
  });

  it('shows not-connected status for Claude and Gemini, and saves a Claude key', async () => {
    render(<AIProvidersSection />);
    expect(await screen.findByText(/claude api key.*not connected/i)).toBeInTheDocument();
    expect(screen.getByText(/gemini api key.*not connected/i)).toBeInTheDocument();

    const apiKeyInput = screen.getByLabelText('Claude API key');
    await userEvent.type(apiKeyInput, 'sk-ant-test');
    await userEvent.click(screen.getByRole('button', { name: 'Save Claude key' }));

    await waitFor(() => expect(window.smartlife.ai.setApiKey).toHaveBeenCalledWith('sk-ant-test'));
    expect(await screen.findByText(/claude api key.*— connected/i)).toBeInTheDocument();
  });

  it('saves and clears a Gemini key', async () => {
    render(<AIProvidersSection />);
    await screen.findByText(/gemini api key.*not connected/i);

    const geminiInput = screen.getByLabelText('Gemini API key');
    await userEvent.type(geminiInput, 'gm-test-key');
    await userEvent.click(screen.getByRole('button', { name: 'Save Gemini key' }));
    await waitFor(() => expect(window.smartlife.ai.setGeminiKey).toHaveBeenCalledWith('gm-test-key'));
    expect(await screen.findByText(/gemini api key.*— connected/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Disconnect Gemini' }));
    await waitFor(() => expect(window.smartlife.ai.clearGeminiKey).toHaveBeenCalled());
  });

  it('loads and saves the Ollama endpoint', async () => {
    render(<AIProvidersSection />);
    await waitFor(() => expect(screen.getByLabelText('Ollama endpoint')).toHaveValue('http://localhost:11434'));

    const endpointInput = screen.getByLabelText('Ollama endpoint');
    await userEvent.clear(endpointInput);
    await userEvent.type(endpointInput, 'http://192.168.1.50:11434');
    await userEvent.click(screen.getByRole('button', { name: 'Save Ollama endpoint' }));
    await waitFor(() => expect(window.smartlife.ai.setOllamaEndpoint).toHaveBeenCalledWith('http://192.168.1.50:11434'));
  });

  it('reports the model count on a successful Ollama connection test', async () => {
    vi.mocked(window.smartlife.ai.listOllamaModels).mockResolvedValue([{ name: 'llama3.1:8b' }, { name: 'qwen2.5:7b' }]);
    render(<AIProvidersSection />);
    await userEvent.click(screen.getByRole('button', { name: 'Test Ollama connection' }));
    expect(await screen.findByText(/connected — 2 model/i)).toBeInTheDocument();
  });

  it('reports a clear error when Ollama is unreachable', async () => {
    vi.mocked(window.smartlife.ai.listOllamaModels).mockRejectedValue(new Error('fetch failed'));
    render(<AIProvidersSection />);
    await userEvent.click(screen.getByRole('button', { name: 'Test Ollama connection' }));
    expect(await screen.findByText(/couldn.t reach ollama/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/renderer/src/routes/settings/AIProvidersSection.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/renderer/src/routes/settings/AIProvidersSection.tsx`:

```tsx
import { useEffect, useState } from 'react';

const inputStyle = {
  backgroundColor: 'var(--color-surface)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
};
const primaryButtonStyle = { backgroundColor: 'var(--color-text)', color: 'var(--color-bg)', border: '1px solid var(--color-border)' };
const secondaryButtonStyle = { backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' };

export function AIProvidersSection() {
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);
  const [apiKeyError, setApiKeyError] = useState('');

  const [geminiKeyInput, setGeminiKeyInput] = useState('');
  const [geminiKeyConfigured, setGeminiKeyConfigured] = useState<boolean | null>(null);
  const [geminiKeyError, setGeminiKeyError] = useState('');

  const [ollamaEndpointInput, setOllamaEndpointInput] = useState('');
  const [ollamaMessage, setOllamaMessage] = useState('');
  const [ollamaError, setOllamaError] = useState('');

  useEffect(() => {
    window.smartlife.ai.getApiKeyStatus().then(setApiKeyConfigured);
  }, []);

  useEffect(() => {
    window.smartlife.ai.getGeminiKeyStatus().then(setGeminiKeyConfigured);
  }, []);

  useEffect(() => {
    window.smartlife.ai.getOllamaEndpoint().then(setOllamaEndpointInput);
  }, []);

  async function handleSaveApiKey(): Promise<void> {
    setApiKeyError('');
    try {
      await window.smartlife.ai.setApiKey(apiKeyInput);
      setApiKeyInput('');
      setApiKeyConfigured(true);
    } catch (err) {
      setApiKeyError(err instanceof Error ? err.message : 'Failed to save key.');
    }
  }

  async function handleSaveGeminiKey(): Promise<void> {
    setGeminiKeyError('');
    try {
      await window.smartlife.ai.setGeminiKey(geminiKeyInput);
      setGeminiKeyInput('');
      setGeminiKeyConfigured(true);
    } catch (err) {
      setGeminiKeyError(err instanceof Error ? err.message : 'Failed to save key.');
    }
  }

  async function handleClearGeminiKey(): Promise<void> {
    await window.smartlife.ai.clearGeminiKey();
    setGeminiKeyConfigured(false);
  }

  async function handleSaveOllamaEndpoint(): Promise<void> {
    setOllamaError('');
    setOllamaMessage('');
    try {
      await window.smartlife.ai.setOllamaEndpoint(ollamaEndpointInput);
      setOllamaMessage('Saved.');
    } catch (err) {
      setOllamaError(err instanceof Error ? err.message : 'Failed to save endpoint.');
    }
  }

  async function handleTestOllama(): Promise<void> {
    setOllamaError('');
    setOllamaMessage('Testing…');
    try {
      const models = await window.smartlife.ai.listOllamaModels();
      setOllamaMessage(
        models.length > 0 ? `Connected — ${models.length} model(s) available.` : 'Connected, but no models are pulled yet.'
      );
    } catch {
      setOllamaMessage('');
      setOllamaError("Couldn't reach Ollama — is it running?");
    }
  }

  return (
    <div className="flex flex-col gap-6" role="region" aria-label="AI Providers settings">
      <div className="flex flex-col gap-2">
        <span style={{ color: 'var(--color-text-muted)' }}>
          Claude API key {apiKeyConfigured === true ? '— connected' : apiKeyConfigured === false ? '— not connected' : ''}
        </span>
        <div className="flex gap-2">
          <input
            type="password"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder="sk-ant-..."
            aria-label="Claude API key"
            className="rounded-md px-3 py-1.5 text-sm"
            style={inputStyle}
          />
          <button
            type="button"
            onClick={handleSaveApiKey}
            disabled={apiKeyInput.length === 0}
            className="rounded-md px-3 py-1.5 text-sm"
            style={primaryButtonStyle}
          >
            Save Claude key
          </button>
        </div>
        {apiKeyError && <span style={{ color: '#F87171' }}>{apiKeyError}</span>}
      </div>

      <div className="flex flex-col gap-2">
        <span style={{ color: 'var(--color-text-muted)' }}>
          Gemini API key {geminiKeyConfigured === true ? '— connected' : geminiKeyConfigured === false ? '— not connected' : ''}
        </span>
        <div className="flex gap-2">
          <input
            type="password"
            value={geminiKeyInput}
            onChange={(e) => setGeminiKeyInput(e.target.value)}
            placeholder="AIza..."
            aria-label="Gemini API key"
            className="rounded-md px-3 py-1.5 text-sm"
            style={inputStyle}
          />
          <button
            type="button"
            onClick={handleSaveGeminiKey}
            disabled={geminiKeyInput.length === 0}
            className="rounded-md px-3 py-1.5 text-sm"
            style={primaryButtonStyle}
          >
            Save Gemini key
          </button>
          {geminiKeyConfigured === true && (
            <button type="button" onClick={handleClearGeminiKey} className="rounded-md px-3 py-1.5 text-sm" style={secondaryButtonStyle}>
              Disconnect Gemini
            </button>
          )}
        </div>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Get a free key at Google AI Studio (aistudio.google.com).
        </span>
        {geminiKeyError && <span style={{ color: '#F87171' }}>{geminiKeyError}</span>}
      </div>

      <div className="flex flex-col gap-2">
        <span style={{ color: 'var(--color-text-muted)' }}>Ollama endpoint</span>
        <div className="flex gap-2">
          <input
            type="text"
            value={ollamaEndpointInput}
            onChange={(e) => setOllamaEndpointInput(e.target.value)}
            placeholder="http://localhost:11434"
            aria-label="Ollama endpoint"
            className="rounded-md px-3 py-1.5 text-sm"
            style={inputStyle}
          />
          <button type="button" onClick={handleSaveOllamaEndpoint} className="rounded-md px-3 py-1.5 text-sm" style={primaryButtonStyle}>
            Save Ollama endpoint
          </button>
          <button type="button" onClick={handleTestOllama} className="rounded-md px-3 py-1.5 text-sm" style={secondaryButtonStyle}>
            Test Ollama connection
          </button>
        </div>
        {ollamaMessage && <span style={{ color: 'var(--color-text-muted)' }}>{ollamaMessage}</span>}
        {ollamaError && <span style={{ color: '#F87171' }}>{ollamaError}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/renderer/src/routes/settings/AIProvidersSection.test.tsx`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS (this component is not yet rendered anywhere, so it cannot break other tests).

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/routes/settings/AIProvidersSection.tsx src/renderer/src/routes/settings/AIProvidersSection.test.tsx
git commit -m "Add AI Providers settings: Claude/Gemini/Ollama credential cards"
```

---

## Task 12: AI Providers settings — ranked-list builder and manual pin

Extends `AIProvidersSection.tsx` (Task 11) with the fallback-order list (add/reorder/remove/retry) and the "Active model" pin control.

**Files:**
- Modify: `src/renderer/src/routes/settings/AIProvidersSection.tsx`
- Modify: `src/renderer/src/routes/settings/AIProvidersSection.test.tsx`

**Interfaces:**
- Consumes: `window.smartlife.ai.getCatalog`, `getRanking/setRanking`, `getPinnedEntry/setPinnedEntry/clearPinnedEntry`, `listOllamaModels` (already consumed in Task 11), `retryProviderEntry` (Task 9).

- [ ] **Step 1: Extend the test mock and write the failing tests**

In `src/renderer/src/routes/settings/AIProvidersSection.test.tsx`'s `beforeEach`, add these methods to the `ai:` mock object (alongside the ones from Task 11):

```typescript
      getCatalog: vi.fn().mockResolvedValue([
        { providerId: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', costRank: 3 },
        { providerId: 'gemini', model: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', costRank: 1 },
      ]),
      getRanking: vi.fn().mockResolvedValue([]),
      setRanking: vi.fn().mockResolvedValue(undefined),
      getPinnedEntry: vi.fn().mockResolvedValue(null),
      setPinnedEntry: vi.fn().mockResolvedValue(undefined),
      clearPinnedEntry: vi.fn().mockResolvedValue(undefined),
      retryProviderEntry: vi.fn().mockResolvedValue(undefined),
```

Add a new `describe` block to the same file:

```tsx
describe('AIProvidersSection — fallback ranking', () => {
  it('adds a catalog entry to the ranked list', async () => {
    render(<AIProvidersSection />);
    await screen.findByText(/claude api key/i);

    await userEvent.selectOptions(screen.getByLabelText('Provider to add'), 'gemini');
    await userEvent.selectOptions(screen.getByLabelText('Model to add'), 'gemini-2.5-flash');
    await userEvent.click(screen.getByRole('button', { name: 'Add to list' }));

    await waitFor(() =>
      expect(window.smartlife.ai.setRanking).toHaveBeenCalledWith([{ providerId: 'gemini', model: 'gemini-2.5-flash' }])
    );
    expect(await screen.findByText(/gemini 2.5 flash/i)).toBeInTheDocument();
  });

  it('reorders the list with the up/down controls', async () => {
    vi.mocked(window.smartlife.ai.getRanking).mockResolvedValue([
      { providerId: 'anthropic', model: 'claude-sonnet-5' },
      { providerId: 'gemini', model: 'gemini-2.5-flash' },
    ]);
    render(<AIProvidersSection />);
    await screen.findByText(/claude sonnet 5/i);

    await userEvent.click(screen.getByRole('button', { name: /move gemini 2.5 flash up/i }));

    await waitFor(() =>
      expect(window.smartlife.ai.setRanking).toHaveBeenCalledWith([
        { providerId: 'gemini', model: 'gemini-2.5-flash' },
        { providerId: 'anthropic', model: 'claude-sonnet-5' },
      ])
    );
  });

  it('removes an entry from the list', async () => {
    vi.mocked(window.smartlife.ai.getRanking).mockResolvedValue([{ providerId: 'anthropic', model: 'claude-sonnet-5' }]);
    render(<AIProvidersSection />);
    await screen.findByText(/claude sonnet 5/i);

    await userEvent.click(screen.getByRole('button', { name: /remove claude sonnet 5/i }));

    await waitFor(() => expect(window.smartlife.ai.setRanking).toHaveBeenCalledWith([]));
  });

  it('warns inline for an Ollama model not known to support tools well, without blocking it', async () => {
    vi.mocked(window.smartlife.ai.listOllamaModels).mockResolvedValue([{ name: 'tinyllama' }]);
    render(<AIProvidersSection />);
    await screen.findByText(/claude api key/i);

    await userEvent.selectOptions(screen.getByLabelText('Provider to add'), 'ollama');
    expect(screen.getByRole('option', { name: /tinyllama.*may not support tools well/i })).toBeInTheDocument();
  });

  it('pins a specific entry as the active model instead of Auto', async () => {
    vi.mocked(window.smartlife.ai.getRanking).mockResolvedValue([{ providerId: 'anthropic', model: 'claude-sonnet-5' }]);
    render(<AIProvidersSection />);
    await screen.findByText(/claude sonnet 5/i);

    await userEvent.selectOptions(screen.getByLabelText('Active model'), 'anthropic:claude-sonnet-5');

    await waitFor(() =>
      expect(window.smartlife.ai.setPinnedEntry).toHaveBeenCalledWith({ providerId: 'anthropic', model: 'claude-sonnet-5' })
    );
  });

  it('clears the pin back to Auto', async () => {
    vi.mocked(window.smartlife.ai.getPinnedEntry).mockResolvedValue({ providerId: 'anthropic', model: 'claude-sonnet-5' });
    vi.mocked(window.smartlife.ai.getRanking).mockResolvedValue([{ providerId: 'anthropic', model: 'claude-sonnet-5' }]);
    render(<AIProvidersSection />);
    await waitFor(() => expect(screen.getByLabelText('Active model')).toHaveValue('anthropic:claude-sonnet-5'));

    await userEvent.selectOptions(screen.getByLabelText('Active model'), 'auto');

    await waitFor(() => expect(window.smartlife.ai.clearPinnedEntry).toHaveBeenCalled());
  });

  it('retries a failed entry', async () => {
    vi.mocked(window.smartlife.ai.getRanking).mockResolvedValue([{ providerId: 'anthropic', model: 'claude-sonnet-5' }]);
    render(<AIProvidersSection />);
    await screen.findByText(/claude sonnet 5/i);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(window.smartlife.ai.retryProviderEntry).toHaveBeenCalledWith('anthropic', 'claude-sonnet-5');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/renderer/src/routes/settings/AIProvidersSection.test.tsx`
Expected: FAIL — the ranked-list UI doesn't exist yet.

- [ ] **Step 3: Implement**

In `src/renderer/src/routes/settings/AIProvidersSection.tsx`, add these type definitions above the component (the file has no other type imports yet, so define them locally, matching this codebase's established "local, duplicated shape" convention already used in `src/preload/index.ts`):

```typescript
interface CatalogEntry {
  providerId: 'anthropic' | 'gemini';
  model: string;
  displayName: string;
  costRank: number;
}
interface RankingEntry {
  providerId: 'anthropic' | 'gemini' | 'ollama';
  model: string;
}
interface OllamaModelInfo {
  name: string;
}
interface PinnedEntry {
  providerId: 'anthropic' | 'gemini' | 'ollama';
  model: string;
}

const KNOWN_GOOD_FOR_TOOLS_PREFIXES = ['llama3.1', 'llama3.2', 'qwen2.5', 'mistral-nemo'];
```

Inside the `AIProvidersSection()` function body, after the existing state declarations from Task 11, add:

```typescript
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [ollamaModels, setOllamaModels] = useState<OllamaModelInfo[]>([]);
  const [ranking, setRankingState] = useState<RankingEntry[]>([]);
  const [pinned, setPinnedState] = useState<PinnedEntry | null>(null);
  const [addProviderId, setAddProviderId] = useState<'anthropic' | 'gemini' | 'ollama'>('anthropic');
  const [addModel, setAddModel] = useState('');

  useEffect(() => {
    window.smartlife.ai.getCatalog().then(setCatalog);
  }, []);

  useEffect(() => {
    window.smartlife.ai.getRanking().then(setRankingState);
  }, []);

  useEffect(() => {
    window.smartlife.ai.getPinnedEntry().then(setPinnedState);
  }, []);

  useEffect(() => {
    window.smartlife.ai.listOllamaModels().then(setOllamaModels).catch(() => setOllamaModels([]));
  }, []);

  function modelChoicesFor(providerId: 'anthropic' | 'gemini' | 'ollama'): Array<{ model: string; label: string }> {
    if (providerId === 'ollama') {
      return ollamaModels.map((m) => ({
        model: m.name,
        label: KNOWN_GOOD_FOR_TOOLS_PREFIXES.some((p) => m.name.toLowerCase().startsWith(p))
          ? m.name
          : `${m.name} (may not support tools well)`,
      }));
    }
    return catalog.filter((entry) => entry.providerId === providerId).map((entry) => ({ model: entry.model, label: entry.displayName }));
  }

  function displayNameForEntry(entry: RankingEntry): string {
    if (entry.providerId === 'ollama') return `Ollama — ${entry.model}`;
    return catalog.find((c) => c.providerId === entry.providerId && c.model === entry.model)?.displayName ?? `${entry.providerId} — ${entry.model}`;
  }

  async function persistRanking(next: RankingEntry[]): Promise<void> {
    setRankingState(next);
    await window.smartlife.ai.setRanking(next);
  }

  async function handleAddEntry(): Promise<void> {
    if (addModel.length === 0) return;
    await persistRanking([...ranking, { providerId: addProviderId, model: addModel }]);
    setAddModel('');
  }

  async function handleRemoveEntry(index: number): Promise<void> {
    await persistRanking(ranking.filter((_, i) => i !== index));
  }

  async function handleMoveEntry(index: number, direction: -1 | 1): Promise<void> {
    const target = index + direction;
    if (target < 0 || target >= ranking.length) return;
    const next = [...ranking];
    [next[index], next[target]] = [next[target], next[index]];
    await persistRanking(next);
  }

  async function handleSetPin(entry: PinnedEntry | null): Promise<void> {
    if (entry === null) {
      await window.smartlife.ai.clearPinnedEntry();
    } else {
      await window.smartlife.ai.setPinnedEntry(entry);
    }
    setPinnedState(entry);
  }

  async function handleRetry(entry: RankingEntry): Promise<void> {
    await window.smartlife.ai.retryProviderEntry(entry.providerId, entry.model);
  }
```

Add this JSX inside the returned `<div role="region" aria-label="AI Providers settings">`, after the three credential-card blocks from Task 11 and before the closing `</div>`:

```tsx
      <div className="flex flex-col gap-2">
        <span style={{ color: 'var(--color-text-muted)' }}>Fallback order</span>
        <ol className="flex flex-col gap-1">
          {ranking.map((entry, index) => (
            <li key={`${entry.providerId}-${entry.model}`} className="flex items-center gap-2">
              <span style={{ color: 'var(--color-text)' }}>
                {index + 1}. {displayNameForEntry(entry)}
              </span>
              <button
                type="button"
                onClick={() => handleMoveEntry(index, -1)}
                disabled={index === 0}
                aria-label={`Move ${displayNameForEntry(entry)} up`}
                className="rounded-md px-2 py-1 text-xs"
                style={secondaryButtonStyle}
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => handleMoveEntry(index, 1)}
                disabled={index === ranking.length - 1}
                aria-label={`Move ${displayNameForEntry(entry)} down`}
                className="rounded-md px-2 py-1 text-xs"
                style={secondaryButtonStyle}
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => handleRemoveEntry(index)}
                aria-label={`Remove ${displayNameForEntry(entry)}`}
                className="rounded-md px-2 py-1 text-xs"
                style={secondaryButtonStyle}
              >
                Remove
              </button>
              <button type="button" onClick={() => handleRetry(entry)} className="rounded-md px-2 py-1 text-xs" style={secondaryButtonStyle}>
                Retry
              </button>
            </li>
          ))}
        </ol>
        <div className="flex gap-2">
          <select
            value={addProviderId}
            onChange={(e) => {
              setAddProviderId(e.target.value as typeof addProviderId);
              setAddModel('');
            }}
            aria-label="Provider to add"
            className="rounded-md px-3 py-1.5 text-sm"
            style={inputStyle}
          >
            <option value="anthropic">Anthropic</option>
            <option value="gemini">Gemini</option>
            <option value="ollama">Ollama</option>
          </select>
          <select value={addModel} onChange={(e) => setAddModel(e.target.value)} aria-label="Model to add" className="rounded-md px-3 py-1.5 text-sm" style={inputStyle}>
            <option value="">Select a model…</option>
            {modelChoicesFor(addProviderId).map((choice) => (
              <option key={choice.model} value={choice.model}>
                {choice.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={handleAddEntry} disabled={addModel.length === 0} className="rounded-md px-3 py-1.5 text-sm" style={primaryButtonStyle}>
            Add to list
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span style={{ color: 'var(--color-text-muted)' }}>Active model</span>
        <select
          value={pinned ? `${pinned.providerId}:${pinned.model}` : 'auto'}
          onChange={(e) => {
            if (e.target.value === 'auto') {
              handleSetPin(null);
              return;
            }
            const [providerId, model] = e.target.value.split(':') as [PinnedEntry['providerId'], string];
            handleSetPin({ providerId, model });
          }}
          aria-label="Active model"
          className="rounded-md px-3 py-1.5 text-sm"
          style={inputStyle}
        >
          <option value="auto">Auto (use the fallback order above)</option>
          {ranking.map((entry) => (
            <option key={`${entry.providerId}-${entry.model}`} value={`${entry.providerId}:${entry.model}`}>
              {displayNameForEntry(entry)}
            </option>
          ))}
        </select>
      </div>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/renderer/src/routes/settings/AIProvidersSection.test.tsx`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/routes/settings/AIProvidersSection.tsx src/renderer/src/routes/settings/AIProvidersSection.test.tsx
git commit -m "Add the fallback-order list builder and active-model pin control"
```

---

## Task 13: Wire AIProvidersSection into Settings.tsx

Removes the Claude API key block, its state, its `useEffect`, and its handler from `Settings.tsx` (now owned entirely by `AIProvidersSection`), and renders the new component in its place.

**Files:**
- Modify: `src/renderer/src/routes/Settings.tsx`
- Modify: `src/renderer/src/routes/Settings.test.tsx`
- Modify: `src/renderer/src/App.test.tsx` (and any other test file that fully replaces `window.smartlife` and also renders `<Settings/>` or `<App/>` — see Step 4)

**Interfaces:**
- Consumes: `AIProvidersSection` (Tasks 11–12, `./settings/AIProvidersSection`).

- [ ] **Step 1: Remove the old Claude key block from Settings.tsx**

In `src/renderer/src/routes/Settings.tsx`:

- Remove the state declarations: `apiKeyInput`, `apiKeyConfigured`, `apiKeyError`.
- Remove the `useEffect` that calls `window.smartlife.ai.getApiKeyStatus().then(setApiKeyConfigured)`.
- Remove the `handleSaveApiKey` function.
- Remove the entire JSX block that renders the "Claude API key" `<div className="flex flex-col gap-2">...</div>` (the block shown in this plan's research, between the theme-picker block and the "AI permission mode" block).
- Add the import: `import { AIProvidersSection } from './settings/AIProvidersSection';`
- Render `<AIProvidersSection />` exactly where the removed block used to sit — right before the "AI permission mode" block.

- [ ] **Step 2: Update Settings.test.tsx**

In `src/renderer/src/routes/Settings.test.tsx`:

- Remove the entire `describe('Settings — API key', ...)` block (its two tests — save-and-connect, and save-failure — are superseded by `AIProvidersSection.test.tsx`'s own credential tests from Task 11).
- In the `beforeEach`'s `window.smartlife.ai` mock object, add the new methods so `AIProvidersSection`'s own mount-time effects (now firing as part of every `<Settings/>` render) don't throw on a missing mock function:

```typescript
      getGeminiKeyStatus: vi.fn().mockResolvedValue(false),
      setGeminiKey: vi.fn().mockResolvedValue(undefined),
      clearGeminiKey: vi.fn().mockResolvedValue(undefined),
      getOllamaEndpoint: vi.fn().mockResolvedValue('http://localhost:11434'),
      setOllamaEndpoint: vi.fn().mockResolvedValue(undefined),
      listOllamaModels: vi.fn().mockResolvedValue([]),
      getCatalog: vi.fn().mockResolvedValue([]),
      getRanking: vi.fn().mockResolvedValue([]),
      setRanking: vi.fn().mockResolvedValue(undefined),
      getPinnedEntry: vi.fn().mockResolvedValue(null),
      setPinnedEntry: vi.fn().mockResolvedValue(undefined),
      clearPinnedEntry: vi.fn().mockResolvedValue(undefined),
      retryProviderEntry: vi.fn().mockResolvedValue(undefined),
```

- Add one small test confirming the region renders as part of the real Settings page (not re-testing its internals, which Task 11/12 already cover):

```tsx
describe('Settings — AI Providers', () => {
  it('renders the AI Providers settings region', async () => {
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    );
    expect(await screen.findByRole('region', { name: 'AI Providers settings' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the Settings tests to verify they pass**

Run: `npm test -- src/renderer/src/routes/Settings.test.tsx`
Expected: PASS

- [ ] **Step 4: Find and update every other test file that fully replaces window.smartlife**

Run: `grep -rl "smartlife = {" src/renderer/src --include="*.test.tsx"`

For each file this finds that constructs an `ai:` mock object as a fixed literal (not a factory function returning fresh mocks, like `AI.test.tsx`'s `mockAi()`), add the same 13 methods from Step 2 to its `ai:` mock, with the same default return values. `App.test.tsx` is known to need this (it stubs a full `window.smartlife.ai` and its route tree includes `/settings`). For any file using a factory function instead (e.g. `AI.test.tsx`'s `mockAi()`), only add the methods if running its test file actually fails without them — its own rendered component may not mount `AIProvidersSection` at all.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS, all green — this is the task that proves every stub file was actually found and fixed, not just the ones explicitly named above.

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Manually verify the packaged app**

Run: `npm run package`
Expected: Builds `SmartLife.app` with no errors (code signing skip is expected and fine).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/routes/Settings.tsx src/renderer/src/routes/Settings.test.tsx src/renderer/src/App.test.tsx
git commit -m "Render AI Providers settings inside the Settings page"
```

(If Step 4 touched additional files beyond `App.test.tsx`, add them to this commit too.)

---

## Manual smoke checklist

Deferred to the packaged app, not automatable:

- Add a real Anthropic key, a real Gemini key (free, from Google AI Studio), and run Ollama locally with a pulled model (e.g. `ollama pull llama3.1`) — rank all three, send a message, confirm the top-ranked one answers.
- Deliberately make the top-ranked provider fail (e.g. an invalid Gemini key) with it ranked above a working one — confirm the chat shows the "Switched to..." note and still gets a real answer, without the failed provider being retried on the next message.
- Add a cheap entry and an expensive entry from the same provider (e.g. Haiku and Opus) with the cheap one on top; make the cheap one fail — confirm it falls to another cheap/mid entry but never silently reaches Opus without being asked.
- Pin a specific entry in Settings, confirm chat only ever uses that one; make it fail, confirm fallback still respects the cost-rank ceiling from the pin, not from the ranked list's own top.
- Add a local Ollama model NOT in the known-good-for-tools list, confirm the warning shows in Settings but the model is still selectable and usable.
- Use the "Retry" button in Settings on a failed entry after fixing the underlying problem (e.g. adding credits), confirm the next message tries it again instead of skipping straight past it.

## Self-Review

**Spec coverage:** Every section of the design spec has a task: canonical content shape and provider-neutral history (Task 1), the three provider adapters (Tasks 1, 5, 6), the fallback engine with sticky failures and the cost-rank ceiling (Task 7), the manual pin (Tasks 3, 7, 8, 12), the static catalog and Ollama tool-support warning (Tasks 2, 12), storage following the existing table-per-list convention (Tasks 3, 4), the Settings UI (Tasks 11, 12, 13), and the visible switch notice (Task 10). The spec's explicit out-of-scope list (in-chat quick-switcher, permission-mode changes, automatic task-complexity detection, live Anthropic/Gemini catalog queries, OpenRouter, mid-turn cross-provider resume) has no corresponding task, by design.

**Placeholder scan:** No "TBD"/"TODO"/"add appropriate error handling" language anywhere in this plan — every step has complete, runnable code.

**Type consistency:** `ProviderId` (Task 1) is used identically by every later task. `CanonicalTextBlock` (Task 1) is produced and consumed identically by `claude.ts`, `gemini.ts`, `ollama.ts`, and `fallback.ts`. `RankedEntry` (Task 7) matches exactly what `router.ts` (Task 8) constructs. `RankingEntry`/`PinnedEntry`/`CatalogEntry` are each defined once (Tasks 4, 3, 2 respectively) and referenced with the same field names everywhere they're consumed, including the renderer's own locally-duplicated copies in `preload/index.ts` (Task 9) and `AIProvidersSection.tsx` (Task 12), matching this codebase's established convention of not cross-importing types between the main and preload/renderer processes.
