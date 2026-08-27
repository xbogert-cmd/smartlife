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

  it('breaks created_at ties by insertion order (rowid)', async () => {
    const { getOrCreateConversationId, getMessages } = await import('./conversation');
    const db = makeDb();
    const conversationId = getOrCreateConversationId(db);
    // Insert two rows with identical created_at to force a tie, deterministically
    // rather than relying on real-clock timing.
    db.prepare(
      'insert into ai_messages (id, conversation_id, role, content, created_at) values (?, ?, ?, ?, ?)'
    ).run('msg-user', conversationId, 'user', JSON.stringify([{ type: 'text', text: 'hello' }]), '2026-01-01 00:00:00');
    db.prepare(
      'insert into ai_messages (id, conversation_id, role, content, created_at) values (?, ?, ?, ?, ?)'
    ).run('msg-assistant', conversationId, 'assistant', JSON.stringify([{ type: 'text', text: 'hi there' }]), '2026-01-01 00:00:00');
    const messages = getMessages(db, conversationId);
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe('msg-user');
    expect(messages[1].id).toBe('msg-assistant');
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
