import type Database from 'better-sqlite3';
import type { ProviderId } from './providers/types';

export interface RankingEntry {
  providerId: ProviderId;
  model: string;
}

const VALID_PROVIDER_IDS: ProviderId[] = ['anthropic', 'gemini', 'ollama'];

interface Row {
  rank: number;
  provider: string;
  model: string;
}

export function getRanking(db: Database.Database): RankingEntry[] {
  const rows = db.prepare('select rank, provider, model from ai_provider_ranking order by rank').all() as Row[];
  return rows
    .filter((row) => VALID_PROVIDER_IDS.includes(row.provider as ProviderId))
    .map((row) => ({ providerId: row.provider as ProviderId, model: row.model }));
}

/**
 * Replaces the whole ranked list in one transaction, in the order given.
 * The table is small (a handful of rows at most) and rewritten wholesale on
 * every add/remove/reorder in Settings -- simpler and safer than patching
 * individual rank values, and there is no concurrent writer to race with.
 */
export function setRanking(db: Database.Database, entries: RankingEntry[]): void {
  const replace = db.transaction((list: RankingEntry[]) => {
    db.prepare('delete from ai_provider_ranking').run();
    const insert = db.prepare('insert into ai_provider_ranking (rank, provider, model) values (?, ?, ?)');
    list.forEach((entry, index) => {
      insert.run(index, entry.providerId, entry.model);
    });
  });
  replace(entries);
}
