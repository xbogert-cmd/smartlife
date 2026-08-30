# Permission-Mode Redesign Design

## Problem

SmartLife's AI assistant has three permission modes — Ask, Assist, Auto —
surfaced as three buttons in Settings. Per `ROADMAP.md`'s own note, Ask and
Assist have always behaved identically: both pause on `SAFE_WRITE`,
`CONSEQUENTIAL`, and `ALWAYS_CONFIRM` tool tiers, and neither ever gates
`READ`-tier tools. Only Auto is actually distinct (it only pauses on
`ALWAYS_CONFIRM`). The Settings UI also gives the user zero explanation of
what any of the three modes do — three bare, unlabeled buttons.

This closes both gaps: Ask becomes a genuinely more conservative mode than
Assist, and the UI explains the difference.

## Current architecture (context, not being changed)

- `src/main/ai/permissions.ts` defines `ToolTier = 'READ' | 'SAFE_WRITE' |
  'CONSEQUENTIAL' | 'ALWAYS_CONFIRM'`, `AiMode = 'ask' | 'assist' | 'auto'`,
  a `PAUSE_TIERS` map, `resolveExecutionMode(tier, mode)`, and `gate(...)`
  which calls `requestConfirmation` only when `resolveExecutionMode` says to
  pause.
- Every `SAFE_WRITE`/`CONSEQUENTIAL`/`ALWAYS_CONFIRM` tool (calendar writes,
  Canvas submission, browser click/type/select, settings/theme writes,
  clearing history) calls `gate()` itself, inline in its `run()` body. Some
  escalate their tier dynamically at call time — e.g.
  `calendar_create_event` is `SAFE_WRITE` normally but escalates to
  `CONSEQUENTIAL` when the call includes attendees. This per-call escalation
  is why write tools self-gate rather than being gated centrally.
- The 10 `READ`-tier tools (Canvas lookups, calendar listing, browser
  read/screenshot/list-tabs/list-elements, settings read) never call
  `gate()` at all — they always execute immediately regardless of mode.
- Three provider adapters each drive their own tool-calling loop and each
  independently call `tool.run(input, ctx)` when the model invokes a tool:
  `claude.ts`'s `toBetaTools`, `gemini.ts`'s `runOneTool`, `ollama.ts`'s
  `runOneTool`.
- `src/main/ai/confirmations.ts` already guarantees at most one confirmation
  is ever outstanding, because tool calls within a turn run sequentially
  and a turn only awaits one tool call at a time. This holds regardless of
  which tiers get gated, so no queuing/serialization work is needed here.

## Design

### 1. Distinguish Ask from Assist

In `permissions.ts`, add `'READ'` to Ask's pause list only:

```ts
const PAUSE_TIERS: Record<AiMode, ToolTier[]> = {
  ask: ['READ', 'SAFE_WRITE', 'CONSEQUENTIAL', 'ALWAYS_CONFIRM'],
  assist: ['SAFE_WRITE', 'CONSEQUENTIAL', 'ALWAYS_CONFIRM'],
  auto: ['ALWAYS_CONFIRM'],
};
```

`resolveExecutionMode` and `gate()` are untouched — both already operate
generically over `ToolTier`, which already includes `'READ'`.

Resulting semantics:
- **Ask** — every tool call pauses for confirmation, including read-only
  lookups.
- **Assist** — reads run freely; anything that writes or changes state
  pauses for confirmation. (This is today's existing Ask/Assist behavior,
  now attached only to Assist.)
- **Auto** — only `ALWAYS_CONFIRM` (irreversible, outward-facing actions)
  pauses. Unchanged.

### 2. Gate READ-tier tools without touching all 10 of them

Add one shared helper, `runTool`, in a new file
`src/main/ai/tools/runTool.ts`:

```ts
import type { ToolContext, ToolDefinition } from './types';
import { gate } from '../permissions';

/** Single entry point every provider adapter calls instead of
 *  `tool.run()` directly. READ-tier tools never call gate() themselves
 *  (there's 10 of them and none need per-call tier escalation, unlike
 *  writes) -- gating them here, once, is the whole fix. Write-tier tools
 *  keep self-gating inside run() because several escalate their tier at
 *  call time (e.g. calendar_create_event -> CONSEQUENTIAL when attendees
 *  are present) and only the tool itself knows that at call time. */
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

Each `ToolDefinition` already has a human-readable `label` (e.g. "Read
Canvas course grades", "List browser tabs") that becomes the confirmation
prompt's description with no new copy needed.

Update the three call sites to use it:
- `claude.ts`'s `toBetaTools`: `const text = await tool.run(input, ctx);`
  becomes `const text = await runTool(tool, input, ctx);`
- `gemini.ts`'s `runOneTool`: `return tool.run(args, ctx);` becomes
  `return runTool(tool, args, ctx);`
- `ollama.ts`'s `runOneTool`: same change as gemini.ts.

Write-tier tools are not modified — their existing inline `gate()` calls
are untouched.

### 3. Settings UI

`src/renderer/src/routes/Settings.tsx`'s AI permission mode section adds a
one-line description under each button:

- Ask — "Confirms every action, including looking things up."
- Assist — "Confirms anything it writes or changes; looks things up
  freely."
- Auto — "Confirms only irreversible or outward-facing actions."

### Known, accepted consequence

In Ask mode, a single turn that needs to both look something up and act on
it (e.g. "check my Canvas grades and add a study block to my calendar")
will show two separate confirmation prompts back-to-back — one per tool
call. This is the intended meaning of "confirms everything" and is not a
bug. No batching, memory-of-recent-approvals, or single "approve this
turn's plan" mechanism is being added — YAGNI unless this proves annoying
in real use, at which point it's a separate follow-up.

### Testing

- `permissions.test.ts`: extend the existing `resolveExecutionMode`
  coverage with cases proving `ask` now pauses on `READ` and `assist`
  still does not.
- New `runTool.test.ts`: a `READ`-tier tool pauses for confirmation in
  `ask` mode and skips confirmation in `assist`/`auto`; a declined
  confirmation returns the decline string without calling the underlying
  `tool.run`; a non-`READ` tool always calls straight through to
  `tool.run` regardless of mode (proving `runTool` never double-gates a
  write tool that already self-gates).
- `claude.test.ts`, `gemini.test.ts`, `ollama.test.ts`: update/add a case
  per file confirming tool calls now route through `runTool` (e.g. a
  `READ`-tier tool call pauses for confirmation in `ask` mode through the
  full adapter, not just at the `runTool` unit level).
- `Settings.test.tsx`: assert the three new description lines render.

### Out of scope

- Voice mode (explicitly deferred, per standing user instruction).
- Any change to `ALWAYS_CONFIRM` itself or which tools carry it — that
  tier and its tool assignments already shipped in earlier phases.
- Batching or memoizing confirmations within a turn (see "Known, accepted
  consequence" above).
