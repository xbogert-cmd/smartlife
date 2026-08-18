import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';

const INIT_SQL = `create table settings (key text primary key, value text not null);`;
const AI_CORE_SQL = `
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
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, [
    { filename: '0001_init.sql', sql: INIT_SQL },
    { filename: '0002_ai_core.sql', sql: AI_CORE_SQL },
  ]);
  return db;
}

describe('conversation helpers', () => {
  it('creates a conversation on first call and reuses it on later calls', async () => {
    const { getOrCreateConversationId } = await import('./conversation');
    const db = makeDb();
    const first = getOrCreateConversationId(db);
    const second = getOrCreateConversationId(db);
    expect(first).toBe(second);
    const count = db.prepare('select count(*) as count from ai_conversations').get() as { count: number };
    expect(count.count).toBe(1);
  });

  it('appends and retrieves messages in order', async () => {
    const { getOrCreateConversationId, appendMessage, getMessages } = await import('./conversation');
    const db = makeDb();
    const conversationId = getOrCreateConversationId(db);
    appendMessage(db, conversationId, 'user', [{ type: 'text', text: 'hello' }]);
    appendMessage(db, conversationId, 'assistant', [{ type: 'text', text: 'hi there' }]);
    const messages = getMessages(db, conversationId);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(JSON.parse(messages[0].content)).toEqual([{ type: 'text', text: 'hello' }]);
    expect(messages[1].role).toBe('assistant');
  });

  it('clears all messages for a conversation', async () => {
    const { getOrCreateConversationId, appendMessage, getMessages, clearMessages } = await import('./conversation');
    const db = makeDb();
    const conversationId = getOrCreateConversationId(db);
    appendMessage(db, conversationId, 'user', [{ type: 'text', text: 'hello' }]);
    clearMessages(db, conversationId);
    expect(getMessages(db, conversationId)).toHaveLength(0);
  });
});
