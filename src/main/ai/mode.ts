import type Database from 'better-sqlite3';
import type { AiMode } from './permissions';

const VALID_MODES: AiMode[] = ['ask', 'assist', 'auto'];

export function getAiMode(db: Database.Database): AiMode {
  const row = db.prepare('select value from settings where key = ?').get('ai_mode') as { value: string } | undefined;
  if (row && VALID_MODES.includes(row.value as AiMode)) {
    return row.value as AiMode;
  }
  return 'ask';
}

export function setAiMode(db: Database.Database, mode: AiMode): void {
  db.prepare(
    'insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
  ).run('ai_mode', mode);
}
