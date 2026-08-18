import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testUserDataDir = join(tmpdir(), `smartlife-test-${Date.now()}`);

vi.mock('electron', () => ({
  app: { getPath: () => testUserDataDir },
}));

afterEach(() => {
  rmSync(testUserDataDir, { recursive: true, force: true });
});

describe('openDb', () => {
  it('creates the database file and applies migrations', async () => {
    const { openDb } = await import('./index');
    const db = openDb();

    expect(existsSync(join(testUserDataDir, 'smartlife.db'))).toBe(true);

    const tables = db
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toContain('settings');

    db.close();
  });

  it('enforces foreign key constraints with cascade delete', async () => {
    const { openDb } = await import('./index');
    const db = openDb();

    // Insert a conversation
    const conversationId = 'conv-123';
    db.prepare('insert into ai_conversations (id, title) values (?, ?)')
      .run(conversationId, 'Test Conversation');

    // Insert a message referencing the conversation
    const messageId = 'msg-456';
    db.prepare('insert into ai_messages (id, conversation_id, role, content) values (?, ?, ?, ?)')
      .run(messageId, conversationId, 'user', 'Hello');

    // Verify the message exists
    let messageCount = (db.prepare('select count(*) as count from ai_messages').get() as { count: number }).count;
    expect(messageCount).toBe(1);

    // Delete the conversation (should cascade delete the message)
    db.prepare('delete from ai_conversations where id = ?')
      .run(conversationId);

    // Verify the message was cascade-deleted
    messageCount = (db.prepare('select count(*) as count from ai_messages').get() as { count: number }).count;
    expect(messageCount).toBe(0);

    db.close();
  });
});
