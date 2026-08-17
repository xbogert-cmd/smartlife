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
});
