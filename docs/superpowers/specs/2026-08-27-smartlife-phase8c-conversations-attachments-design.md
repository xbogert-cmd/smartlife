# Phase 8c: Conversations & Attachments — Design

**Status:** Approved, ready for planning.

## Motivation

Phase 8b shipped web search, screenshot vision, and file uploads, but deliberately kept two things placeholder-only to stay in scope: there is exactly one conversation (`getOrCreateConversationId` always returns the oldest row — "starting over" means clearing the only conversation that exists), and attachment content is used for one turn only, then dropped from history (only a placeholder note like `[attached: notes.txt — 1,200 chars extracted]` persists).

This phase delivers both, the way the user described wanting them: labeled, switchable conversations like Claude/ChatGPT, with full text-attachment retention now that there's a real per-conversation scope for it to live in. It also fixes a related but separate problem: the system prompt currently frames the assistant as scoped to Canvas/Calendar/browser, which can make it hedge on ordinary general-knowledge questions it's fully capable of answering.

## Global Constraints

- Tests run via `npm test` (sets `ELECTRON_RUN_AS_NODE=1`) — never `npx vitest run`.
- No new tables. `ai_conversations` (id, title, created_at, updated_at) and `ai_messages` already support multiple conversations — the gap is entirely in application code always assuming one.
- Launch always creates and opens a brand-new conversation. Old conversations are never auto-opened; they wait in the sidebar list until switched to.
- Conversation titles: derived once from the first ~48 characters of the first user message, stored in `ai_conversations.title`, editable afterward via a rename control. No AI call involved in titling.
- Text-attachment content (PDF/docx/txt extracted text) persists in full, forever, in the conversation it was attached to — no cap, no compaction. Image attachments keep Phase 8b's existing behavior exactly: used for the one turn, then only a placeholder note persists. This is a deliberate asymmetry — text is cheap to store and resend; image bytes are not.
- Deleting a conversation cascades to its messages via the existing FK (`ai_messages.conversation_id references ai_conversations(id) on delete cascade`) — no new cleanup code needed.
- The `turnInFlight` boolean in `chatController.ts` (already flagged with its own `ponytail:` comment as a single-conversation shortcut) must become a per-conversation guard — sending in one conversation must not block another.
- System prompt reframing is a content-only change to `BASE_PROMPT` in `viewContext.ts` — no new logic, no new parameters beyond what's already there.

## Architecture

### 1. Conversation lifecycle API

New functions in `ai/conversation.ts`, alongside the existing `getOrCreateConversationId`/`appendMessage`/`getMessages`/`clearMessages`:

```ts
export function createConversation(db: Database.Database): string // returns new id
export function listConversations(db: Database.Database): Array<{ id: string; title: string | null; updatedAt: string }> // newest updated_at first
export function renameConversation(db: Database.Database, id: string, title: string): void
export function deleteConversation(db: Database.Database, id: string): void
export function setConversationTitleIfUnset(db: Database.Database, id: string, firstUserText: string): void
  // truncates firstUserText to 48 chars, only writes if title is currently null -- called once,
  // right after the first user message of a new conversation is persisted
```

`getOrCreateConversationId` stays as-is (still used by `ai:get-history`'s legacy no-arg path is removed — see below) but is no longer the thing `chatController.ts` calls internally; conversation id becomes a required, explicit parameter threaded from the renderer.

### 2. IPC surface (`ai/ipc.ts`)

New handlers:
- `ai:list-conversations` → `listConversations(db)`
- `ai:create-conversation` → `createConversation(db)`, returns the new id
- `ai:rename-conversation(id, title)` → `renameConversation(db, id, title)`
- `ai:delete-conversation(id)` → `deleteConversation(db, id)`

Changed handlers:
- `ai:get-history(conversationId)` — now requires the id; drops the implicit "the" conversation.
- `ai:send-message(text, view, attachmentIds, conversationId)` — `conversationId` is a new required 4th positional arg (attachmentIds already exists as the 3rd from Phase 8b).

### 3. `chatController.handleSendMessage`

Signature changes to take `conversationId` explicitly instead of deriving it:

```ts
export async function handleSendMessage(
  db: Database.Database,
  getWindow: () => BrowserWindow | null,
  userText: string,
  view: ViewContext | null,
  conversationId: string,
  options: { attachmentIds?: string[]; provider?: AIProvider } = {}
): Promise<void>
```

The single `let turnInFlight = false` module boolean becomes:

```ts
const conversationsInFlight = new Set<string>();
```

checked and set/cleared by `conversationId` instead of unconditionally — the existing "still working on the last message" busy reply now only fires for a *second* concurrent send to the *same* conversation, never for a different one.

After a successful `streamTurn`, the code that persists the user message and calls `setConversationTitleIfUnset` runs in this order: persist user message → `setConversationTitleIfUnset(db, conversationId, userText)` (no-ops after the first call, since `title` is no longer null) → persist assistant message.

### 4. Attachment retention (`attachments/pickAttachment.ts`)

`takeAttachments`'s return shape changes so callers can tell text and image blocks apart, instead of collapsing everything into one placeholder string list:

```ts
export function takeAttachments(ids: string[]): {
  blocks: CanonicalContentBlock[];          // unchanged -- used for this turn's request, same as today
  persistedTextBlocks: CanonicalTextBlock[]; // NEW -- one CanonicalTextBlock per redeemed text attachment, full content
  imagePlaceholders: string[];               // renamed from `placeholders` -- only image attachments produce these now
}
```

`chatController.ts`'s persisted-user-message assembly changes from today's placeholder-string concatenation to:

```ts
const { blocks: attachments, persistedTextBlocks, imagePlaceholders } = takeAttachments(attachmentIds);
// ...
const userContent: CanonicalContentBlock[] = [
  { type: 'text', text: userText },
  ...persistedTextBlocks,
  ...(imagePlaceholders.length > 0 ? [{ type: 'text' as const, text: imagePlaceholders.join('\n') }] : []),
];
appendMessage(db, conversationId, 'user', userContent);
```

So a PDF's full extracted text becomes its own `CanonicalTextBlock` in that stored message's content array — present verbatim on every future load of `getMessages`, and therefore included in `history` on every later turn in that conversation, same as any other persisted text block. Image attachments are unaffected: still turn-only via `blocks`, still leave only a placeholder note (`imagePlaceholders`) in history.

### 5. `clear_conversation_history` tool

No change. It already reads `ctx.conversationId` (set per-turn in `chatController.ts`'s `ToolContext` construction) rather than any global — already correct for a multi-conversation world.

### 6. Renderer: `useConversation.ts`

Gains conversation-list state and the id of the active conversation:

```ts
const [conversations, setConversations] = useState<Array<{ id: string; title: string | null; updatedAt: string }>>([]);
const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
```

On mount: calls `ai:create-conversation` (matches "always start new on launch"), sets it active, and loads `ai:list-conversations` for the sidebar. New callbacks:

```ts
switchConversation(id: string): void        // sets activeConversationId, loads that conversation's history via ai:get-history(id)
startNewConversation(): void                 // ai:create-conversation, switches to it, clears in-memory messages
renameConversation(id: string, title: string): void
deleteConversation(id: string): void
  // if id === activeConversationId, calls startNewConversation() after deleting,
  // so the dock is never left pointed at a conversation that no longer exists
```

`sendMessage` passes `activeConversationId` as `ai:send-message`'s new 4th argument.

### 7. UI: `AIDock.tsx` / new `ConversationSidebar.tsx`

`AIDock.tsx` grows a collapsible left rail inside the existing `aside`, toggled by a small icon button next to "Assistant" in the header (collapsed by default, since the dock is already a fixed 384px panel and this keeps that width for anyone who never touches it). Expanded, it lists conversations newest-first: title, relative last-updated time, a rename (pencil) control, and a delete (trash) control that shows an inline "Delete this conversation?" confirm before calling `deleteConversation`. A "New" button sits above the list.

`ChatPanel.tsx` itself is unaffected beyond receiving `messages`/`statusLabel`/etc. for whichever conversation is currently active — it has no conversation-awareness of its own today and doesn't need any.

### 8. System prompt reframing (`viewContext.ts`)

`BASE_PROMPT`'s first paragraph changes from:

> "You are SmartLife's built-in assistant, running inside a local macOS app that holds the user's Canvas coursework, Google Calendar, and an embedded browser. Be concise and concrete. When you use a tool, say what you found rather than narrating the call."

to:

> "You are a general-purpose AI assistant running inside SmartLife, a local macOS app. Answer any question the user asks, the same as any capable AI assistant would — you are not limited to app-related topics. You also have deep, live context on the user's Canvas coursework, Google Calendar, and embedded browser, and tools to act on them, which you should use whenever relevant. Be concise and concrete. When you use a tool, say what you found rather than narrating the call."

Every other line in `BASE_PROMPT` (the anti-guessing rule, the page-content-is-data rule, the page-content-can't-override-facts rule) is untouched.

## Testing approach

- `conversation.test.ts` gains coverage for `createConversation`, `listConversations` (ordering by `updated_at` desc), `renameConversation`, `deleteConversation` (cascade to messages), `setConversationTitleIfUnset` (sets once, no-ops on a second call, truncates to 48 chars).
- `chatController.test.ts`'s existing tests thread a `conversationId` through every call site; new tests cover: two concurrent sends to two different conversations both proceed (no false "still working" reply), a second concurrent send to the *same* conversation still gets the busy reply, and the title gets set after the first turn but not overwritten by a second.
- `pickAttachment.test.ts` / `chatController.test.ts` gain a test that a text attachment's full content reappears in `history` on a subsequent turn in the same conversation (the actual regression Phase 8b's placeholder-only design left open), and that an image attachment does not.
- `ipc.test.ts` gains tests for the four new handlers and the two changed ones' new required params.
- `useConversation.test.ts` and `AIDock`/`ChatPanel` tests gain coverage for: launch creates a new conversation, switching loads that conversation's history, delete-the-active-conversation falls through to a fresh one, rename updates the sidebar row.

## Deferred (explicitly out of scope for this phase)

- Cross-conversation search.
- History compaction/summarization for conversations that grow very large (no cap was chosen for attachments or messages in general — a real limitation if someone runs one conversation for months, deliberately deferred rather than guessed at).
