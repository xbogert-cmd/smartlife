import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrate';
import { getOrCreateConversationId, appendMessage, getMessages } from '../conversation';
import { clearConversationHistoryTool } from './clearConversationHistory';

const AI_CORE_SQL = `
create table ai_conversations (
  id text primary key, title text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);
create table ai_messages (
  id text primary key,
  conversation_id text not null references ai_conversations(id) on delete cascade,
  role text not null, content text not null,
  provider text, model text, input_tokens integer, output_tokens integer,
  created_at text not null default (datetime('now'))
);
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db, [{ filename: '0002_ai_core.sql', sql: AI_CORE_SQL }]);
  return db;
}

describe('clear_conversation_history tool', () => {
  it('pauses for confirmation (CONSEQUENTIAL) and clears history on approval', async () => {
    const db = makeDb();
    const conversationId = getOrCreateConversationId(db);
    appendMessage(db, conversationId, 'user', [{ type: 'text', text: 'hi' }]);
    const requestConfirmation = vi.fn().mockResolvedValue(true);
    const result = await clearConversationHistoryTool.run({}, { db, conversationId, mode: 'assist', requestConfirmation });
    expect(requestConfirmation).toHaveBeenCalled();
    expect(result).toBe('Conversation history cleared.');
    expect(getMessages(db, conversationId)).toHaveLength(0);
  });

  it('leaves history intact when the user declines', async () => {
    const db = makeDb();
    const conversationId = getOrCreateConversationId(db);
    appendMessage(db, conversationId, 'user', [{ type: 'text', text: 'hi' }]);
    const result = await clearConversationHistoryTool.run(
      {},
      { db, conversationId, mode: 'assist', requestConfirmation: vi.fn().mockResolvedValue(false) }
    );
    expect(result).toBe('User declined this action.');
    expect(getMessages(db, conversationId)).toHaveLength(1);
  });

  it('does not request confirmation in auto mode', async () => {
    const db = makeDb();
    const conversationId = getOrCreateConversationId(db);
    appendMessage(db, conversationId, 'user', [{ type: 'text', text: 'hi' }]);
    const requestConfirmation = vi.fn();
    const result = await clearConversationHistoryTool.run({}, { db, conversationId, mode: 'auto', requestConfirmation });
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(result).toBe('Conversation history cleared.');
  });
});
