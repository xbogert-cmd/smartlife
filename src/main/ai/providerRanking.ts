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

/**
 * Called right after a provider's credentials are saved. Chat is gated on
 * the ranked list, not on credentials alone (see hasUsableProvider in
 * router.ts) -- without this, "I added my API key" doesn't actually unlock
 * chat until the user separately visits the ranked-list builder elsewhere
 * in Settings, a second, easy-to-miss step. Only fires when the list is
 * currently empty; a user who has already built a real ranked list never
 * gets a silent, unrequested entry added underneath it.
 */
export function seedRankingIfEmpty(db: Database.Database, entry: RankingEntry): void {
  if (getRanking(db).length > 0) return;
  setRanking(db, [entry]);
}
