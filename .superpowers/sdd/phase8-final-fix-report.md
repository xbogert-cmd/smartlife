# Phase 8 (Multi-Provider AI) final-review fix pass

Fixes for the two BLOCKER findings from the whole-branch final review, on top
of HEAD `337f8ee`, on `main`, no worktree.

## Finding 1 (BLOCKER): `ai:set-api-key` never reset the provider cache

**Files:** `src/main/ai/ipc.ts`, `src/main/ai/ipc.test.ts`

The original, pre-Phase-8 Anthropic key handler was the one mutating handler
in `ipc.ts` that never called `resetProviderCache()` after writing — every
handler added later in the phase (Gemini key, Ollama endpoint, ranking, pin)
already did. Added the missing call:

```typescript
ipcMain.handle('ai:set-api-key', (_event, apiKey: string) => {
  setStoredApiKey(db, apiKey);
  resetProviderCache();
});
```

No new import was needed — `resetProviderCache` was already imported from
`./router` for the other six handlers.

**Test:** added `'round-trips the Anthropic key and resets the provider cache
on save'` to `ipc.test.ts`, matching the existing Gemini-key test's shape
exactly (mocks `./router` via `routerMocks`, asserts
`routerMocks.resetProviderCache` was called once after `ai:set-api-key`).

## Finding 2 (BLOCKER): chat UI was gated on an Anthropic-specific check

**Files:** `src/main/ai/router.ts`, `src/main/ai/router.test.ts`,
`src/main/ai/ipc.ts`, `src/main/ai/ipc.test.ts`, `src/preload/index.ts`,
`src/renderer/src/ai/useConversation.ts`, `src/renderer/src/ai/useConversation.test.ts`

Four-part fix, as specified:

1. `router.ts` gained `hasUsableProvider(db)`, reusing the existing
   `buildProvider` helper (no duplicated credential logic):
   ```typescript
   export function hasUsableProvider(db: Database.Database): boolean {
     return getRanking(db).some(({ providerId, model }) => buildProvider(db, providerId, model) !== null);
   }
   ```
2. `ipc.ts` imports `hasUsableProvider` alongside `resetProviderCache,
   retryProviderEntry` and adds `ipcMain.handle('ai:has-usable-provider', ()
   => hasUsableProvider(db))`.
3. `preload/index.ts`'s `ai` object gained `hasUsableProvider: (): Promise<boolean> =>
   ipcRenderer.invoke('ai:has-usable-provider')`.
4. `useConversation.ts`'s mount effect now calls
   `window.smartlife.ai.hasUsableProvider()` instead of `getApiKeyStatus()`,
   with the same `.then(setApiKeyConfigured).catch(() =>
   setApiKeyConfigured(false))` shape as before. The `apiKeyConfigured` state
   name was deliberately kept (per the brief) with a comment added at its
   declaration explaining it now reflects "is any provider usable," not
   specifically an Anthropic key.

`AIProvidersSection.tsx`'s own `getApiKeyStatus()` call for its Claude-key
card's "connected" label was left untouched — confirmed by reading the file,
it's still correctly checking the Anthropic key specifically for that one
card.

### Tests proving a Gemini/Ollama-only user reaches a working chat input

- `router.test.ts`: new `describe('hasUsableProvider', ...)` block — returns
  `false` with nothing ranked; returns `false` when Anthropic is ranked with
  no key stored; returns `true` when Gemini is ranked with a key stored
  **and no Anthropic key exists at all** (the actual bug scenario); returns
  `true` for a ranked Ollama entry (needs no key).
- `ipc.test.ts`: new test asserting the `ai:has-usable-provider` handler
  delegates to `routerMocks.hasUsableProvider` and returns its result.
- `useConversation.test.ts`: the file's `ai` mock's `getApiKeyStatus` was
  replaced with `hasUsableProvider` (matching what the hook now actually
  calls), and a new `describe('useConversation — apiKeyConfigured reflects
  any usable provider', ...)` block asserts `result.current.apiKeyConfigured`
  becomes `true` when `ai.hasUsableProvider` resolves `true` — explicitly
  documented as resolving purely from a Gemini/Ollama-only configuration,
  with no Anthropic-specific call involved — and becomes `false` when it
  resolves `false`.

Together with the untouched `ChatPanel.tsx` gate (`if (apiKeyConfigured !==
true) return <empty-state>`), this proves the full path end to end: a user
with only a Gemini or Ollama entry ranked gets `hasUsableProvider() === true`
from the main process → `useConversation` sets `apiKeyConfigured = true` →
`ChatPanel` renders the real input instead of "Connect Claude in Settings" —
with no Anthropic key anywhere in the picture.

### Incidental fixes required by the behavior change

Three renderer test files mount `useConversation` (directly or via
`AIDock`/`AI`) and stub `window.smartlife.ai` with a fixed set of methods;
since the hook now calls `hasUsableProvider` instead of `getApiKeyStatus`,
their stubs needed the new method added or the effect would throw on a
missing function:

- `src/renderer/src/ai/AIDock.test.tsx` — swapped its `getApiKeyStatus` mock
  entry for `hasUsableProvider` (same resolved value, `true`).
- `src/renderer/src/routes/AI.test.tsx` — its `mockAi(apiKeyConfigured)`
  helper now sets `hasUsableProvider` from that same parameter instead of
  `getApiKeyStatus`, since that's what actually gates the UI now.
- `src/renderer/src/App.test.tsx` — added `hasUsableProvider: vi.fn().mockResolvedValue(false)`
  alongside the existing (now-unused-by-the-hook, but still typed) `getApiKeyStatus`.
- `src/renderer/src/theme/ThemeProvider.test.tsx` — added the same
  `hasUsableProvider` entry; required only for `npm run typecheck`, since its
  `ai` mock is statically typed against `typeof window.smartlife` and
  `hasUsableProvider` is now a required property of that type, even though
  this file never mounts `useConversation` at runtime.

`Settings.test.tsx` and `AIProvidersSection.test.tsx` were left untouched —
neither renders `AIDock`/`AI` or otherwise mounts `useConversation`, and
their `ai` mocks are cast with `as unknown as typeof window.smartlife`, so
they don't hit the stricter structural type check either.

## Test / typecheck results

- Targeted run — `npm test -- src/main/ai/router.test.ts src/main/ai/ipc.test.ts src/renderer/src/ai/ChatPanel.test.tsx src/renderer/src/ai/useConversation.test.ts`: **4 files, 31 tests, all passed.**
- Full `npm test` (via `ELECTRON_RUN_AS_NODE=1 electron ./node_modules/vitest/vitest.mjs run`, never `npx vitest run`): **111 test files, 1191 tests — 1190 passed, 1 failed.** The single failure is `src/renderer/src/theme/ThemeProvider.test.tsx > applies the persisted preference to <html data-theme>`, one of the three pre-documented flakes (the DOM-attribute race test) — reran the full suite a second time after the last edit and it failed again on the same test with a different assertion value (`'light'` vs `'dark'` instead of `null` vs `'dark'`), consistent with a timing race rather than anything this change touched. No other failures on either run.
- `npm run typecheck` (`tsc --noEmit` against both `tsconfig.node.json` and `tsconfig.web.json`): **clean, no errors.**

## Notes / concerns

- Both findings were real, reproducible as described, and are now fixed
  exactly as specified. Neither turned out to be wrong or unnecessary on
  closer inspection.
- Finding 2's fix required touching four renderer test files beyond the ones
  named in the brief (`AIDock.test.tsx`, `AI.test.tsx`, `App.test.tsx`,
  `ThemeProvider.test.tsx`) purely to keep their `window.smartlife.ai` stubs
  in sync with the renamed IPC call `useConversation` now makes — this is
  flagged here rather than silently folded in, though it's a mechanical
  consequence of the behavior change, not a design decision.
- No pacing/delay/timing logic was touched or added anywhere in this pass.
