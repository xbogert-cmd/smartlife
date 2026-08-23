import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { setStoredApiKey } from './apiKey';
import type { AIProvider } from './providers/types';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
  app: { getPath: () => '/tmp/logs' },
}));

const INIT_SQL = `create table settings (key text primary key, value text not null);`;
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
  runMigrations(db, [
    { filename: '0001_init.sql', sql: INIT_SQL },
    { filename: '0002_ai_core.sql', sql: AI_CORE_SQL },
    { filename: '0003_canvas.sql', sql: CANVAS_SQL },
  ]);
  return db;
}

function fakeWindow() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return { sent, webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } };
}

describe('handleSendMessage', () => {
  it('shows a configuration prompt and never calls the provider when no API key is stored', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    const window = fakeWindow();
    const provider: AIProvider = { streamTurn: vi.fn() };
    await handleSendMessage(db, () => window as never, 'hello', null, provider);
    expect(provider.streamTurn).not.toHaveBeenCalled();
    expect(window.sent.some((s) => JSON.stringify(s.payload).includes('Settings'))).toBe(true);
  });

  it('persists the user message and the final assistant message on success', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const window = fakeWindow();
    const provider: AIProvider = { streamTurn: vi.fn().mockResolvedValue([{ type: 'text', text: 'Hi there!' }]) };
    await handleSendMessage(db, () => window as never, 'hello', null, provider);
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

  it('does not persist anything and emits an error when the provider throws', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const window = fakeWindow();
    const provider: AIProvider = { streamTurn: vi.fn().mockRejectedValue(new Error('network down')) };
    await handleSendMessage(db, () => window as never, 'hello', null, provider);
    const count = db.prepare('select count(*) as count from ai_messages').get() as { count: number };
    expect(count.count).toBe(0);
    expect(window.sent.some((s) => JSON.stringify(s.payload).includes('went wrong'))).toBe(true);
  });

  it('resolves requestConfirmation to false instead of hanging when there is no window', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    let confirmResult: boolean | undefined;
    const provider: AIProvider = {
      streamTurn: vi.fn().mockImplementation(async ({ ctx }) => {
        confirmResult = await ctx.requestConfirmation('some_tool', 'some description');
        return [{ type: 'text', text: 'done' }];
      }),
    };
    await handleSendMessage(db, () => null, 'hello', null, provider);
    expect(confirmResult).toBe(false);
  });

  it('rejects a second concurrent turn with a "still working" message instead of starting a second stream', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
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

    const firstCall = handleSendMessage(db, () => window as never, 'first', null, provider);
    // Let the first call reach and start awaiting streamTurn before firing the second.
    await Promise.resolve();
    await Promise.resolve();

    const secondCall = handleSendMessage(db, () => window as never, 'second', null, provider);
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
});

describe('system prompt', () => {
  it('passes a system prompt containing the current date to the provider', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const streamTurn = vi.fn().mockResolvedValue([{ type: 'text', text: 'ok' }]);
    await handleSendMessage(db, () => fakeWindow() as never, 'hi', null, { streamTurn });

    const system = streamTurn.mock.calls[0][0].system as string;
    expect(typeof system).toBe('string');
    expect(system.length).toBeGreaterThan(0);
    expect(system).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('folds the view context into the system prompt', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    db.prepare("insert into canvas_courses (id, name) values (1, 'Financial Accounting')").run();
    db.prepare(
      `insert into canvas_assignments (id, course_id, name, submission_types)
       values (10, 1, 'Chapter 4 Homework', '["online_text_entry"]')`
    ).run();

    const streamTurn = vi.fn().mockResolvedValue([{ type: 'text', text: 'ok' }]);
    await handleSendMessage(db, () => fakeWindow() as never, 'hi', { route: 'assignment', assignmentId: 10 }, {
      streamTurn,
    });

    expect(streamTurn.mock.calls[0][0].system).toContain('Chapter 4 Homework');
  });

  it('still works when the view context is null', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const streamTurn = vi.fn().mockResolvedValue([{ type: 'text', text: 'ok' }]);
    await expect(
      handleSendMessage(db, () => fakeWindow() as never, 'hi', null, { streamTurn })
    ).resolves.toBeUndefined();
  });
});
