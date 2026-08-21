import type Database from 'better-sqlite3';

export interface HistoryEntry {
  url: string;
  title: string | null;
  visitedAt: string;
}

const DEFAULT_PRUNE_DAYS = 90;
const DEFAULT_SUGGESTION_LIMIT = 8;

export function recordVisit(db: Database.Database, url: string, title: string | null): void {
  db.prepare('insert into browser_history (url, title) values (?, ?)').run(url, title);
}

/**
 * Address-bar suggestions. The prefix comes straight from a text input, so
 * LIKE's own wildcards are escaped -- otherwise typing "100%" would match
 * every row instead of the one the user means.
 */
export function findHistory(
  db: Database.Database,
  prefix: string,
  limit: number = DEFAULT_SUGGESTION_LIMIT
): HistoryEntry[] {
  const trimmed = prefix.trim();
  if (trimmed.length === 0) return [];
  const escaped = trimmed.replace(/[\\%_]/g, (char) => `\\${char}`);
  const pattern = `%${escaped}%`;
  return db
    .prepare(
      `select url, title, visited_at as visitedAt
         from browser_history
        where url like ? escape '\\' or title like ? escape '\\'
        order by visited_at desc
        limit ?`
    )
    .all(pattern, pattern, limit) as HistoryEntry[];
}

/** SQLite-comparable datetime string for "N days before `now`". */
export function historyCutoff(days: number = DEFAULT_PRUNE_DAYS, now: Date = new Date()): string {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return cutoff.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Strictly older than the cutoff. The caller supplies the cutoff rather than a
 * day count so the boundary is a deterministic assertion in tests instead of
 * something that depends on when the test happens to run.
 */
export function pruneHistory(db: Database.Database, cutoffIso: string): number {
  return db.prepare('delete from browser_history where visited_at < ?').run(cutoffIso).changes;
}

export function clearHistory(db: Database.Database): void {
  db.prepare('delete from browser_history').run();
}
