# SmartLife Phase 2: AI Core — Design

**Goal:** A real, working Claude-backed chat assistant inside SmartLife — streaming responses, a tool-calling pipeline with a genuine three-tier permission system, and persistent conversation history — reachable both from a dedicated AI section and a global overlay, plus a separate command palette for navigation.

See `../../../ROADMAP.md` for how this phase fits the full 9-phase plan and `2026-08-17-smartlife-phase1-foundation-design.md` for the Phase 1 conventions this phase extends (IPC-mediated main/renderer split, migration-based SQLite schema, dark-first theming, single-`BrowserWindow` lifecycle).

## Architecture

Electron's process boundary is also the trust boundary: the Anthropic API key and every network call live in the main process only. The renderer never gets direct SDK access — it sends a message over IPC and receives streamed events back, the same shape as Phase 1's `window.smartlife.theme` bridge, just with a stream instead of a single response.

```
renderer (AI section / overlay)
    | window.smartlife.ai.sendMessage(text)
    v
main: chatController
    | loads conversation history from SQLite
    v
main: AIRouter.getProvider() -> ClaudeProvider
    | client.beta.messages.toolRunner({ model, tools, messages, stream: true })
    v
Anthropic API (streaming)
    | text deltas, tool_use blocks
    v
main: relays each event to renderer via webContents.send('ai:stream-event', ...)
    | tool run() functions execute here — READ/SAFE_WRITE auto (per mode),
    | CONSEQUENTIAL pauses and round-trips through the renderer for confirmation
    v
main: persists final user + assistant messages to SQLite once the turn completes
```

**Provider abstraction, kept honest about what it's for.** `AIProvider` is an interface (`streamTurn(messages, tools, onEvent): Promise<FinalMessage>`) with exactly one implementation, `ClaudeProvider`. `AIRouter.getProvider()` always returns it — there is no routing logic to speak of yet, because there's only ever one provider until Phase 8. The interface exists now because the IPC/main-process boundary already forces a clean seam (same reasoning as the Phase 1 connector-framework precedent in the sibling project): defining it costs nothing today and means Phase 8 adds providers instead of restructuring.

**Tool-calling: the SDK's Tool Runner, not a hand-rolled loop.** `client.beta.messages.toolRunner(...)` (beta, `@anthropic-ai/sdk`) drives the request → execute → loop cycle automatically — no hand-written `while (stop_reason === 'tool_use')`, no manual message-array bookkeeping. Tools are declared via the runner's raw-JSON-Schema form (`betaTool()` from `@anthropic-ai/sdk/helpers/beta/json-schema`), not the Zod form — same schema shape as writing it by hand, no new dependency. Combines with streaming via the documented pattern: an outer loop over tool-runner iterations, an inner loop over each iteration's stream events.

**Model:** `claude-sonnet-5` (matches this session; Anthropic's current Sonnet-tier model, no code reason to use a different tier here).

## API key storage

Not a `.env` file. A packaged `.app` has no reliable place to keep a loose `.env` alongside it, and the original master-prompt requirement was explicit about this anyway: use the OS Keychain, not a plaintext file. Settings gets a new field — an Anthropic API key input (masked, like a password field). On save:

1. Main process encrypts the value with Electron's built-in `safeStorage.encryptString(key)` (backed by the macOS Keychain — no new dependency).
2. The encrypted buffer is stored in the existing `settings` table (key `anthropic_api_key_encrypted`), base64-encoded for TEXT storage.
3. On first use each session, main process decrypts via `safeStorage.decryptString(...)` and holds the plaintext key in memory only (never written back to disk, never sent to the renderer).

If no key is stored, the AI section and overlay show a "Connect Claude in Settings" empty state instead of a broken chat — same graceful-degradation pattern as Phase 1's `/connectors` precedent in the sibling project. `safeStorage.isEncryptionAvailable()` is checked before encrypting; on macOS this is effectively always true, but the check stays as a real guard, not a formality.

## Data model

New migration, `0002_ai_core.sql` (Phase 1's runner already supports multiple migrations — this is the first real second one):

```sql
create table ai_conversations (
  id text primary key,
  title text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

create table ai_messages (
  id text primary key,
  conversation_id text not null references ai_conversations(id) on delete cascade,
  role text not null,
  content text not null,
  created_at text not null default (datetime('now'))
);

create index ai_messages_conversation_idx on ai_messages(conversation_id, created_at);
```

`role` is `'user' | 'assistant'`. `content` is a JSON-serialized array of content blocks (text, tool_use, tool_result) — stored as the raw shape the Anthropic SDK already uses, not a bespoke format, so replaying history back into a new request is a direct deserialize, no translation layer.

**One conversation, not many.** Phase 2 auto-creates a single `ai_conversations` row on first use and always appends to it — no conversation list, no switcher, no "new conversation" button. Multi-conversation management is a real feature, but nothing in this phase needs it; building the switcher now would be guessing at a UX nobody has asked for. The schema already supports multiple conversations per row shape, so adding the switcher later is additive, not a migration.

`settings` gains one more key-value row: `ai_mode` (`'ask' | 'assist' | 'auto'`, defaults to `'ask'` if absent — the most conservative default, matching the master prompt's own emphasis on confirm-first for anything real).

## Permission system

Every tool declares a tier:

| Tier | Meaning | Example (Phase 2) |
|---|---|---|
| READ | No state change | `get_settings` |
| SAFE_WRITE | Reversible, low-stakes state change | `set_theme` |
| CONSEQUENTIAL | Destructive or hard-to-reverse | `clear_conversation_history` |

The global `ai_mode` setting gates execution:

| Mode | READ | SAFE_WRITE | CONSEQUENTIAL |
|---|---|---|---|
| ASK | auto | **pause** | **pause** |
| ASSIST | auto | auto | **pause** |
| AUTO | auto | auto | auto |

"Pause" means: the tool's own `run()` function generates a confirmation id, sends `ai:confirm-request` (`{ id, toolName, description }`) to the renderer via `webContents.send`, and `await`s a promise that only resolves when the renderer calls back through `window.smartlife.ai.respondToConfirm(id, approved)`. On approval the tool executes normally and returns its real result; on denial it returns a tool result stating the user declined, with `is_error: false` (a decline is a normal, expected outcome, not a tool failure) so Claude can react appropriately in text rather than treating it as a broken tool call.

This lives entirely inside the tool's `run()` — no separate approval-gating layer bolted onto the Tool Runner, because the Tool Runner's per-turn model already gives each tool a natural place to pause.

## Tools (Phase 2's three)

- **`get_settings`** (READ) — returns the current theme preference and app version. Read-only wrapper around the existing `settings` table via the `getThemePreference`-style pattern from Phase 1's `ipc.ts`.
- **`set_theme`** (SAFE_WRITE) — sets the theme preference (`'light' | 'dark' | 'system'`), reusing Phase 1's `setThemePreference` function directly — no duplicated logic, this tool is a thin wrapper.
- **`clear_conversation_history`** (CONSEQUENTIAL) — deletes every row in `ai_messages` for the current conversation. Genuinely destructive (the entire chat history is gone, no undo), so this is a real test of the confirm-before-execute pause, not a placeholder that only pretends to be dangerous.

These three exist to prove the pipeline (schema → Tool Runner → tiered execution → confirmation round-trip → persistence) end-to-end before Phase 3 adds tools with real external stakes (Canvas, Calendar). No tool beyond these three ships in Phase 2.

## Streaming and status

Stream events relayed to the renderer, one `ai:stream-event` IPC message per event, each carrying a discriminated `type`:

- `text-delta` — incremental assistant text (renders in place in the message list)
- `tool-status` — `{ toolName, status: 'running' }`, emitted when a `tool_use` content block starts (before the tool actually executes) — renders as a transient "Reading settings…"-style line, matching the master-prompt's "make it feel alive" bar. A human-readable label per tool (not the raw function name) lives in the tool registry alongside its schema.
- `turn-complete` — the turn finished; renderer stops showing any "thinking" indicator

`ai:confirm-request`/`ai:confirm-response` (described under Permission system, above) are a **separate**, dedicated IPC channel pair, not a variant of `ai:stream-event` — a pending confirmation blocks that specific tool call on a matching response, which is a different contract than the fire-and-forget stream deltas above, so it doesn't share their channel.

## Chat UI — three surfaces

1. **AI nav section** (`src/renderer/src/routes/AI.tsx`, replacing the placeholder) — the real chat view: scrollable message list (streamed text updates in place as deltas arrive), inline confirmation cards for paused tool calls (tool name, plain-language description, Approve/Deny), a transient tool-status line during execution, and a text input.
2. **Global overlay** — toggled by a keyboard shortcut (Cmd+J), rendered in-window as a centered modal layered over whatever section is currently showing. Explicitly **not** a second `BrowserWindow` — Phase 1's whole-branch review found exactly that mistake and fixed it; this phase doesn't reintroduce it. Shares the same conversation and the same underlying chat hook/component as the AI section — one assistant, two entry points, never two histories.
3. **Command palette** (Cmd+K) — a separate, simpler thing from the AI overlay: a filterable list of the 11 nav sections (jump to section) plus a couple of static actions ("Ask AI" opens the overlay, theme toggle). Text-only, arrow-key navigable, no AI involved in the palette itself.

## IPC contract

Adds to Phase 1's `window.smartlife` bridge:

```ts
window.smartlife.ai = {
  sendMessage(text: string): Promise<void>, // fire-and-forget; the reply arrives via stream events
  onStreamEvent(cb: (event: StreamEvent) => void): () => void,
  onConfirmRequest(cb: (req: { id: string; toolName: string; description: string }) => void): () => void,
  respondToConfirm(id: string, approved: boolean): Promise<void>,
  getHistory(): Promise<Message[]>, // loads the single conversation's messages on mount
  getMode(): Promise<'ask' | 'assist' | 'auto'>,
  setMode(mode: 'ask' | 'assist' | 'auto'): Promise<void>,
}
```

No `getConversations`/`createConversation` — Phase 2 has exactly one conversation, created lazily by the main process the first time `sendMessage` or `getHistory` is called and no `ai_conversations` row exists yet. Multi-conversation IPC methods are additive whenever that feature actually lands, not something to stub out now.

## Error handling

- No API key stored → AI section/overlay show a "Connect Claude in Settings" empty state; the command palette's "Ask AI" action still opens the overlay (which then shows the empty state) rather than silently doing nothing.
- Stream/network failure mid-turn → the partial assistant message already rendered stays on screen; a short inline error line is appended ("Something went wrong — try again"), matching the confirm-before-write project's established fallback text style. The failed turn is not persisted as a broken half-message; only fully completed turns get written to `ai_messages`.
- `safeStorage.isEncryptionAvailable()` false at key-save time → show an error in Settings rather than silently storing a plaintext fallback.

## Testing

- Tier-gating logic (`resolveExecutionMode(tier, mode) -> 'auto' | 'pause'`) is pure and fully unit-tested against all nine tier×mode combinations.
- `get_settings`/`set_theme`/`clear_conversation_history`'s underlying DB logic (separate from the confirmation plumbing) is tested the same way Phase 1 tested `getThemePreference`/`setThemePreference` — real in-memory SQLite, no mocking.
- The confirmation round-trip (`run()` awaiting a promise resolved by a later IPC call) is tested by simulating both the approve and deny paths against a stubbed `respondToConfirm`.
- Streaming/IPC relay and the Tool Runner integration itself are not meaningfully unit-testable (same reasoning as Phase 1's `menu.ts`/assembled `main/index.ts`) — verified manually by the controller after implementation, same as Phase 1's closing visual pass.

## Explicitly out of scope for Phase 2

No Canvas, no Google Calendar, no browser, no multi-provider routing logic (the interface exists, the routing doesn't), no multi-conversation UI, no memory/context system beyond the one conversation's own history, no cost controls or usage dashboards. All of these are later phases per `ROADMAP.md`.

## Global constraints

- macOS only, no network calls outside the Anthropic API itself.
- No dependency beyond `@anthropic-ai/sdk` (new) plus everything already installed in Phase 1. No Zod — the raw-JSON-Schema Tool Runner form is used specifically to avoid it.
- `contextIsolation`/`sandbox`/no-`nodeIntegration` — unchanged, already enforced on the one `BrowserWindow` Phase 1 established. The AI overlay is in-window UI, not a new window, so this doesn't need revisiting.
- The Anthropic API key never leaves the main process in plaintext, is never logged, and is never sent to the renderer in any IPC payload.
- `ai_mode` defaults to `'ask'` (most conservative) when unset.
