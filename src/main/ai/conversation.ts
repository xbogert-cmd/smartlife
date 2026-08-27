import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CATALOG } from './providers/catalog';

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

export function appendMessage(
  db: Database.Database,
  conversationId: string,
  role: 'user' | 'assistant',
  content: unknown[],
  meta?: { providerId: string; model: string; inputTokens: number; outputTokens: number }
): void {
  db.prepare(
    'insert into ai_messages (id, conversation_id, role, content, provider, model, input_tokens, output_tokens) values (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    randomUUID(),
    conversationId,
    role,
    JSON.stringify(content),
    meta?.providerId ?? null,
    meta?.model ?? null,
    meta?.inputTokens ?? null,
    meta?.outputTokens ?? null
  );
  db.prepare("update ai_conversations set updated_at = datetime('now') where id = ?").run(conversationId);
}

export interface UsageRow {
  providerId: string;
  model: string;
  displayName: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export function getUsageSummary(db: Database.Database): UsageRow[] {
  const rows = db
    .prepare(
      `select provider, model,
         coalesce(sum(input_tokens), 0) as input_tokens,
         coalesce(sum(output_tokens), 0) as output_tokens
       from ai_messages
       where provider is not null
       group by provider, model
       order by provider, model`
    )
    .all() as Array<{ provider: string; model: string; input_tokens: number; output_tokens: number }>;

  return rows.map((row) => {
    const catalogEntry = CATALOG.find((entry) => entry.providerId === row.provider && entry.model === row.model);
    const inputPrice = catalogEntry?.inputPricePerMTok ?? 0;
    const outputPrice = catalogEntry?.outputPricePerMTok ?? 0;
    const estimatedCostUsd =
      (row.input_tokens / 1_000_000) * inputPrice + (row.output_tokens / 1_000_000) * outputPrice;
    return {
      providerId: row.provider,
      model: row.model,
      displayName: catalogEntry?.displayName ?? row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      estimatedCostUsd,
    };
  });
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
