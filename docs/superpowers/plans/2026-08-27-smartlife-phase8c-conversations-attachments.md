# Phase 8c: Conversations & Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SmartLife's single implicit AI conversation with real, switchable, labeled conversations, retain uploaded text-attachment content across turns instead of dropping it after one use, and reframe the system prompt so the assistant reads as general-purpose rather than app-scoped.

**Architecture:** `ai_conversations`/`ai_messages` already support multiple rows; this phase adds the CRUD functions, IPC surface, and renderer state that actually use that capability, threading an explicit `conversationId` through every layer that today assumes there's only one. Attachment retention changes `takeAttachments`'s return shape so text content becomes real persisted message blocks instead of placeholder strings.

**Tech Stack:** Electron + React + better-sqlite3 (existing stack, no new dependencies).

## Global Constraints

- Tests run via `npm test` (sets `ELECTRON_RUN_AS_NODE=1`) — never `npx vitest run`, which uses system Node and breaks better-sqlite3's native ABI, producing ~200 bogus failures.
- No new tables or migrations — `ai_conversations` (id, title, created_at, updated_at) and `ai_messages` (id, conversation_id, role, content, created_at) already exist as of `0002_ai_core.sql`.
- Launch always creates and opens a brand-new conversation; old conversations wait in the sidebar until switched to, never auto-opened.
- Conversation titles are derived once from the first ~48 characters of the first user message, stored in `ai_conversations.title`, editable afterward. No AI call involved.
- Text-attachment content (PDF/docx/txt extracted text) persists in full, forever, in the conversation it was attached to. Image attachments keep today's exact behavior: used for one turn, then only a placeholder note persists.
- Deleting a conversation relies on the existing `ai_messages.conversation_id references ai_conversations(id) on delete cascade` FK — `foreign_keys = ON` is already set globally in `src/main/db/index.ts`.
- The `turnInFlight` boolean in `chatController.ts` becomes a per-conversation `Set<string>` guard — sending in one conversation must not block another.
- System prompt reframing is a content-only change — copy the new `BASE_PROMPT` text verbatim, do not paraphrase.

---

### Task 1: Conversation lifecycle functions

**Files:**
- Modify: `src/main/ai/conversation.ts`
- Test: `src/main/ai/conversation.test.ts`

**Interfaces:**
- Produces: `createConversation(db): string`, `listConversations(db): ConversationSummary[]`, `renameConversation(db, id, title): void`, `deleteConversation(db, id): void`, `setConversationTitleIfUnset(db, id, firstUserText): void`, and the exported type `ConversationSummary { id: string; title: string | null; updatedAt: string }`.
- Consumes: nothing new — same `Database.Database` and `randomUUID` this file already uses.

- [ ] **Step 1: Write the failing tests**

Add to `src/main/ai/conversation.test.ts` (after the existing `describe('conversation helpers', ...)` block, same file):

```ts
describe('conversation lifecycle', () => {
  it('createConversation makes a new, distinct row each call', async () => {
    const { createConversation } = await import('./conversation');
    const db = makeDb();
    const first = createConversation(db);
    const second = createConversation(db);
    expect(first).not.toBe(second);
    const count = db.prepare('select count(*) as count from ai_conversations').get() as { count: number };
    expect(count.count).toBe(2);
  });

  it('listConversations returns newest-updated first', async () => {
    const { createConversation, listConversations } = await import('./conversation');
    const db = makeDb();
    const older = createConversation(db);
    const newer = createConversation(db);
    db.prepare("update ai_conversations set updated_at = '2020-01-01 00:00:00' where id = ?").run(older);
    db.prepare("update ai_conversations set updated_at = '2030-01-01 00:00:00' where id = ?").run(newer);
    const list = listConversations(db);
    expect(list.map((c) => c.id)).toEqual([newer, older]);
    expect(list[0]).toEqual({ id: newer, title: null, updatedAt: '2030-01-01 00:00:00' });
  });

  it('renameConversation sets the title', async () => {
    const { createConversation, renameConversation, listConversations } = await import('./conversation');
    const db = makeDb();
    const id = createConversation(db);
    renameConversation(db, id, 'My Chat');
    expect(listConversations(db)[0].title).toBe('My Chat');
  });

  it('deleteConversation removes the conversation and cascades to its messages', async () => {
    const { createConversation, deleteConversation, appendMessage, listConversations, getMessages } = await import(
      './conversation'
    );
    const db = makeDb();
    const id = createConversation(db);
    appendMessage(db, id, 'user', [{ type: 'text', text: 'hi' }]);
    deleteConversation(db, id);
    expect(listConversations(db)).toEqual([]);
    expect(getMessages(db, id)).toEqual([]);
  });

  it('setConversationTitleIfUnset sets the title from the first message, truncated to 48 chars', async () => {
    const { createConversation, setConversationTitleIfUnset, listConversations } = await import('./conversation');
    const db = makeDb();
    const id = createConversation(db);
    const longText = 'x'.repeat(80);
    setConversationTitleIfUnset(db, id, longText);
    const title = listConversations(db)[0].title;
    expect(title).toHaveLength(49); // 48 chars + the '…' truncation marker
    expect(title).toBe(`${'x'.repeat(48)}…`);
  });

  it('setConversationTitleIfUnset does not overwrite a title that is already set', async () => {
    const { createConversation, setConversationTitleIfUnset, renameConversation, listConversations } = await import(
      './conversation'
    );
    const db = makeDb();
    const id = createConversation(db);
    renameConversation(db, id, 'Already Named');
    setConversationTitleIfUnset(db, id, 'first message text');
    expect(listConversations(db)[0].title).toBe('Already Named');
  });

  it('setConversationTitleIfUnset stores short text unchanged, with no truncation marker', async () => {
    const { createConversation, setConversationTitleIfUnset, listConversations } = await import('./conversation');
    const db = makeDb();
    const id = createConversation(db);
    setConversationTitleIfUnset(db, id, 'short question');
    expect(listConversations(db)[0].title).toBe('short question');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- conversation.test.ts`
Expected: FAIL — `createConversation`, `listConversations`, `renameConversation`, `deleteConversation`, `setConversationTitleIfUnset` are not exported from `./conversation`.

- [ ] **Step 3: Implement**

Add to `src/main/ai/conversation.ts` (after the existing `getOrCreateConversationId` function, before `appendMessage`):

```ts
export interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}

export function createConversation(db: Database.Database): string {
  const id = randomUUID();
  db.prepare('insert into ai_conversations (id) values (?)').run(id);
  return id;
}

export function listConversations(db: Database.Database): ConversationSummary[] {
  const rows = db
    .prepare('select id, title, updated_at from ai_conversations order by updated_at desc')
    .all() as Array<{ id: string; title: string | null; updated_at: string }>;
  return rows.map((row) => ({ id: row.id, title: row.title, updatedAt: row.updated_at }));
}

export function renameConversation(db: Database.Database, id: string, title: string): void {
  db.prepare('update ai_conversations set title = ? where id = ?').run(title, id);
}

export function deleteConversation(db: Database.Database, id: string): void {
  db.prepare('delete from ai_conversations where id = ?').run(id);
}

const TITLE_MAX_LENGTH = 48;

export function setConversationTitleIfUnset(db: Database.Database, id: string, firstUserText: string): void {
  const row = db.prepare('select title from ai_conversations where id = ?').get(id) as
    | { title: string | null }
    | undefined;
  if (!row || row.title !== null) return;
  const title =
    firstUserText.length > TITLE_MAX_LENGTH ? `${firstUserText.slice(0, TITLE_MAX_LENGTH)}…` : firstUserText;
  db.prepare('update ai_conversations set title = ? where id = ?').run(title, id);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- conversation.test.ts`
Expected: PASS, all tests including the pre-existing `describe('conversation helpers', ...)` block.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/conversation.ts src/main/ai/conversation.test.ts
git commit -m "Add conversation lifecycle functions: create, list, rename, delete, auto-title"
```

---

### Task 2: Attachment retention — split text from image placeholders

**Files:**
- Modify: `src/main/ai/attachments/pickAttachment.ts`
- Test: `src/main/ai/attachments/pickAttachment.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `takeAttachments(ids: string[]): { blocks: CanonicalContentBlock[]; persistedTextBlocks: CanonicalTextBlock[]; imagePlaceholders: string[] }` — replaces today's `{ blocks, placeholders }` return shape. Task 3 (`chatController.ts`) consumes this new shape.

- [ ] **Step 1: Write the failing tests**

Replace the two affected tests in `src/main/ai/attachments/pickAttachment.test.ts` (the `'extracts .txt content...'` test and the `'reads an image file...'` test) with:

```ts
  it('extracts .txt content directly and returns it as a persisted text block, not a placeholder', async () => {
    const { readFile } = await import('node:fs/promises');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/notes.txt'] });
    vi.mocked(readFile).mockResolvedValue('some notes' as never);
    const { pickAttachment, takeAttachments } = await import('./pickAttachment');
    const result = await pickAttachment(null, true);
    expect(result).toMatchObject({ ok: true, name: 'notes.txt', kind: 'text' });
    if (result?.ok !== true) throw new Error('expected ok');
    const { blocks, persistedTextBlocks, imagePlaceholders } = takeAttachments([result.id]);
    expect(blocks).toEqual([{ type: 'text', text: 'some notes' }]);
    expect(persistedTextBlocks).toEqual([{ type: 'text', text: 'some notes' }]);
    expect(imagePlaceholders).toEqual([]);
  });

  it('reads an image file into a base64 image block when supportsVision is true, and only a placeholder note (no persisted text block)', async () => {
    const { readFile } = await import('node:fs/promises');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/photo.png'] });
    vi.mocked(readFile).mockResolvedValue(Buffer.from('fake-bytes') as never);
    const { pickAttachment, takeAttachments } = await import('./pickAttachment');
    const result = await pickAttachment(null, true);
    expect(result).toMatchObject({ ok: true, kind: 'image' });
    if (result?.ok !== true) throw new Error('expected ok');
    const { blocks, persistedTextBlocks, imagePlaceholders } = takeAttachments([result.id]);
    expect(blocks).toEqual([{ type: 'image', mimeType: 'image/png', data: Buffer.from('fake-bytes').toString('base64') }]);
    expect(persistedTextBlocks).toEqual([]);
    expect(imagePlaceholders).toEqual(['[attached: photo.png — image]']);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- pickAttachment.test.ts`
Expected: FAIL — `persistedTextBlocks`/`imagePlaceholders` are `undefined` (current code returns `{ blocks, placeholders }`).

- [ ] **Step 3: Implement**

In `src/main/ai/attachments/pickAttachment.ts`, add `CanonicalTextBlock` to the existing type-only import from `../providers/types`:

```ts
import type { CanonicalContentBlock, CanonicalTextBlock } from '../providers/types';
```

Replace the existing `takeAttachments` function with:

```ts
/** Redeems each id at most once -- an unknown or already-redeemed id is
 *  silently skipped rather than erroring, since a send that races a stale
 *  attachment chip in the renderer should still succeed with what's left.
 *  Text attachments' full content is returned for persistence
 *  (persistedTextBlocks); image attachments only ever leave a placeholder
 *  note behind (imagePlaceholders) -- their bytes are turn-scoped only, see
 *  CanonicalContentBlock's doc comment in providers/types.ts. */
export function takeAttachments(ids: string[]): {
  blocks: CanonicalContentBlock[];
  persistedTextBlocks: CanonicalTextBlock[];
  imagePlaceholders: string[];
} {
  const blocks: CanonicalContentBlock[] = [];
  const persistedTextBlocks: CanonicalTextBlock[] = [];
  const imagePlaceholders: string[] = [];
  for (const id of ids) {
    const attachment = pending.get(id);
    if (!attachment) continue;
    blocks.push(attachment.block);
    if (attachment.block.type === 'text') {
      persistedTextBlocks.push(attachment.block);
    } else {
      imagePlaceholders.push(attachment.placeholder);
    }
    pending.delete(id);
  }
  return { blocks, persistedTextBlocks, imagePlaceholders };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- pickAttachment.test.ts`
Expected: PASS, all tests including the three untouched ones (`returns null when cancelled`, `rejects an image file when supportsVision is false`, `rejects an unsupported extension`, `takeAttachments only redeems an id once`).

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/attachments/pickAttachment.ts src/main/ai/attachments/pickAttachment.test.ts
git commit -m "Split takeAttachments into persisted text blocks and image-only placeholders"
```

---

### Task 3: Thread conversationId and full text-attachment retention through chatController

**Files:**
- Modify: `src/main/ai/chatController.ts`
- Test: `src/main/ai/chatController.test.ts`

**Interfaces:**
- Consumes: `createConversation`/`setConversationTitleIfUnset` from Task 1 (only `setConversationTitleIfUnset` is actually called here; `createConversation` is used by the renderer in Task 5, not here). `takeAttachments`'s new `{ blocks, persistedTextBlocks, imagePlaceholders }` shape from Task 2.
- Produces: `handleSendMessage(db, getWindow, userText, view, conversationId: string, options?)` — `conversationId` is a new required 5th parameter (before `options`). Task 4 (`ipc.ts`) calls this with the new signature.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `src/main/ai/chatController.test.ts` with:

```ts
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { setStoredApiKey } from './apiKey';
import { ProviderError, type AIProvider, type CanonicalContentBlock, type CanonicalTextBlock } from './providers/types';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
  app: { getPath: () => '/tmp/logs' },
}));

const takeAttachmentsMock = vi.fn(
  (): { blocks: CanonicalContentBlock[]; persistedTextBlocks: CanonicalTextBlock[]; imagePlaceholders: string[] } => ({
    blocks: [],
    persistedTextBlocks: [],
    imagePlaceholders: [],
  })
);
vi.mock('./attachments/pickAttachment', () => ({ takeAttachments: takeAttachmentsMock }));

const INIT_SQL = `create table settings (key text primary key, value text not null);`;
const AI_PROVIDERS_SQL = `create table ai_provider_ranking (rank integer primary key, provider text not null, model text not null);`;
const AI_CORE_SQL = `
create table ai_conversations (id text primary key, title text, created_at text not null default (datetime('now')), updated_at text not null default (datetime('now')));
create table ai_messages (id text primary key, conversation_id text not null references ai_conversations(id) on delete cascade, role text not null, content text not null, created_at text not null default (datetime('now')));
`;
const CANVAS_SQL = `
create table canvas_courses (
  id integer primary key, name text not null, course_code text, term_name text,
  current_score real, current_grade text, synced_at text not null default (datetime('now'))
);
create table canvas_assignments (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  name text not null, description text, due_at text, points_possible real, html_url text,
  submission_types text, has_submitted integer not null default 0, submitted_at text,
  score real, grade text, workflow_state text, synced_at text not null default (datetime('now'))
);
create table canvas_discussion_topics (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  assignment_id integer, title text, require_initial_post integer not null default 0,
  synced_at text not null default (datetime('now'))
);
create table assignment_drafts (
  assignment_id integer primary key references canvas_assignments(id) on delete cascade,
  body text not null, updated_at text not null default (datetime('now'))
);
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, [
    { filename: '0001_init.sql', sql: INIT_SQL },
    { filename: '0002_ai_core.sql', sql: AI_CORE_SQL },
    { filename: '0003_canvas.sql', sql: CANVAS_SQL },
    { filename: '0007_ai_providers.sql', sql: AI_PROVIDERS_SQL },
  ]);
  return db;
}

function fakeWindow() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return { sent, webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } };
}

async function makeConversation(db: Database.Database): Promise<string> {
  const { createConversation } = await import('./conversation');
  return createConversation(db);
}

describe('handleSendMessage', () => {
  it('shows a configuration prompt and never persists messages when no API key is stored', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    const conversationId = await makeConversation(db);
    const window = fakeWindow();
    await handleSendMessage(db, () => window as never, 'hello', null, conversationId);
    expect(window.sent.some((s) => JSON.stringify(s.payload).includes('Settings'))).toBe(true);
    const count = db.prepare('select count(*) as count from ai_messages').get() as { count: number };
    expect(count.count).toBe(0);
  });

  it('persists the user message and the final assistant message on success', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const conversationId = await makeConversation(db);
    const window = fakeWindow();
    const provider: AIProvider = { streamTurn: vi.fn().mockResolvedValue([{ type: 'text', text: 'Hi there!' }]) };
    await handleSendMessage(db, () => window as never, 'hello', null, conversationId, { provider });
    const rows = db.prepare('select role, content from ai_messages order by created_at').all() as Array<{
      role: string;
      content: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].role).toBe('user');
    expect(JSON.parse(rows[0].content)).toEqual([{ type: 'text', text: 'hello' }]);
    expect(rows[1].role).toBe('assistant');
    expect(JSON.parse(rows[1].content)).toEqual([{ type: 'text', text: 'Hi there!' }]);
  });

  it('sets the conversation title from the first message, and does not overwrite it on a second message', async () => {
    const { handleSendMessage } = await import('./chatController');
    const { listConversations } = await import('./conversation');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const conversationId = await makeConversation(db);
    const window = fakeWindow();
    const provider: AIProvider = { streamTurn: vi.fn().mockResolvedValue([{ type: 'text', text: 'ok' }]) };
    await handleSendMessage(db, () => window as never, 'what is the capital of France', null, conversationId, { provider });
    expect(listConversations(db)[0].title).toBe('what is the capital of France');
    await handleSendMessage(db, () => window as never, 'and Germany', null, conversationId, { provider });
    expect(listConversations(db)[0].title).toBe('what is the capital of France');
  });

  it('does not persist anything and emits an error when the provider throws', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const conversationId = await makeConversation(db);
    const window = fakeWindow();
    const provider: AIProvider = { streamTurn: vi.fn().mockRejectedValue(new Error('network down')) };
    await handleSendMessage(db, () => window as never, 'hello', null, conversationId, { provider });
    const count = db.prepare('select count(*) as count from ai_messages').get() as { count: number };
    expect(count.count).toBe(0);
    expect(window.sent.some((s) => JSON.stringify(s.payload).includes('went wrong'))).toBe(true);
  });

  it('shows a ProviderError’s own message verbatim instead of the generic fallback', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const conversationId = await makeConversation(db);
    const window = fakeWindow();
    const provider: AIProvider = {
      streamTurn: vi.fn().mockRejectedValue(new ProviderError('Your credit balance is too low to access the Anthropic API.')),
    };
    await handleSendMessage(db, () => window as never, 'hello', null, conversationId, { provider });
    expect(
      window.sent.some((s) => JSON.stringify(s.payload).includes('Your credit balance is too low'))
    ).toBe(true);
    expect(window.sent.some((s) => JSON.stringify(s.payload).includes('went wrong'))).toBe(false);
  });

  it('resolves requestConfirmation to false instead of hanging when there is no window', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const conversationId = await makeConversation(db);
    let confirmResult: boolean | undefined;
    const provider: AIProvider = {
      streamTurn: vi.fn().mockImplementation(async ({ ctx }) => {
        confirmResult = await ctx.requestConfirmation('some_tool', 'some description');
        return [{ type: 'text', text: 'done' }];
      }),
    };
    await handleSendMessage(db, () => null, 'hello', null, conversationId, { provider });
    expect(confirmResult).toBe(false);
  });

  it('rejects a second concurrent turn in the SAME conversation with a "still working" message', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const conversationId = await makeConversation(db);
    const window = fakeWindow();

    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const provider: AIProvider = {
      streamTurn: vi.fn().mockImplementation(async () => {
        await gate;
        return [{ type: 'text', text: 'done' }];
      }),
    };

    const firstCall = handleSendMessage(db, () => window as never, 'first', null, conversationId, { provider });
    await Promise.resolve();
    await Promise.resolve();

    const secondCall = handleSendMessage(db, () => window as never, 'second', null, conversationId, { provider });
    await secondCall;

    expect(provider.streamTurn).toHaveBeenCalledTimes(1);
    expect(window.sent.some((s) => JSON.stringify(s.payload).includes('Still working on the last message'))).toBe(true);

    releaseFirst?.();
    await firstCall;

    const rows = db.prepare('select role, content from ai_messages order by created_at').all() as Array<{
      role: string;
      content: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].content)).toEqual([{ type: 'text', text: 'first' }]);
  });

  it('does NOT block a concurrent turn in a DIFFERENT conversation', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const conversationA = await makeConversation(db);
    const conversationB = await makeConversation(db);
    const window = fakeWindow();

    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const provider: AIProvider = {
      streamTurn: vi.fn().mockImplementation(async () => {
        await gate;
        return [{ type: 'text', text: 'done' }];
      }),
    };

    const firstCall = handleSendMessage(db, () => window as never, 'first', null, conversationA, { provider });
    await Promise.resolve();
    await Promise.resolve();

    releaseFirst?.();
    const secondCall = handleSendMessage(db, () => window as never, 'second', null, conversationB, { provider });
    await Promise.all([firstCall, secondCall]);

    expect(provider.streamTurn).toHaveBeenCalledTimes(2);
    expect(window.sent.some((s) => JSON.stringify(s.payload).includes('Still working on the last message'))).toBe(false);
  });
});

describe('system prompt', () => {
  it('passes a system prompt containing the current date to the provider', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const conversationId = await makeConversation(db);
    const streamTurn = vi.fn().mockResolvedValue([{ type: 'text', text: 'ok' }]);
    await handleSendMessage(db, () => fakeWindow() as never, 'hi', null, conversationId, { provider: { streamTurn } });

    const system = streamTurn.mock.calls[0][0].system as string;
    expect(typeof system).toBe('string');
    expect(system.length).toBeGreaterThan(0);
    expect(system).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('folds the view context into the system prompt', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const conversationId = await makeConversation(db);
    db.prepare("insert into canvas_courses (id, name) values (1, 'Financial Accounting')").run();
    db.prepare(
      `insert into canvas_assignments (id, course_id, name, submission_types)
       values (10, 1, 'Chapter 4 Homework', '["online_text_entry"]')`
    ).run();

    const streamTurn = vi.fn().mockResolvedValue([{ type: 'text', text: 'ok' }]);
    await handleSendMessage(
      db,
      () => fakeWindow() as never,
      'hi',
      { route: 'assignment', assignmentId: 10 },
      conversationId,
      { provider: { streamTurn } }
    );

    expect(streamTurn.mock.calls[0][0].system).toContain('Chapter 4 Homework');
  });

  it('still works when the view context is null', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const conversationId = await makeConversation(db);
    const streamTurn = vi.fn().mockResolvedValue([{ type: 'text', text: 'ok' }]);
    await expect(
      handleSendMessage(db, () => fakeWindow() as never, 'hi', null, conversationId, { provider: { streamTurn } })
    ).resolves.toBeUndefined();
  });
});

describe('attachments', () => {
  it('persists a text attachment’s full content as its own content block, not a placeholder', async () => {
    const { handleSendMessage } = await import('./chatController');
    takeAttachmentsMock.mockReturnValueOnce({
      blocks: [{ type: 'text', text: 'the full pdf text' }],
      persistedTextBlocks: [{ type: 'text', text: 'the full pdf text' }],
      imagePlaceholders: [],
    });
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const conversationId = await makeConversation(db);
    const window = fakeWindow();
    const streamTurn = vi.fn().mockResolvedValue([{ type: 'text', text: 'ok' }]);
    await handleSendMessage(db, () => window as never, 'summarize this', null, conversationId, {
      attachmentIds: ['attach-1'],
      provider: { streamTurn },
    });

    expect(streamTurn.mock.calls[0][0].attachments).toEqual([{ type: 'text', text: 'the full pdf text' }]);

    const rows = db.prepare('select content from ai_messages where role = ?').all('user') as Array<{ content: string }>;
    const persisted = JSON.parse(rows[0].content) as Array<{ type: string; text: string }>;
    expect(persisted).toEqual([
      { type: 'text', text: 'summarize this' },
      { type: 'text', text: 'the full pdf text' },
    ]);
  });

  it('persists an image attachment as only a placeholder note, never the image bytes', async () => {
    const { handleSendMessage } = await import('./chatController');
    takeAttachmentsMock.mockReturnValueOnce({
      blocks: [{ type: 'image', mimeType: 'image/png', data: 'base64data' }],
      persistedTextBlocks: [],
      imagePlaceholders: ['[attached: photo.png — image]'],
    });
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const conversationId = await makeConversation(db);
    const window = fakeWindow();
    const streamTurn = vi.fn().mockResolvedValue([{ type: 'text', text: 'ok' }]);
    await handleSendMessage(db, () => window as never, 'what is this', null, conversationId, {
      attachmentIds: ['attach-1'],
      provider: { streamTurn },
    });

    const rows = db.prepare('select content from ai_messages where role = ?').all('user') as Array<{ content: string }>;
    const persisted = JSON.parse(rows[0].content) as Array<{ type: string; text: string }>;
    expect(persisted).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'text', text: '[attached: photo.png — image]' },
    ]);
    expect(JSON.stringify(persisted)).not.toContain('base64data');
  });

  it('omits attachments entirely from the provider call when none were sent', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const conversationId = await makeConversation(db);
    const streamTurn = vi.fn().mockResolvedValue([{ type: 'text', text: 'ok' }]);
    await handleSendMessage(db, () => fakeWindow() as never, 'hi', null, conversationId, { provider: { streamTurn } });
    expect(streamTurn.mock.calls[0][0].attachments).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- chatController.test.ts`
Expected: FAIL — `handleSendMessage` still has its old 4-arg-plus-options signature and internally calls `getOrCreateConversationId`, so the extra `conversationId` argument in every test call is currently swallowed into where `options` used to be.

- [ ] **Step 3: Implement**

Replace the entire contents of `src/main/ai/chatController.ts` with:

```ts
import type { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { getAiMode } from './mode';
import { appendMessage, getMessages, setConversationTitleIfUnset } from './conversation';
import { requestConfirmation as requestToolConfirmation } from './confirmations';
import { TOOLS } from './tools/registry';
import { getProvider } from './router';
import { takeAttachments } from './attachments/pickAttachment';
import type { ToolContext } from './tools/types';
import {
  ProviderError,
  type AIProvider,
  type CanonicalContentBlock,
  type CanonicalImageBlock,
  type StreamEvent,
} from './providers/types';
import { buildSystemPrompt, type ViewContext } from './viewContext';
import { notifyIfUnfocused } from '../notify';
import { logError } from '../log';

/** One entry per conversation currently mid-turn -- lets two different
 *  conversations send concurrently while still serializing turns within the
 *  same conversation (a second send to a conversation already in flight gets
 *  the "still working" reply instead of starting a second stream). */
const conversationsInFlight = new Set<string>();

export async function handleSendMessage(
  db: Database.Database,
  getWindow: () => BrowserWindow | null,
  userText: string,
  view: ViewContext | null,
  conversationId: string,
  options: { attachmentIds?: string[]; provider?: AIProvider } = {}
): Promise<void> {
  const { attachmentIds = [], provider = getProvider(db) } = options;
  const send = (event: StreamEvent): void => getWindow()?.webContents.send('ai:stream-event', event);

  if (conversationsInFlight.has(conversationId)) {
    send({ type: 'text-delta', text: 'Still working on the last message — try again in a moment.' });
    send({ type: 'turn-complete' });
    return;
  }

  conversationsInFlight.add(conversationId);
  try {
    const mode = getAiMode(db);
    const history = getMessages(db, conversationId).map((m) => ({
      role: m.role,
      content: JSON.parse(m.content) as unknown,
    }));

    const pendingImages: CanonicalImageBlock[] = [];
    const ctx: ToolContext = {
      db,
      conversationId,
      mode,
      pendingImages,
      attachImage: (block) => {
        pendingImages.push(block);
      },
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

    const { blocks: attachments, persistedTextBlocks, imagePlaceholders } = takeAttachments(attachmentIds);

    try {
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
    conversationsInFlight.delete(conversationId);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- chatController.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/chatController.ts src/main/ai/chatController.test.ts
git commit -m "Thread explicit conversationId through handleSendMessage, per-conversation in-flight guard, full text-attachment retention"
```

---

### Task 4: IPC surface and preload

**Files:**
- Modify: `src/main/ai/ipc.ts`
- Modify: `src/preload/index.ts`
- Test: `src/main/ai/ipc.test.ts`

**Interfaces:**
- Consumes: `createConversation`, `listConversations`, `renameConversation`, `deleteConversation` (Task 1); `handleSendMessage`'s new signature (Task 3).
- Produces: IPC channels `ai:list-conversations`, `ai:create-conversation`, `ai:rename-conversation`, `ai:delete-conversation`; changed channels `ai:get-history(conversationId)` and `ai:send-message(text, view, attachmentIds, conversationId)`. Task 5 (`useConversation.ts`) calls these via `window.smartlife.ai`.

- [ ] **Step 1: Write the failing tests**

Add to `src/main/ai/ipc.test.ts`, after the existing `describe('ai:pick-attachment', ...)` block:

```ts
describe('conversation lifecycle IPC handlers', () => {
  it('creates a conversation and lists it newest-first', async () => {
    const { call } = await setup();
    const id = await call('ai:create-conversation');
    expect(typeof id).toBe('string');
    const list = (await call('ai:list-conversations')) as Array<{ id: string; title: string | null }>;
    expect(list).toEqual([{ id, title: null, updatedAt: expect.any(String) }]);
  });

  it('renames a conversation', async () => {
    const { call } = await setup();
    const id = await call('ai:create-conversation');
    await call('ai:rename-conversation', id, 'My Chat');
    const list = (await call('ai:list-conversations')) as Array<{ title: string | null }>;
    expect(list[0].title).toBe('My Chat');
  });

  it('deletes a conversation', async () => {
    const { call } = await setup();
    const id = await call('ai:create-conversation');
    await call('ai:delete-conversation', id);
    expect(await call('ai:list-conversations')).toEqual([]);
  });

  it('gets history scoped to a specific conversation id', async () => {
    const { call } = await setup();
    const id = await call('ai:create-conversation');
    expect(await call('ai:get-history', id)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- ipc.test.ts`
Expected: FAIL — `ai:create-conversation`, `ai:list-conversations`, `ai:rename-conversation`, `ai:delete-conversation` are not registered handlers yet (`handlers.get(channel)!` throws on `undefined()`).

- [ ] **Step 3: Implement**

In `src/main/ai/ipc.ts`, change the import line:

```ts
import { getMessages, createConversation, listConversations, renameConversation, deleteConversation } from './conversation';
```

(This drops the now-unused `getOrCreateConversationId` import.)

Replace the `ai:send-message` handler with:

```ts
  ipcMain.handle(
    'ai:send-message',
    (_event, text: string, view: ViewContext | null, attachmentIds: string[] = [], conversationId: string) =>
      handleSendMessage(db, getWindow, text, view ?? null, conversationId, { attachmentIds })
  );
```

Replace the `ai:get-history` handler with:

```ts
  ipcMain.handle('ai:get-history', (_event, conversationId: string) => {
    return getMessages(db, conversationId).map((m) => ({ role: m.role, content: JSON.parse(m.content) }));
  });
```

Add, immediately after the `ai:get-history` handler:

```ts
  ipcMain.handle('ai:list-conversations', () => listConversations(db));
  ipcMain.handle('ai:create-conversation', () => createConversation(db));
  ipcMain.handle('ai:rename-conversation', (_event, id: string, title: string) => {
    renameConversation(db, id, title);
  });
  ipcMain.handle('ai:delete-conversation', (_event, id: string) => {
    deleteConversation(db, id);
  });
```

In `src/preload/index.ts`, add above the `const smartlife = {` block:

```ts
interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}
```

Inside the `ai: { ... }` object, replace the `sendMessage` and `getHistory` entries with:

```ts
    sendMessage: (text: string, view: unknown = null, attachmentIds: string[] = [], conversationId: string): Promise<void> =>
      ipcRenderer.invoke('ai:send-message', text, view, attachmentIds, conversationId),
```

```ts
    getHistory: (conversationId: string): Promise<AiMessage[]> => ipcRenderer.invoke('ai:get-history', conversationId),
```

Add, immediately after the `pickAttachment` entry inside the `ai: { ... }` object:

```ts
    listConversations: (): Promise<ConversationSummary[]> => ipcRenderer.invoke('ai:list-conversations'),
    createConversation: (): Promise<string> => ipcRenderer.invoke('ai:create-conversation'),
    renameConversation: (id: string, title: string): Promise<void> =>
      ipcRenderer.invoke('ai:rename-conversation', id, title),
    deleteConversation: (id: string): Promise<void> => ipcRenderer.invoke('ai:delete-conversation', id),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- ipc.test.ts`
Expected: PASS, all tests.

Run: `npm run typecheck` (or `npx tsc --noEmit` if no dedicated script exists — check `package.json`'s `scripts` first)
Expected: no new type errors from the preload changes.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/ipc.ts src/main/ai/ipc.test.ts src/preload/index.ts
git commit -m "Add conversation lifecycle IPC channels; thread conversationId through send-message and get-history"
```

---

### Task 5: Renderer conversation state — `useConversation.ts`

**Files:**
- Modify: `src/renderer/src/ai/useConversation.ts`
- Test: `src/renderer/src/ai/useConversation.test.ts`

**Interfaces:**
- Consumes: `window.smartlife.ai.{createConversation, listConversations, renameConversation, deleteConversation, getHistory(id), sendMessage(text, view, attachmentIds, conversationId)}` from Task 4.
- Produces: `useConversation()`'s returned object gains `conversations: ConversationSummary[]`, `activeConversationId: string | null`, `switchConversation(id)`, `startNewConversation()`, `renameConversation(id, title)`, `deleteConversation(id)`. The exported type `ConversationSummary { id: string; title: string | null; updatedAt: string }`. Task 6 (`ConversationSidebar.tsx`, `AIDock.tsx`) consumes all of these.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `src/renderer/src/ai/useConversation.test.ts` with:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useConversation } from './useConversation';

const ai = {
  hasUsableProvider: vi.fn(),
  getHistory: vi.fn(),
  sendMessage: vi.fn(),
  onStreamEvent: vi.fn((_cb: (event: unknown) => void) => () => {}),
  onConfirmRequest: vi.fn((_cb: (req: unknown) => void) => () => {}),
  respondToConfirm: vi.fn(),
  getPendingConfirmation: vi.fn(),
  onConfirmResolved: vi.fn((_cb: (id: string) => void) => () => {}),
  pickAttachment: vi.fn(),
  createConversation: vi.fn(),
  listConversations: vi.fn(),
  renameConversation: vi.fn(),
  deleteConversation: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'smartlife', { value: { ai }, writable: true, configurable: true });
  ai.hasUsableProvider.mockResolvedValue(true);
  ai.getHistory.mockResolvedValue([]);
  ai.getPendingConfirmation.mockResolvedValue(null);
  ai.onStreamEvent.mockReturnValue(() => {});
  ai.onConfirmRequest.mockReturnValue(() => {});
  ai.onConfirmResolved.mockReturnValue(() => {});
  ai.respondToConfirm.mockResolvedValue(undefined);
  ai.sendMessage.mockResolvedValue(undefined);
  ai.createConversation.mockResolvedValue('conv-1');
  ai.listConversations.mockResolvedValue([{ id: 'conv-1', title: null, updatedAt: '2026-01-01 00:00:00' }]);
  ai.renameConversation.mockResolvedValue(undefined);
  ai.deleteConversation.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useConversation — launch always starts a new conversation', () => {
  it('creates a new conversation on mount and sets it active', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(ai.createConversation).toHaveBeenCalled());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));
    expect(result.current.messages).toEqual([]);
  });

  it('populates the conversations list from listConversations after creating the new one', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.conversations).toEqual([{ id: 'conv-1', title: null, updatedAt: '2026-01-01 00:00:00' }]));
  });
});

describe('useConversation — switching conversations', () => {
  it('switchConversation sets the active id and loads that conversation’s history', async () => {
    ai.getHistory.mockImplementation((id: string) =>
      Promise.resolve(id === 'conv-2' ? [{ role: 'user', content: [{ type: 'text', text: 'old message' }] }] : [])
    );
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));

    await act(async () => {
      await result.current.switchConversation('conv-2');
    });

    expect(result.current.activeConversationId).toBe('conv-2');
    expect(result.current.messages).toEqual([{ id: 'history-0', role: 'user', text: 'old message' }]);
  });

  it('startNewConversation creates and switches to a fresh, empty conversation', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));
    ai.createConversation.mockResolvedValue('conv-3');

    await act(async () => {
      await result.current.startNewConversation();
    });

    expect(result.current.activeConversationId).toBe('conv-3');
    expect(result.current.messages).toEqual([]);
  });
});

describe('useConversation — rename and delete', () => {
  it('renameConversation calls the IPC method and refreshes the list', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));
    ai.listConversations.mockResolvedValue([{ id: 'conv-1', title: 'Renamed', updatedAt: '2026-01-01 00:00:00' }]);

    await act(async () => {
      await result.current.renameConversation('conv-1', 'Renamed');
    });

    expect(ai.renameConversation).toHaveBeenCalledWith('conv-1', 'Renamed');
    expect(result.current.conversations).toEqual([{ id: 'conv-1', title: 'Renamed', updatedAt: '2026-01-01 00:00:00' }]);
  });

  it('deleteConversation on a non-active conversation just refreshes the list', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));
    ai.listConversations.mockResolvedValue([]);

    await act(async () => {
      await result.current.deleteConversation('conv-2');
    });

    expect(ai.deleteConversation).toHaveBeenCalledWith('conv-2');
    expect(ai.createConversation).toHaveBeenCalledTimes(1); // only the initial mount call, not a fallback
    expect(result.current.activeConversationId).toBe('conv-1');
  });

  it('deleting the ACTIVE conversation falls through to a fresh new one', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));
    ai.createConversation.mockResolvedValue('conv-fresh');

    await act(async () => {
      await result.current.deleteConversation('conv-1');
    });

    expect(ai.deleteConversation).toHaveBeenCalledWith('conv-1');
    expect(result.current.activeConversationId).toBe('conv-fresh');
    expect(result.current.messages).toEqual([]);
  });
});

describe('useConversation — pending confirmation recovery', () => {
  it('shows no pending confirmation when nothing is outstanding on mount', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(ai.getPendingConfirmation).toHaveBeenCalled());
    expect(result.current.pendingConfirm).toBeNull();
  });

  it('recovers an already-pending confirmation on mount, e.g. the dock was closed while one was outstanding', async () => {
    ai.getPendingConfirmation.mockResolvedValue({ id: 'c1', toolName: 'browser_click', description: 'On https://x.test: Click Submit' });

    const { result } = renderHook(() => useConversation());

    await waitFor(() =>
      expect(result.current.pendingConfirm).toEqual({ id: 'c1', toolName: 'browser_click', description: 'On https://x.test: Click Submit' })
    );
  });

  it('still updates from a live onConfirmRequest push after mounting with nothing pending', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(ai.getPendingConfirmation).toHaveBeenCalled());
    const onRequest = ai.onConfirmRequest.mock.calls[0][0] as (req: unknown) => void;

    onRequest({ id: 'c2', toolName: 'browser_type', description: 'Type X' });

    await waitFor(() => expect(result.current.pendingConfirm?.id).toBe('c2'));
  });

  it('clears pendingConfirm when it resolves through onConfirmResolved rather than this component’s own respondToConfirm, e.g. a timeout firing while the dock is open', async () => {
    ai.getPendingConfirmation.mockResolvedValue({ id: 'c1', toolName: 'browser_click', description: 'Click Submit' });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.pendingConfirm?.id).toBe('c1'));
    const onResolved = ai.onConfirmResolved.mock.calls[0][0] as (id: string) => void;

    onResolved('c1');

    await waitFor(() => expect(result.current.pendingConfirm).toBeNull());
  });

  it('does not clear an unrelated pendingConfirm when a different confirmation id resolves', async () => {
    ai.getPendingConfirmation.mockResolvedValue({ id: 'c1', toolName: 'browser_click', description: 'Click Submit' });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.pendingConfirm?.id).toBe('c1'));
    const onResolved = ai.onConfirmResolved.mock.calls[0][0] as (id: string) => void;

    onResolved('some-other-id');

    expect(result.current.pendingConfirm?.id).toBe('c1');
  });

  it('unsubscribes the confirmation-resolved listener on unmount', async () => {
    const stopResolved = vi.fn();
    ai.onConfirmResolved.mockReturnValue(stopResolved);

    const { unmount } = renderHook(() => useConversation());
    await waitFor(() => expect(ai.getPendingConfirmation).toHaveBeenCalled());
    unmount();

    expect(stopResolved).toHaveBeenCalled();
  });

  it('respondToConfirm still clears pendingConfirm locally after the user approves or declines', async () => {
    ai.getPendingConfirmation.mockResolvedValue({ id: 'c1', toolName: 'browser_click', description: 'Click Submit' });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.pendingConfirm?.id).toBe('c1'));

    await result.current.respondToConfirm(true);

    expect(ai.respondToConfirm).toHaveBeenCalledWith('c1', true);
    await waitFor(() => expect(result.current.pendingConfirm).toBeNull());
  });
});

describe('useConversation — apiKeyConfigured reflects any usable provider', () => {
  it('becomes true from hasUsableProvider even for a Gemini/Ollama-only setup with no Anthropic key', async () => {
    ai.hasUsableProvider.mockResolvedValue(true);
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.apiKeyConfigured).toBe(true));
    expect(ai.hasUsableProvider).toHaveBeenCalled();
  });

  it('becomes false when hasUsableProvider resolves false', async () => {
    ai.hasUsableProvider.mockResolvedValue(false);
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.apiKeyConfigured).toBe(false));
  });
});

describe('useConversation — provider-switched stream event', () => {
  it('starts a fresh message for the new provider instead of appending to the failed provider’s partial text', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(ai.getPendingConfirmation).toHaveBeenCalled());
    const onEvent = ai.onStreamEvent.mock.calls[0][0] as (event: unknown) => void;

    onEvent({ type: 'text-delta', text: 'Hello, I' });
    onEvent({ type: 'text-delta', text: 'm working on' });

    await waitFor(() => {
      const assistantMessages = result.current.messages.filter((m) => m.role === 'assistant');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].text).toBe('Hello, Im working on');
    });

    onEvent({ type: 'provider-switched', from: 'Claude Sonnet 5', to: 'Gemini Flash', reason: 'credit balance too low' });

    await waitFor(() => {
      const switchNotices = result.current.messages.filter((m) => m.kind === 'switch-notice');
      expect(switchNotices).toHaveLength(1);
      expect(switchNotices[0].text).toContain('Gemini Flash');
    });

    onEvent({ type: 'text-delta', text: 'I can help with that.' });

    await waitFor(() => {
      const assistantMessages = result.current.messages.filter((m) => m.role === 'assistant' && m.kind !== 'switch-notice');
      expect(assistantMessages).toHaveLength(2);
      expect(assistantMessages[0].text).toBe('Hello, Im working on');
      expect(assistantMessages[1].text).toBe('I can help with that.');
    });
  });
});

describe('useConversation — attachments', () => {
  it('addAttachment appends a successful pick result to attachments', async () => {
    ai.pickAttachment.mockResolvedValue({ ok: true, id: 'attach-1', name: 'notes.txt', kind: 'text' });
    const { result } = renderHook(() => useConversation());

    await act(async () => {
      await result.current.addAttachment();
    });

    expect(result.current.attachments).toEqual([{ id: 'attach-1', name: 'notes.txt', kind: 'text' }]);
  });

  it('addAttachment sets attachError and adds nothing when the pick fails', async () => {
    ai.pickAttachment.mockResolvedValue({ ok: false, reason: "can't see images" });
    const { result } = renderHook(() => useConversation());

    await act(async () => {
      await result.current.addAttachment();
    });

    expect(result.current.attachments).toEqual([]);
    expect(result.current.attachError).toBe("can't see images");
  });

  it('addAttachment does nothing when the dialog is cancelled (null result)', async () => {
    ai.pickAttachment.mockResolvedValue(null);
    const { result } = renderHook(() => useConversation());

    await act(async () => {
      await result.current.addAttachment();
    });

    expect(result.current.attachments).toEqual([]);
  });

  it('removeAttachment removes one attachment by id', async () => {
    ai.pickAttachment.mockResolvedValue({ ok: true, id: 'attach-1', name: 'notes.txt', kind: 'text' });
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await result.current.addAttachment();
    });

    act(() => {
      result.current.removeAttachment('attach-1');
    });

    expect(result.current.attachments).toEqual([]);
  });

  it('sendMessage passes the active conversation id and current attachment ids, and clears attachments afterward', async () => {
    ai.pickAttachment.mockResolvedValue({ ok: true, id: 'attach-1', name: 'notes.txt', kind: 'text' });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));
    await act(async () => {
      await result.current.addAttachment();
    });

    act(() => {
      result.current.sendMessage('hi');
    });

    expect(ai.sendMessage).toHaveBeenCalledWith('hi', null, ['attach-1'], 'conv-1');
    expect(result.current.attachments).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- useConversation.test.ts`
Expected: FAIL — `activeConversationId`, `conversations`, `switchConversation`, `startNewConversation`, `renameConversation`, `deleteConversation` don't exist on the hook's return value yet, and `sendMessage`'s call is still missing the 4th `conversationId` argument.

- [ ] **Step 3: Implement**

Replace the entire contents of `src/renderer/src/ai/useConversation.ts` with:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  kind?: 'switch-notice';
}

export interface PendingConfirm {
  id: string;
  toolName: string;
  description: string;
}

export interface PendingAttachment {
  id: string;
  name: string;
  kind: 'text' | 'image';
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text: string } => {
      return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text';
    })
    .map((block) => block.text)
    .join('');
}

export function useConversation(view: unknown = null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [sending, setSending] = useState(false);
  // Despite the name, this reflects "is any provider usable" (Anthropic,
  // Gemini, or Ollama), not specifically an Anthropic key -- see
  // hasUsableProvider in router.ts. Kept as apiKeyConfigured to avoid a
  // rename that would touch ChatPanel's prop type and its tests for no
  // functional benefit.
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const streamingIdRef = useRef<string | null>(null);

  useEffect(() => {
    window.smartlife.ai
      .hasUsableProvider()
      .then(setApiKeyConfigured)
      .catch(() => setApiKeyConfigured(false));
  }, []);

  const refreshConversations = useCallback(async () => {
    const list = await window.smartlife.ai.listConversations().catch(() => []);
    setConversations(list);
  }, []);

  // Launch always starts a brand-new conversation -- old ones wait in the
  // sidebar until switched to, never auto-opened.
  useEffect(() => {
    window.smartlife.ai
      .createConversation()
      .then(async (id) => {
        setActiveConversationId(id);
        setMessages([]);
        await refreshConversations();
      })
      .catch(() => {});
  }, [refreshConversations]);

  // Recovers a confirmation that became pending while the dock was closed
  // (and thus this hook wasn't mounted to catch the live onConfirmRequest
  // push) -- same pattern as usePendingConfirmationBadge.ts, which recovers
  // it for the sidebar badge. Also clears pendingConfirm if it resolves
  // through some path other than this component's own respondToConfirm,
  // e.g. the 24-hour timeout firing while the dock happens to be open.
  useEffect(() => {
    let cancelled = false;
    window.smartlife.ai
      .getPendingConfirmation()
      .then((current) => {
        // A live onConfirmRequest push (below) always wins over this
        // recovery fetch -- it can only resolve to something more recent.
        // Without this guard, a slow-resolving fetch that lands after a
        // live push already set pendingConfirm would stomp it back out.
        if (!cancelled) setPendingConfirm((prev) => (prev !== null ? prev : current));
      })
      .catch(() => {});

    const stopResolved = window.smartlife.ai.onConfirmResolved((id) => {
      setPendingConfirm((prev) => (prev?.id === id ? null : prev));
    });

    return () => {
      cancelled = true;
      stopResolved();
    };
  }, []);

  useEffect(() => {
    const unsubscribeStream = window.smartlife.ai.onStreamEvent((event) => {
      if (event.type === 'text-delta') {
        setStatusLabel(null);
        setMessages((prev) => {
          if (streamingIdRef.current) {
            return prev.map((m) => (m.id === streamingIdRef.current ? { ...m, text: m.text + (event.text ?? '') } : m));
          }
          const id = `assistant-${Date.now()}-${Math.random()}`;
          streamingIdRef.current = id;
          return [...prev, { id, role: 'assistant', text: event.text ?? '' }];
        });
      } else if (event.type === 'tool-status') {
        setStatusLabel(event.toolLabel ?? null);
      } else if (event.type === 'turn-complete') {
        setStatusLabel(null);
        streamingIdRef.current = null;
        setSending(false);
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
    });

    const unsubscribeConfirm = window.smartlife.ai.onConfirmRequest((req) => {
      setPendingConfirm(req);
    });

    return () => {
      unsubscribeStream();
      unsubscribeConfirm();
    };
  }, []);

  const addAttachment = useCallback(async () => {
    const result = await window.smartlife.ai.pickAttachment().catch(() => null);
    if (!result) return;
    if (!result.ok) {
      setAttachError(result.reason);
      return;
    }
    setAttachError(null);
    setAttachments((prev) => [...prev, { id: result.id, name: result.name, kind: result.kind }]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const sendMessage = useCallback(
    (text: string) => {
      if (!activeConversationId) return;
      const id = `user-${Date.now()}-${Math.random()}`;
      setMessages((prev) => [...prev, { id, role: 'user', text }]);
      setSending(true);
      streamingIdRef.current = null;
      const attachmentIds = attachments.map((a) => a.id);
      setAttachments([]);
      window.smartlife.ai
        .sendMessage(text, view, attachmentIds, activeConversationId)
        .then(() => refreshConversations())
        .catch(() => {
          setSending(false);
          setMessages((prev) => [
            ...prev,
            { id: `assistant-${Date.now()}-${Math.random()}`, role: 'assistant', text: 'Something went wrong — try again.' },
          ]);
        });
    },
    [view, attachments, activeConversationId, refreshConversations]
  );

  const respondToConfirm = useCallback(
    async (approved: boolean) => {
      if (!pendingConfirm) return;
      await window.smartlife.ai.respondToConfirm(pendingConfirm.id, approved).catch(() => {});
      setPendingConfirm(null);
    },
    [pendingConfirm]
  );

  const switchConversation = useCallback(async (id: string) => {
    setActiveConversationId(id);
    streamingIdRef.current = null;
    setStatusLabel(null);
    const history = await window.smartlife.ai.getHistory(id).catch(() => []);
    setMessages(history.map((m, index) => ({ id: `history-${index}`, role: m.role, text: extractText(m.content) })));
  }, []);

  const startNewConversation = useCallback(async () => {
    const id = await window.smartlife.ai.createConversation();
    setActiveConversationId(id);
    setMessages([]);
    streamingIdRef.current = null;
    setStatusLabel(null);
    await refreshConversations();
  }, [refreshConversations]);

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      await window.smartlife.ai.renameConversation(id, title);
      await refreshConversations();
    },
    [refreshConversations]
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      await window.smartlife.ai.deleteConversation(id);
      if (id === activeConversationId) {
        await startNewConversation();
      } else {
        await refreshConversations();
      }
    },
    [activeConversationId, startNewConversation, refreshConversations]
  );

  return {
    messages,
    statusLabel,
    pendingConfirm,
    sending,
    apiKeyConfigured,
    attachments,
    attachError,
    addAttachment,
    removeAttachment,
    sendMessage,
    respondToConfirm,
    conversations,
    activeConversationId,
    switchConversation,
    startNewConversation,
    renameConversation,
    deleteConversation,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- useConversation.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/ai/useConversation.ts src/renderer/src/ai/useConversation.test.ts
git commit -m "Add conversation list/switch/create/rename/delete state to useConversation"
```

---

### Task 6: Conversation sidebar UI

**Files:**
- Create: `src/renderer/src/ai/ConversationSidebar.tsx`
- Create: `src/renderer/src/ai/ConversationSidebar.test.tsx`
- Modify: `src/renderer/src/ai/AIDock.tsx`
- Modify: `src/renderer/src/ai/AIDock.test.tsx`

**Interfaces:**
- Consumes: `ConversationSummary` type and `conversations`/`activeConversationId`/`switchConversation`/`startNewConversation`/`renameConversation`/`deleteConversation` from `useConversation()` (Task 5).
- Produces: `<ConversationSidebar>` component, rendered inside `AIDock.tsx`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/ai/ConversationSidebar.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConversationSidebar } from './ConversationSidebar';

const conversations = [
  { id: 'conv-1', title: 'Homework help', updatedAt: '2026-01-01 00:00:00' },
  { id: 'conv-2', title: null, updatedAt: '2026-01-02 00:00:00' },
];

describe('ConversationSidebar', () => {
  it('lists every conversation by title, falling back to a placeholder for an unset title', () => {
    render(
      <ConversationSidebar
        conversations={conversations}
        activeConversationId="conv-1"
        onSwitch={() => {}}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
      />
    );
    expect(screen.getByText('Homework help')).toBeInTheDocument();
    expect(screen.getByText('New conversation')).toBeInTheDocument();
  });

  it('calls onSwitch when a conversation row is clicked', async () => {
    const onSwitch = vi.fn();
    render(
      <ConversationSidebar
        conversations={conversations}
        activeConversationId="conv-1"
        onSwitch={onSwitch}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
      />
    );
    await userEvent.click(screen.getByText('Homework help'));
    expect(onSwitch).toHaveBeenCalledWith('conv-1');
  });

  it('calls onNew when the New button is clicked', async () => {
    const onNew = vi.fn();
    render(
      <ConversationSidebar
        conversations={conversations}
        activeConversationId="conv-1"
        onSwitch={() => {}}
        onNew={onNew}
        onRename={() => {}}
        onDelete={() => {}}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: '+ New' }));
    expect(onNew).toHaveBeenCalled();
  });

  it('shows an inline confirm before calling onDelete', async () => {
    const onDelete = vi.fn();
    render(
      <ConversationSidebar
        conversations={conversations}
        activeConversationId="conv-1"
        onSwitch={() => {}}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={onDelete}
      />
    );
    await userEvent.click(screen.getByLabelText('Delete Homework help'));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText('Delete this conversation?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith('conv-1');
  });

  it('commits a rename on Enter', async () => {
    const onRename = vi.fn();
    render(
      <ConversationSidebar
        conversations={conversations}
        activeConversationId="conv-1"
        onSwitch={() => {}}
        onNew={() => {}}
        onRename={onRename}
        onDelete={() => {}}
      />
    );
    await userEvent.click(screen.getByLabelText('Rename Homework help'));
    const input = screen.getByDisplayValue('Homework help');
    await userEvent.clear(input);
    await userEvent.type(input, 'New Title{Enter}');
    expect(onRename).toHaveBeenCalledWith('conv-1', 'New Title');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ConversationSidebar.test.tsx`
Expected: FAIL — `./ConversationSidebar` does not exist yet.

- [ ] **Step 3: Implement `ConversationSidebar.tsx`**

Create `src/renderer/src/ai/ConversationSidebar.tsx`:

```tsx
import { useState } from 'react';
import type { ConversationSummary } from './useConversation';

export interface ConversationSidebarProps {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ConversationSidebar({
  conversations,
  activeConversationId,
  onSwitch,
  onNew,
  onRename,
  onDelete,
}: ConversationSidebarProps): React.JSX.Element {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  function startRename(id: string, currentTitle: string | null): void {
    setRenamingId(id);
    setRenameValue(currentTitle ?? '');
  }

  function commitRename(id: string): void {
    if (renameValue.trim()) onRename(id, renameValue.trim());
    setRenamingId(null);
  }

  return (
    <nav
      aria-label="Conversations"
      className="flex w-48 flex-shrink-0 flex-col overflow-auto border-r"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <button
        type="button"
        onClick={onNew}
        className="m-2 rounded-md px-2 py-1.5 text-left text-sm"
        style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
      >
        + New
      </button>
      <ul className="flex flex-1 flex-col gap-0.5 px-1 pb-2">
        {conversations.map((conversation) => (
          <li key={conversation.id}>
            <div
              className="flex items-center gap-1 rounded-md px-2 py-1.5"
              style={{
                backgroundColor: conversation.id === activeConversationId ? 'var(--color-surface)' : undefined,
              }}
            >
              {renamingId === conversation.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={() => commitRename(conversation.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitRename(conversation.id);
                    if (event.key === 'Escape') setRenamingId(null);
                  }}
                  className="min-w-0 flex-1 rounded px-1 text-sm"
                  style={{ backgroundColor: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => onSwitch(conversation.id)}
                  className="min-w-0 flex-1 truncate text-left text-sm"
                  style={{ color: 'var(--color-text)', background: 'none', border: 'none' }}
                >
                  {conversation.title ?? 'New conversation'}
                  <span className="block text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {relativeTime(conversation.updatedAt)}
                  </span>
                </button>
              )}
              <button
                type="button"
                aria-label={`Rename ${conversation.title ?? 'conversation'}`}
                onClick={() => startRename(conversation.id, conversation.title)}
                style={{ color: 'var(--color-text-muted)' }}
              >
                ✎
              </button>
              <button
                type="button"
                aria-label={`Delete ${conversation.title ?? 'conversation'}`}
                onClick={() => setConfirmingDeleteId(conversation.id)}
                style={{ color: 'var(--color-text-muted)' }}
              >
                🗑
              </button>
            </div>
            {confirmingDeleteId === conversation.id && (
              <div
                className="mx-2 mb-1 rounded-md p-2 text-xs"
                style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
              >
                <p style={{ color: 'var(--color-text)' }}>Delete this conversation?</p>
                <div className="mt-1 flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      onDelete(conversation.id);
                      setConfirmingDeleteId(null);
                    }}
                    style={{ color: '#EF4444' }}
                  >
                    Delete
                  </button>
                  <button type="button" onClick={() => setConfirmingDeleteId(null)} style={{ color: 'var(--color-text-muted)' }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ConversationSidebar.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 5: Wire the sidebar into `AIDock.tsx`**

Update `src/renderer/src/ai/AIDock.test.tsx`'s `beforeEach` mock object — add these four entries alongside the existing `ai: { ... }` mocks (after `pickAttachment`):

```ts
      createConversation: vi.fn().mockResolvedValue('conv-1'),
      listConversations: vi.fn().mockResolvedValue([]),
      renameConversation: vi.fn().mockResolvedValue(undefined),
      deleteConversation: vi.fn().mockResolvedValue(undefined),
```

Add `@testing-library/user-event` to `AIDock.test.tsx`'s top-level imports (matching `AI.test.tsx`'s existing convention, which imports it the same way):

```ts
import userEvent from '@testing-library/user-event';
```

Add one new test to `AIDock.test.tsx`'s `describe('AIDock', ...)` block:

```ts
  it('toggling the sidebar button reveals the conversation list nav', async () => {
    render(
      <MemoryRouter>
        <AIDock onClose={() => {}} />
      </MemoryRouter>
    );
    expect(screen.queryByRole('navigation', { name: /conversations/i })).toBeNull();
    await userEvent.click(screen.getByLabelText('Toggle conversation list'));
    expect(screen.getByRole('navigation', { name: /conversations/i })).toBeInTheDocument();
  });
```

Replace the entire contents of `src/renderer/src/ai/AIDock.tsx` with:

```tsx
import { useState, type FormEvent } from 'react';
import { useConversation } from './useConversation';
import { useViewContext } from './useViewContext';
import { ChatPanel } from './ChatPanel';
import { ConversationSidebar } from './ConversationSidebar';

/**
 * The assistant as a docked side panel rather than a modal overlay.
 *
 * Deliberately NOT a dialog and deliberately without a backdrop: the user is
 * meant to keep reading and clicking the page while asking about it. It also
 * must not suspend the native browser view -- a dock shrinks the viewport
 * instead of covering it, and hiding the page would defeat the whole purpose.
 */
export function AIDock({ onClose }: { onClose: () => void }): React.JSX.Element {
  const view = useViewContext();
  const conversation = useConversation(view);
  const [input, setInput] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!input.trim() || conversation.sending) return;
    conversation.sendMessage(input.trim());
    setInput('');
  }

  return (
    <aside
      aria-label="Assistant"
      className="flex w-96 flex-shrink-0 flex-col border-l"
      style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-bg)' }}
    >
      <div
        className="flex items-center justify-between border-b px-3 py-2"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSidebarOpen((prev) => !prev)}
            aria-label="Toggle conversation list"
            aria-pressed={sidebarOpen}
            className="rounded px-1.5 py-0.5 text-sm"
            style={{ color: 'var(--color-text-muted)' }}
          >
            ☰
          </button>
          <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            Assistant
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close assistant"
          className="rounded px-2 py-0.5 text-sm"
          style={{ color: 'var(--color-text-muted)' }}
        >
          ×
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <ConversationSidebar
            conversations={conversation.conversations}
            activeConversationId={conversation.activeConversationId}
            onSwitch={conversation.switchConversation}
            onNew={conversation.startNewConversation}
            onRename={conversation.renameConversation}
            onDelete={conversation.deleteConversation}
          />
        )}
        <div className="min-h-0 flex-1">
          <ChatPanel
            messages={conversation.messages}
            statusLabel={conversation.statusLabel}
            pendingConfirm={conversation.pendingConfirm}
            sending={conversation.sending}
            apiKeyConfigured={conversation.apiKeyConfigured}
            input={input}
            onInputChange={setInput}
            onSubmit={handleSubmit}
            onRespondToConfirm={conversation.respondToConfirm}
            onNavigateAway={onClose}
            attachments={conversation.attachments}
            attachError={conversation.attachError}
            onAddAttachment={conversation.addAttachment}
            onRemoveAttachment={conversation.removeAttachment}
          />
        </div>
      </div>
    </aside>
  );
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- AIDock.test.tsx`
Expected: PASS, all tests including the three pre-existing ones (`renders as a complementary region`, `does not suspend the browser view`, `has no full-screen backdrop`) and the new sidebar-toggle test.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/ai/ConversationSidebar.tsx src/renderer/src/ai/ConversationSidebar.test.tsx src/renderer/src/ai/AIDock.tsx src/renderer/src/ai/AIDock.test.tsx
git commit -m "Add collapsible conversation sidebar to the AI dock"
```

---

### Task 7: System prompt reframing

**Files:**
- Modify: `src/main/ai/viewContext.ts`
- Test: `src/main/ai/viewContext.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change — `buildSystemPrompt`'s existing signature and behavior are unchanged beyond the literal text of `BASE_PROMPT`'s first paragraph.

- [ ] **Step 1: Write the failing test**

`src/main/ai/viewContext.test.ts` already has a `describe('buildSystemPrompt', ...)` block using a `setup(assignmentName, types)` helper (not `makeDb`) and a fixed `NOW` constant, called as `buildSystemPrompt(setup(), null, NOW)`. Add this test inside that same `describe('buildSystemPrompt', ...)` block, next to the existing `'always states the current date'` test:

```ts
  it('reads as a general-purpose assistant, not scoped to app topics only', () => {
    const prompt = buildSystemPrompt(setup(), null, NOW);
    expect(prompt).toContain('general-purpose AI assistant');
    expect(prompt).toContain('you are not limited to app-related topics');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- viewContext.test.ts`
Expected: FAIL — current `BASE_PROMPT` text doesn't contain "general-purpose AI assistant".

- [ ] **Step 3: Implement**

In `src/main/ai/viewContext.ts`, replace the first string in the `BASE_PROMPT` array (currently `"You are SmartLife's built-in assistant, running inside a local macOS app that holds the user's Canvas coursework, Google Calendar, and an embedded browser. Be concise and concrete. When you use a tool, say what you found rather than narrating the call."`) with:

```ts
  "You are a general-purpose AI assistant running inside SmartLife, a local macOS app. Answer any question the user asks, the same as any capable AI assistant would — you are not limited to app-related topics. You also have deep, live context on the user's Canvas coursework, Google Calendar, and embedded browser, and tools to act on them, which you should use whenever relevant. Be concise and concrete. When you use a tool, say what you found rather than narrating the call.",
```

Every other string in the `BASE_PROMPT` array is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- viewContext.test.ts`
Expected: PASS, all tests.

Run: `npm test -- chatController.test.ts`
Expected: PASS still — its `'passes a system prompt containing the current date'` test only checks for a date pattern, unaffected by the reframed opening paragraph.

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/viewContext.ts src/main/ai/viewContext.test.ts
git commit -m "Reframe system prompt as general-purpose assistant with SmartLife context, not app-scoped"
```

---

## Final steps (after all 7 tasks are complete)

- [ ] Run the full test suite: `npm test`. Expected: all tests pass, no regressions in any file outside this plan's scope.
- [ ] Run `npm run typecheck` (or the project's equivalent — check `package.json`) to confirm the preload/renderer type changes are fully consistent.
- [ ] Update `ROADMAP.md`'s Phase 8 entry / Status section to record Phase 8c as built, following the same style as the Phase 8b entry already there.
