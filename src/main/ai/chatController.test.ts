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
create table ai_messages (id text primary key, conversation_id text not null references ai_conversations(id) on delete cascade, role text not null, content text not null, provider text, model text, input_tokens integer, output_tokens integer, created_at text not null default (datetime('now')));
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
    const provider: AIProvider = {
      streamTurn: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Hi there!' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        providerId: 'anthropic',
        model: 'claude-sonnet-5',
      }),
    };
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
    const provider: AIProvider = {
      streamTurn: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        providerId: 'anthropic',
        model: 'claude-sonnet-5',
      }),
    };
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
        return {
          content: [{ type: 'text', text: 'done' }],
          usage: { inputTokens: 1, outputTokens: 1 },
          providerId: 'anthropic',
          model: 'claude-sonnet-5',
        };
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
        return {
          content: [{ type: 'text', text: 'done' }],
          usage: { inputTokens: 1, outputTokens: 1 },
          providerId: 'anthropic',
          model: 'claude-sonnet-5',
        };
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
        return {
          content: [{ type: 'text', text: 'done' }],
          usage: { inputTokens: 1, outputTokens: 1 },
          providerId: 'anthropic',
          model: 'claude-sonnet-5',
        };
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

  it('tags every emitted stream event with the conversation id', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const conversationId = await makeConversation(db);
    const window = fakeWindow();
    const provider: AIProvider = {
      streamTurn: vi.fn().mockImplementation(async ({ onEvent }) => {
        onEvent({ type: 'text-delta', text: 'ok' });
        onEvent({ type: 'turn-complete' });
        return {
          content: [{ type: 'text', text: 'ok' }],
          usage: { inputTokens: 1, outputTokens: 1 },
          providerId: 'anthropic',
          model: 'claude-sonnet-5',
        };
      }),
    };
    await handleSendMessage(db, () => window as never, 'hi', null, conversationId, { provider });

    const streamEvents = window.sent.filter((s) => s.channel === 'ai:stream-event');
    expect(streamEvents.length).toBeGreaterThan(0);
    for (const event of streamEvents) {
      expect((event.payload as { conversationId: string }).conversationId).toBe(conversationId);
    }
  });

  it('persists the serving provider/model and token usage onto the assistant message row', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const conversationId = await makeConversation(db);
    const window = fakeWindow();
    const provider: AIProvider = {
      streamTurn: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        usage: { inputTokens: 42, outputTokens: 17 },
        providerId: 'gemini',
        model: 'gemini-2.5-pro',
      }),
    };
    await handleSendMessage(db, () => window as never, 'hi', null, conversationId, { provider });

    const row = db
      .prepare('select provider, model, input_tokens, output_tokens from ai_messages where role = ?')
      .get('assistant') as { provider: string; model: string; input_tokens: number; output_tokens: number };
    expect(row).toEqual({ provider: 'gemini', model: 'gemini-2.5-pro', input_tokens: 42, output_tokens: 17 });
  });
});

describe('system prompt', () => {
  it('passes a system prompt containing the current date to the provider', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const conversationId = await makeConversation(db);
    const streamTurn = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { inputTokens: 1, outputTokens: 1 },
      providerId: 'anthropic',
      model: 'claude-sonnet-5',
    });
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

    const streamTurn = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { inputTokens: 1, outputTokens: 1 },
      providerId: 'anthropic',
      model: 'claude-sonnet-5',
    });
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
    const streamTurn = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { inputTokens: 1, outputTokens: 1 },
      providerId: 'anthropic',
      model: 'claude-sonnet-5',
    });
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
    const streamTurn = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { inputTokens: 1, outputTokens: 1 },
      providerId: 'anthropic',
      model: 'claude-sonnet-5',
    });
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
    const streamTurn = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { inputTokens: 1, outputTokens: 1 },
      providerId: 'anthropic',
      model: 'claude-sonnet-5',
    });
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
    const streamTurn = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { inputTokens: 1, outputTokens: 1 },
      providerId: 'anthropic',
      model: 'claude-sonnet-5',
    });
    await handleSendMessage(db, () => fakeWindow() as never, 'hi', null, conversationId, { provider: { streamTurn } });
    expect(streamTurn.mock.calls[0][0].attachments).toBeUndefined();
  });
});
