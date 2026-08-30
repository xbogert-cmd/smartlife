# Permission-Mode Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ask mode genuinely more conservative than Assist mode (Ask now confirms every tool call, including reads; Assist keeps confirming only writes), and explain the three permission modes in the Settings UI.

**Architecture:** `permissions.ts`'s `PAUSE_TIERS` map gains `'READ'` in Ask's list only. A new shared `runTool()` helper gates `READ`-tier tools (which currently never call `gate()` at all) in one place, and the three provider adapters (Claude, Gemini, Ollama) route their tool-invocation call site through it instead of calling `tool.run()` directly. Write-tier tools are untouched — they keep self-gating inline, since several escalate their tier at call time. Settings gets one line of copy under each mode button.

**Tech Stack:** Electron + React + TypeScript, Vitest (run only via `npm test`, which sets `ELECTRON_RUN_AS_NODE=1` — `npx vitest run` uses system Node and breaks better-sqlite3's native ABI, producing ~200 bogus failures).

## Global Constraints

- Tests run via `npm test -- <path>` (single file) or `npm test` (full suite). Never `npx vitest run`.
- Design spec: `docs/superpowers/specs/2026-08-30-smartlife-permission-mode-redesign-design.md` — the source of truth for every value below.
- `ask` pauses on `['READ', 'SAFE_WRITE', 'CONSEQUENTIAL', 'ALWAYS_CONFIRM']`. `assist` and `auto` are unchanged.
- READ-tier gating happens only inside the new `runTool()` helper, using `tool.label` as the confirmation description. Decline returns the literal string `'The user declined, so this was not checked.'`.
- Write-tier tools (`SAFE_WRITE`/`CONSEQUENTIAL`/`ALWAYS_CONFIRM`) are not modified — they keep their existing inline `gate()` calls.
- Settings UI copy, verbatim:
  - Ask — "Confirms every action, including looking things up."
  - Assist — "Confirms anything it writes or changes; looks things up freely."
  - Auto — "Confirms only irreversible or outward-facing actions."
- No batching/memoization of confirmations within a turn — explicitly out of scope per the spec.
- Voice mode is out of scope (standing project instruction, unrelated to this work).

---

### Task 1: Distinguish Ask from Assist in `permissions.ts`

**Files:**
- Modify: `src/main/ai/permissions.ts:10-14`
- Test: `src/main/ai/permissions.test.ts`

**Interfaces:**
- Consumes: nothing new — `ToolTier`, `AiMode`, `resolveExecutionMode`, and `gate` already exist in this file and are unchanged in shape.
- Produces: `resolveExecutionMode('READ', 'ask')` now returns `'pause'` (was `'auto'`). `resolveExecutionMode('READ', 'assist')` and `resolveExecutionMode('READ', 'auto')` remain `'auto'`. This is the only behavior change later tasks depend on.

- [ ] **Step 1: Write the failing tests**

Add these two cases into the existing `cases` array in `src/main/ai/permissions.test.ts` (the array currently starts at line 6) — change the three `'READ'` rows from:

```ts
    ['READ', 'ask', 'auto'],
    ['READ', 'assist', 'auto'],
    ['READ', 'auto', 'auto'],
```

to:

```ts
    ['READ', 'ask', 'pause'],
    ['READ', 'assist', 'auto'],
    ['READ', 'auto', 'auto'],
```

This flips the existing `'READ', 'ask'` case from `'auto'` to `'pause'` — that's the actual regression test. `assist` and `auto` stay `'auto'`, proving they're untouched.

The file has one more pre-existing test that directly contradicts the new behavior and will start failing for the wrong reason otherwise: `describe('gate', ...)`'s first test (currently lines 24-29) calls `gate('READ', 'ask', ...)` and asserts it auto-executes. That premise is exactly what Task 1 changes. Update it to exercise `'auto'` mode instead, which still auto-executes on `READ` and is unaffected by this task — change:

```ts
  it('resolves true immediately without confirming when the tier auto-executes', async () => {
    const requestConfirmation = vi.fn();
    const approved = await gate('READ', 'ask', 'get_settings', 'Read settings', requestConfirmation);
    expect(approved).toBe(true);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });
```

to:

```ts
  it('resolves true immediately without confirming when the tier auto-executes', async () => {
    const requestConfirmation = vi.fn();
    const approved = await gate('READ', 'auto', 'get_settings', 'Read settings', requestConfirmation);
    expect(approved).toBe(true);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });
```

Also add a new `describe` block at the end of the file, after the existing `describe('gate with a custom timeout', ...)` block:

```ts
describe('Ask mode gates reads', () => {
  it('calls requestConfirmation for a READ-tier tool in ask mode', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(true);
    const approved = await gate('READ', 'ask', 'get_settings', 'Reading settings', requestConfirmation);
    expect(approved).toBe(true);
    expect(requestConfirmation).toHaveBeenCalledWith('get_settings', 'Reading settings', undefined);
  });

  it('does not call requestConfirmation for a READ-tier tool in assist mode', async () => {
    const requestConfirmation = vi.fn();
    const approved = await gate('READ', 'assist', 'get_settings', 'Reading settings', requestConfirmation);
    expect(approved).toBe(true);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/main/ai/permissions.test.ts`
Expected: FAIL — the `it.each` case `tier=READ mode=ask -> pause` fails because `resolveExecutionMode('READ', 'ask')` currently returns `'auto'`, and the new `'calls requestConfirmation for a READ-tier tool in ask mode'` test fails for the same reason.

- [ ] **Step 3: Implement the fix**

In `src/main/ai/permissions.ts`, change the `PAUSE_TIERS` map (currently lines 10-14) from:

```ts
const PAUSE_TIERS: Record<AiMode, ToolTier[]> = {
  ask: ['SAFE_WRITE', 'CONSEQUENTIAL', 'ALWAYS_CONFIRM'],
  assist: ['SAFE_WRITE', 'CONSEQUENTIAL', 'ALWAYS_CONFIRM'],
  auto: ['ALWAYS_CONFIRM'],
};
```

to:

```ts
const PAUSE_TIERS: Record<AiMode, ToolTier[]> = {
  ask: ['READ', 'SAFE_WRITE', 'CONSEQUENTIAL', 'ALWAYS_CONFIRM'],
  assist: ['SAFE_WRITE', 'CONSEQUENTIAL', 'ALWAYS_CONFIRM'],
  auto: ['ALWAYS_CONFIRM'],
};
```

Also update the file's top comment (lines 1-6) — it currently only explains `ALWAYS_CONFIRM`. Replace it with:

```ts
/**
 * ALWAYS_CONFIRM is for actions that are irreversible AND outward-facing --
 * the consequence leaves this machine and reaches another person or
 * institution. It is the one tier `auto` does not skip, and nothing may
 * escalate past it.
 *
 * `ask` is the most conservative mode: it pauses on every tier, including
 * READ, so even a lookup needs a nod first. `assist` drops READ from its
 * pause list -- it can look things up freely, but still confirms anything
 * that writes or changes state. `auto` only pauses on ALWAYS_CONFIRM.
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/main/ai/permissions.test.ts`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/permissions.ts src/main/ai/permissions.test.ts
git commit -m "Make Ask mode pause on READ-tier tools, distinguishing it from Assist

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Add the shared `runTool()` gating helper

**Files:**
- Create: `src/main/ai/tools/runTool.ts`
- Test: `src/main/ai/tools/runTool.test.ts`

**Interfaces:**
- Consumes: `ToolContext`, `ToolDefinition` from `./types` (both already exist, unchanged); `gate` from `../permissions` (unchanged, from Task 1).
- Produces: `export async function runTool(tool: ToolDefinition, input: Record<string, unknown>, ctx: ToolContext): Promise<string>` — Task 3's three provider files import and call this instead of calling `tool.run(...)` directly.

- [ ] **Step 1: Write the failing test**

Create `src/main/ai/tools/runTool.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { runTool } from './runTool';
import type { ToolContext, ToolDefinition } from './types';

function fakeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    db: {} as never,
    conversationId: 'c1',
    mode: 'ask',
    requestConfirmation: vi.fn(),
    ...overrides,
  };
}

const readTool: ToolDefinition = {
  name: 'get_settings',
  tier: 'READ',
  label: 'Reading settings',
  schema: { name: 'get_settings', description: '', input_schema: { type: 'object', properties: {} } },
  run: vi.fn().mockResolvedValue('the settings'),
};

const writeTool: ToolDefinition = {
  name: 'set_theme',
  tier: 'SAFE_WRITE',
  label: 'Set theme',
  schema: { name: 'set_theme', description: '', input_schema: { type: 'object', properties: {} } },
  run: vi.fn().mockResolvedValue('theme set'),
};

describe('runTool', () => {
  it('gates a READ-tier tool through requestConfirmation using its label, in ask mode', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(true);
    const ctx = fakeCtx({ mode: 'ask', requestConfirmation });

    const result = await runTool(readTool, {}, ctx);

    expect(requestConfirmation).toHaveBeenCalledWith('get_settings', 'Reading settings', undefined);
    expect(result).toBe('the settings');
  });

  it('returns the decline string and never calls tool.run when the user declines a READ-tier confirmation', async () => {
    const run = vi.fn().mockResolvedValue('the settings');
    const declinedReadTool: ToolDefinition = { ...readTool, run };
    const requestConfirmation = vi.fn().mockResolvedValue(false);
    const ctx = fakeCtx({ mode: 'ask', requestConfirmation });

    const result = await runTool(declinedReadTool, {}, ctx);

    expect(result).toBe('The user declined, so this was not checked.');
    expect(run).not.toHaveBeenCalled();
  });

  it('does not gate a READ-tier tool in assist mode', async () => {
    const requestConfirmation = vi.fn();
    const ctx = fakeCtx({ mode: 'assist', requestConfirmation });

    const result = await runTool(readTool, {}, ctx);

    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(result).toBe('the settings');
  });

  it('does not gate a READ-tier tool in auto mode', async () => {
    const requestConfirmation = vi.fn();
    const ctx = fakeCtx({ mode: 'auto', requestConfirmation });

    const result = await runTool(readTool, {}, ctx);

    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(result).toBe('the settings');
  });

  it('always calls tool.run for a non-READ tier tool, in every mode, without ever calling requestConfirmation itself', async () => {
    const requestConfirmation = vi.fn();
    const ctx = fakeCtx({ mode: 'ask', requestConfirmation });

    const result = await runTool(writeTool, {}, ctx);

    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(result).toBe('theme set');
  });

  it('passes input through to tool.run unchanged', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    const tool: ToolDefinition = { ...writeTool, run };
    const ctx = fakeCtx({ mode: 'auto' });
    const input = { theme: 'dark' };

    await runTool(tool, input, ctx);

    expect(run).toHaveBeenCalledWith(input, ctx);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/main/ai/tools/runTool.test.ts`
Expected: FAIL with "Cannot find module './runTool'" (or equivalent — the file doesn't exist yet).

- [ ] **Step 3: Implement `runTool`**

Create `src/main/ai/tools/runTool.ts`:

```ts
import type { ToolContext, ToolDefinition } from './types';
import { gate } from '../permissions';

/** Single entry point every provider adapter calls instead of `tool.run()`
 *  directly. READ-tier tools never call gate() themselves -- there are 10
 *  of them and none need per-call tier escalation, unlike writes -- so
 *  gating them here, once, is the whole fix for Ask mode pausing on reads.
 *  Write-tier tools keep self-gating inside run() because several escalate
 *  their tier at call time (e.g. calendar_create_event -> CONSEQUENTIAL
 *  when attendees are present) and only the tool itself knows that at call
 *  time -- runTool falls through to tool.run() unconditionally for them. */
export async function runTool(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  if (tool.tier === 'READ') {
    const approved = await gate('READ', ctx.mode, tool.name, tool.label, ctx.requestConfirmation);
    if (!approved) return 'The user declined, so this was not checked.';
  }
  return tool.run(input, ctx);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/main/ai/tools/runTool.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/tools/runTool.ts src/main/ai/tools/runTool.test.ts
git commit -m "Add shared runTool() helper to gate READ-tier tools

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Route all three provider adapters through `runTool()`

**Files:**
- Modify: `src/main/ai/providers/claude.ts:15-16`
- Modify: `src/main/ai/providers/gemini.ts:50-59`
- Modify: `src/main/ai/providers/ollama.ts:117-126`
- Test: `src/main/ai/providers/claude.test.ts`
- Test: `src/main/ai/providers/gemini.test.ts`
- Test: `src/main/ai/providers/ollama.test.ts`

**Interfaces:**
- Consumes: `runTool(tool, input, ctx)` from `../tools/runTool` (Task 2).
- Produces: nothing new for later tasks — this is the last piece of the gating change. After this task, every real tool call in the app (Claude, Gemini, and Ollama alike) goes through `runTool`.

**Why the existing tests need a fixture change:** all three provider test files define their own `fakeCtx()` helper (`{ db: {} as never, conversationId: 'c1', mode: 'ask' as const, requestConfirmation: vi.fn() }`) and use it for every `ToolDefinition` with `tier: 'READ'` in the file (the weather-tool tests, the screenshot round-trip tests, etc.). Once `runTool` is wired in, `mode: 'ask'` combined with an unmocked `requestConfirmation: vi.fn()` (which returns `undefined`, not a resolved `Promise<true>`) would make every one of those existing tests silently decline the tool call instead of running it — a real regression these tests must not paper over. The fix is a one-line change to each file's `fakeCtx()`: switch its `mode` from `'ask'` to `'assist'`, since these tests are exercising tool-calling and result-formatting, not permission gating, and `assist` is the mode where reads run without confirmation by design. This task changes the fixture once per file and adds one new test per file that deliberately sets `mode: 'ask'` to prove the gating actually reaches through the real adapter.

- [ ] **Step 1: Write the failing tests**

In `src/main/ai/providers/claude.test.ts`, change the `fakeCtx` function (currently at line 12, a one-line arrow function) from:

```ts
  return { db: {} as never, conversationId: 'c1', mode: 'ask' as const, requestConfirmation: vi.fn() };
```

to:

```ts
  return { db: {} as never, conversationId: 'c1', mode: 'assist' as const, requestConfirmation: vi.fn() };
```

Then add this new test at the end of the file (after the last `describe` block), reusing the file's existing `fakeMessageStream` helper (declared inside the `'createClaudeProvider — usage tracking'` block, lines 54-62) by moving it — see the note after this code block:

```ts
describe('Ask mode gates READ-tier tools through runTool', () => {
  it('pauses for confirmation before running a READ-tier tool when ctx.mode is ask', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(false);
    const run = vi.fn().mockResolvedValue('should not be reached');
    const tool: import('../tools/types').ToolDefinition = {
      name: 'get_settings',
      tier: 'READ',
      label: 'Reading settings',
      schema: { name: 'get_settings', description: '', input_schema: { type: 'object', properties: {} } },
      run,
    };
    const toolRunner = vi.fn().mockReturnValue(
      (async function* () {
        yield fakeMessageStream({
          content: [{ type: 'text', text: 'declined' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      })()
    );
    vi.mocked(Anthropic).mockReturnValue({ beta: { messages: { toolRunner } } } as never);

    const provider = createClaudeProvider('sk-ant-test', 'claude-sonnet-5');
    const ctx = { db: {} as never, conversationId: 'c1', mode: 'ask' as const, requestConfirmation };
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [tool], ctx, onEvent: vi.fn() });

    // toolRunner is constructed with the tool's `run` wrapped by runTool --
    // invoke it the way the SDK would, to prove gating actually happens.
    const toolsPassed = toolRunner.mock.calls[0][0].tools;
    const wrappedRun = toolsPassed[0].run as (input: Record<string, unknown>) => Promise<unknown>;
    const result = await wrappedRun({});

    expect(requestConfirmation).toHaveBeenCalledWith('get_settings', 'Reading settings', undefined);
    expect(run).not.toHaveBeenCalled();
    expect(result).toBe('The user declined, so this was not checked.');
  });
});
```

`fakeMessageStream` is currently a local function declared inside the `describe('createClaudeProvider — usage tracking', ...)` block (lines 54-62), so it is not in scope for the new `describe` block above. Move its declaration out to file scope instead — cut it from inside that `describe` block and paste it just below the existing `emptyRunner` function (line 21), unindented:

```ts
function fakeMessageStream(finalMessage: {
  content: Array<{ type: 'text'; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
}) {
  return {
    [Symbol.asyncIterator]: () => (async function* () {})(),
    finalMessage: async () => finalMessage,
  };
}
```

Leave every existing call site (`fakeMessageStream(...)` inside the `'reports usage summed...'` test) unchanged — moving the declaration to file scope doesn't change how it's called.

In `src/main/ai/providers/gemini.test.ts`, change `fakeCtx` (currently line 29) the same way — `mode: 'ask' as const` becomes `mode: 'assist' as const`. Then add, at the end of the file:

```ts
describe('Ask mode gates READ-tier tools through runTool', () => {
  it('pauses for confirmation before running a READ-tier tool when ctx.mode is ask', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(false);
    const run = vi.fn().mockResolvedValue('should not be reached');
    const tool: ToolDefinition = {
      name: 'get_settings',
      tier: 'READ',
      label: 'Reading settings',
      schema: { name: 'get_settings', description: '', input_schema: { type: 'object', properties: {} } },
      run,
    };
    const sendMessageStream = vi
      .fn()
      .mockResolvedValueOnce(fakeStream([{ functionCalls: [{ name: 'get_settings', args: {} }] }]))
      .mockResolvedValueOnce(fakeStream([{ text: 'declined' }]));
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    vi.mocked(GoogleGenAI).mockReturnValue({ chats: { create } } as never);

    const provider = createGeminiProvider('test-key', 'gemini-2.5-flash');
    const ctx = { db: {} as never, conversationId: 'c1', mode: 'ask' as const, requestConfirmation };
    await provider.streamTurn({ system: 's', history: [], userText: 'settings?', tools: [tool], ctx, onEvent: vi.fn() });

    expect(requestConfirmation).toHaveBeenCalledWith('get_settings', 'Reading settings', undefined);
    expect(run).not.toHaveBeenCalled();
  });
});
```

This reuses `fakeStream` (file-scope helper, lines 11-26) and the same `GoogleGenAI` mocking idiom already used by the `'runs a called tool and sends its result back before producing the final answer'` test (lines 117-122) — no new helpers needed.

In `src/main/ai/providers/ollama.test.ts`, change `fakeCtx` (currently line 16) the same way — `mode: 'ask' as const` becomes `mode: 'assist' as const`. Then add, at the end of the file:

```ts
describe('Ask mode gates READ-tier tools through runTool', () => {
  it('pauses for confirmation before running a READ-tier tool when ctx.mode is ask', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(false);
    const run = vi.fn().mockResolvedValue('should not be reached');
    const tool: ToolDefinition = {
      name: 'get_settings',
      tier: 'READ',
      label: 'Reading settings',
      schema: { name: 'get_settings', description: '', input_schema: { type: 'object', properties: {} } },
      run,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        ndjsonResponse([
          {
            message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_settings', arguments: {} } }] },
            done: true,
          },
        ])
      )
      .mockResolvedValueOnce(ndjsonResponse([{ message: { role: 'assistant', content: 'declined' }, done: true }]));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOllamaProvider('http://localhost:11434', 'llama3.1');
    const ctx = { db: {} as never, conversationId: 'c1', mode: 'ask' as const, requestConfirmation };
    await provider.streamTurn({ system: 's', history: [], userText: 'settings?', tools: [tool], ctx, onEvent: vi.fn() });

    expect(requestConfirmation).toHaveBeenCalledWith('get_settings', 'Reading settings', undefined);
    expect(run).not.toHaveBeenCalled();
  });
});
```

This reuses `ndjsonResponse` (file-scope helper, lines 10-13), already used by the `'runs a called tool and sends its result back before producing the final answer'` test (lines 91-101) — no new helpers needed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/main/ai/providers/claude.test.ts src/main/ai/providers/gemini.test.ts src/main/ai/providers/ollama.test.ts`
Expected: FAIL — each new "Ask mode gates READ-tier tools through runTool" test fails because `tool.run` is currently called directly with no gating, so `requestConfirmation` is never called and `run` gets invoked instead of being skipped.

- [ ] **Step 3: Wire `runTool` into each provider**

In `src/main/ai/providers/claude.ts`, add the import at the top (after the existing imports, currently ending at line 5):

```ts
import { runTool } from '../tools/runTool';
```

Then change the `run` function inside `toBetaTools` (currently lines 15-16) from:

```ts
        run: async (input: Record<string, unknown>) => {
          const text = await tool.run(input, ctx);
```

to:

```ts
        run: async (input: Record<string, unknown>) => {
          const text = await runTool(tool, input, ctx);
```

In `src/main/ai/providers/gemini.ts`, add the import at the top (after the existing imports, currently ending at line 12):

```ts
import { runTool } from '../tools/runTool';
```

Then change `runOneTool` (currently lines 50-59) from:

```ts
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
```

to:

```ts
async function runOneTool(
  tools: ToolDefinition[],
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const tool = tools.find((t) => t.schema.name === name);
  if (!tool) return `Unknown tool: ${name}`;
  return runTool(tool, args, ctx);
}
```

In `src/main/ai/providers/ollama.ts`, add the import at the top (after the existing imports, currently ending at line 3):

```ts
import { runTool } from '../tools/runTool';
```

Then change `runOneTool` (currently lines 117-126) from:

```ts
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
```

to:

```ts
async function runOneTool(
  tools: ToolDefinition[],
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const tool = tools.find((t) => t.schema.name === name);
  if (!tool) return `Unknown tool: ${name}`;
  return runTool(tool, args, ctx);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/main/ai/providers/claude.test.ts src/main/ai/providers/gemini.test.ts src/main/ai/providers/ollama.test.ts`
Expected: PASS — every test in all three files green, including the pre-existing tool-calling and screenshot round-trip tests (now running under `mode: 'assist'` via the updated `fakeCtx()`, which does not gate READ tools) and the three new gating tests.

- [ ] **Step 5: Run the full suite to check for any other fallout**

Run: `npm test`
Expected: PASS. If anything outside these three files fails, it means some other test also builds a `ToolContext` with `mode: 'ask'` and a `tier: 'READ'` tool through one of these providers — find it with `grep -rn "mode: 'ask'" src/main/ai` and apply the same fix (switch to `'assist'` unless the test is specifically about gating).

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/providers/claude.ts src/main/ai/providers/claude.test.ts \
        src/main/ai/providers/gemini.ts src/main/ai/providers/gemini.test.ts \
        src/main/ai/providers/ollama.ts src/main/ai/providers/ollama.test.ts
git commit -m "Route Claude, Gemini, and Ollama tool calls through runTool()

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Explain the three modes in Settings

**Files:**
- Modify: `src/renderer/src/routes/Settings.tsx:160-179`
- Test: `src/renderer/src/routes/Settings.test.tsx`

**Interfaces:**
- Consumes: nothing new — this task only touches rendered JSX and its existing `aiMode`/`handleSetAiMode` state, both unchanged.
- Produces: nothing later tasks depend on — this is the last task in the plan.

- [ ] **Step 1: Write the failing test**

Add this `describe` block to `src/renderer/src/routes/Settings.test.tsx`, after the existing `describe('Settings — AI Providers', ...)` block:

```tsx
describe('Settings — AI permission mode', () => {
  it('shows a one-line description for each mode', async () => {
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    );
    await screen.findByRole('heading', { name: 'Settings' });

    expect(screen.getByText('Confirms every action, including looking things up.')).toBeInTheDocument();
    expect(
      screen.getByText('Confirms anything it writes or changes; looks things up freely.')
    ).toBeInTheDocument();
    expect(screen.getByText('Confirms only irreversible or outward-facing actions.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/renderer/src/routes/Settings.test.tsx`
Expected: FAIL — none of the three description strings exist in the rendered output yet.

- [ ] **Step 3: Add the descriptions**

In `src/renderer/src/routes/Settings.tsx`, change the AI permission mode section (currently lines 160-179) from:

```tsx
      <div className="flex flex-col gap-2">
        <span style={{ color: 'var(--color-text-muted)' }}>AI permission mode</span>
        <div className="flex gap-2">
          {(['ask', 'assist', 'auto'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => handleSetAiMode(mode)}
              className="rounded-md px-3 py-1.5 text-sm capitalize"
              style={{
                backgroundColor: aiMode === mode ? 'var(--color-text)' : 'var(--color-surface)',
                color: aiMode === mode ? 'var(--color-bg)' : 'var(--color-text)',
                border: '1px solid var(--color-border)',
              }}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>
```

to:

```tsx
      <div className="flex flex-col gap-2">
        <span style={{ color: 'var(--color-text-muted)' }}>AI permission mode</span>
        <div className="flex flex-col gap-2">
          {(
            [
              ['ask', 'Confirms every action, including looking things up.'],
              ['assist', 'Confirms anything it writes or changes; looks things up freely.'],
              ['auto', 'Confirms only irreversible or outward-facing actions.'],
            ] as const
          ).map(([mode, description]) => (
            <div key={mode} className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => handleSetAiMode(mode)}
                className="w-fit rounded-md px-3 py-1.5 text-sm capitalize"
                style={{
                  backgroundColor: aiMode === mode ? 'var(--color-text)' : 'var(--color-surface)',
                  color: aiMode === mode ? 'var(--color-bg)' : 'var(--color-text)',
                  border: '1px solid var(--color-border)',
                }}
              >
                {mode}
              </button>
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {description}
              </span>
            </div>
          ))}
        </div>
      </div>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/renderer/src/routes/Settings.test.tsx`
Expected: PASS, all tests in the file green (including the pre-existing `'Settings — AI Providers'`, `'Settings — Canvas'`, `'Settings — Google Calendar'`, and `'Browser settings'` blocks, unaffected by this change).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/routes/Settings.tsx src/renderer/src/routes/Settings.test.tsx
git commit -m "Explain what each AI permission mode does in Settings

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Final Verification

After all four tasks are complete:

```bash
npm test
npm run typecheck
npm run lint
```

Expected: full suite green, clean typecheck, zero lint errors.
