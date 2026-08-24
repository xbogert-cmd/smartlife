# Task 6 Report: Ollama provider adapter

## What was done

Implemented the third concrete `AIProvider`, `src/main/ai/providers/ollama.ts`, following the brief verbatim:

- `toOllamaTools(tools)` — maps `ToolDefinition[]` to OpenAI-shaped `{ type: 'function', function: {...} }` tool descriptors for Ollama's `/api/chat`.
- `toOllamaMessages(system, history, userText)` — builds the message array: system prompt first, then `TurnMessage[]` history (text blocks flattened via `textOf`), then the new user message.
- `createOllamaProvider(endpoint, model)` — returns an `AIProvider` whose `streamTurn` POSTs to `${endpoint}/api/chat` with `stream: true`, reads the response body as NDJSON via `readChatStream` (one JSON object per line, accumulating `content` and the latest `tool_calls`), emits `text-delta` events as chunks arrive, and on a tool call runs it via `runOneTool`, emits `tool-status`, appends a `role: 'tool'` message with the result, and loops (capped at `MAX_ROUNDS = 20`, mirroring gemini.ts's safety valve) until the model stops calling tools. Emits `turn-complete` and returns `[{ type: 'text', text: finalText }]`.
- Connection failures (`fetch` throwing `TypeError`) and non-OK HTTP responses both surface as `ProviderError` with a clear, actionable message ("Couldn't reach Ollama at ...", "Ollama returned an error (404). Is the model pulled and Ollama running?").
- `listOllamaModels(endpoint)` — GETs `/api/tags`, returns the locally-pulled model names as `OllamaModelInfo[]`, filtering out any entries missing a string `name`.

Test file `src/main/ai/providers/ollama.test.ts` was written exactly as specified in the brief, including the two tool-calling round-trip tests that exercise a real `Response`/`ReadableStream` via the `ndjsonResponse` helper (not just pure-function unit tests) — this coverage was kept intact, not trimmed.

## Deviations from the brief

None. Both files were created verbatim from the brief's Step 1 and Step 3 code blocks. No changes were needed to make the tests pass — first run after implementation was green.

## Test results

- Scoped run (`npm test -- src/main/ai/providers/ollama.test.ts`): 7/7 passed.
- Full suite (`npm test`, run twice for consistency): **1149/1150 passed, 1 failed** both times — `src/renderer/src/routes/Home.test.tsx > Home route > shows an assignment due earlier today in the Today agenda`. This is the pre-flagged, pre-existing midnight-boundary date flake, unrelated to this change (ollama.ts touches no date/Home logic). No other failures.
- `npm run typecheck`: clean, no errors.

## Commit

`a6a13e3` — "Add the Ollama provider adapter" (`src/main/ai/providers/ollama.ts`, `src/main/ai/providers/ollama.test.ts`).

## Fix: two Important review findings (task review follow-up)

### Finding 1 — tool round-trip test didn't verify the resent request body

`'runs a called tool and sends its result back before producing the final answer'` asserted only call count and the final (canned) text, so a bug that dropped or mangled the tool result before the second `fetch` would not have been caught. Added, right after `expect(fetchMock).toHaveBeenCalledTimes(2);`:

```typescript
const secondCallBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
expect(secondCallBody.messages).toContainEqual({ role: 'tool', content: 'Sunny, 72F', tool_name: 'get_weather' });
```

This checks the actual shape `streamTurn` appends to `messages` (`{ role: 'tool', content: result, tool_name: call.function.name }`) and re-sends as the second call's request body.

### Finding 2 — no test forced a genuine multi-`read()` NDJSON line split

`readChatStream`'s partial-line buffering (`buffer = lines.pop() ?? ''`) was implemented but never exercised by a test that forces the reader to receive an incomplete line across two separate `reader.read()` calls — `ndjsonResponse` builds a `Response` from a plain string, which risks arriving as one chunk.

Added `'correctly reassembles an NDJSON line that arrives split across two stream reads'`. It builds a single NDJSON line, splits it at the midpoint, and enqueues each half from a custom `ReadableStream`.

**The brief's suggested construction (`start(controller) { enqueue(first); enqueue(second); close(); }`) was tried and verified first**, via a standalone script run under `ELECTRON_RUN_AS_NODE=1 electron`, mirroring this repo's actual test runtime. Result: in this repo's Electron/Node `ReadableStream` + `fetch`/`Response` implementation, two `start()`-enqueued chunks were **not** coalesced — the reader genuinely delivered them as two separate `read()` calls (3 total reads: two data-bearing + one final `done`). So the brief's literal suggestion would have worked as-is here.

Despite that, the implemented test uses a `pull(controller)`-based `ReadableStream` instead (one chunk enqueued per `pull` call, closing on the third pull) because it forces the split by construction rather than by this runtime's current, undocumented, and potentially fragile chunking behavior — `pull` is invoked once per `reader.read()`, so it can never coalesce regardless of `fetch`/`ReadableStream` internals or future Node/Electron upgrades. Verified with the same standalone-script method: exactly 2 data-bearing reads (`'{"message":{"role":"assistant","'` then `'content":"Hello!"},"done":true}\n'`) plus a final `done` read — the split lands mid-object, across the `"` boundary inside the JSON, genuinely exercising the buffer-carryover path.

### Verification

- `npm test -- src/main/ai/providers/ollama.test.ts`: 8/8 passed (was 7; added 1).
- Full `npm test`: 1149/1151 passed, 2 failed — both pre-flagged pre-existing flakes (`Home.test.tsx` midnight-boundary test, `ThemeProvider.test.tsx` DOM-attribute race), unrelated to this change. No other failures.
- `npm run typecheck`: clean.

### Fix commit

See the commit following this report update: "Strengthen Ollama adapter tests: verify tool-result payload and NDJSON chunk-boundary buffering".
