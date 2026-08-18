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
}));

const INIT_SQL = `create table settings (key text primary key, value text not null);`;
const AI_CORE_SQL = `
create table ai_conversations (id text primary key, title text, created_at text not null default (datetime('now')), updated_at text not null default (datetime('now')));
create table ai_messages (id text primary key, conversation_id text not null references ai_conversations(id) on delete cascade, role text not null, content text not null, created_at text not null default (datetime('now')));
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db, [
    { filename: '0001_init.sql', sql: INIT_SQL },
    { filename: '0002_ai_core.sql', sql: AI_CORE_SQL },
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
    await handleSendMessage(db, () => window as never, 'hello', provider);
    expect(provider.streamTurn).not.toHaveBeenCalled();
    expect(window.sent.some((s) => JSON.stringify(s.payload).includes('Settings'))).toBe(true);
  });

  it('persists the user message and the final assistant message on success', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const window = fakeWindow();
    const provider: AIProvider = { streamTurn: vi.fn().mockResolvedValue([{ type: 'text', text: 'Hi there!' }]) };
    await handleSendMessage(db, () => window as never, 'hello', provider);
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
    await handleSendMessage(db, () => window as never, 'hello', provider);
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
    await handleSendMessage(db, () => null, 'hello', provider);
    expect(confirmResult).toBe(false);
  });
});
