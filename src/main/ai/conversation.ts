import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export function getOrCreateConversationId(db: Database.Database): string {
  const existing = db.prepare('select id from ai_conversations order by created_at limit 1').get() as
    | { id: string }
    | undefined;
  if (existing) return existing.id;

  const id = randomUUID();
  db.prepare('insert into ai_conversations (id) values (?)').run(id);
  return id;
}

export function appendMessage(
  db: Database.Database,
  conversationId: string,
  role: 'user' | 'assistant',
  content: unknown[]
): void {
  db.prepare('insert into ai_messages (id, conversation_id, role, content) values (?, ?, ?, ?)').run(
    randomUUID(),
    conversationId,
    role,
    JSON.stringify(content)
  );
  db.prepare("update ai_conversations set updated_at = datetime('now') where id = ?").run(conversationId);
}

export function getMessages(db: Database.Database, conversationId: string): StoredMessage[] {
  const rows = db
    .prepare('select id, conversation_id, role, content, created_at from ai_messages where conversation_id = ? order by created_at, rowid')
    .all(conversationId) as Array<{ id: string; conversation_id: string; role: string; content: string; created_at: string }>;
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as 'user' | 'assistant',
    content: row.content,
    createdAt: row.created_at,
  }));
}

export function clearMessages(db: Database.Database, conversationId: string): void {
  db.prepare('delete from ai_messages where conversation_id = ?').run(conversationId);
}
