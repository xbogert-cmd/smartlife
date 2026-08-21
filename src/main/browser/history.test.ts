import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { clearHistory, findHistory, historyCutoff, pruneHistory, recordVisit } from './history';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    create table browser_history (
      url text not null,
      title text,
      visited_at text not null default (datetime('now'))
    );
    create index browser_history_visited_idx on browser_history(visited_at desc);
    create index browser_history_url_idx on browser_history(url);
  `);
  return db;
}

function seed(db: Database.Database, url: string, title: string | null, visitedAt: string): void {
  db.prepare('insert into browser_history (url, title, visited_at) values (?, ?, ?)').run(url, title, visitedAt);
}

describe('recordVisit', () => {
  it('stores the url and title', () => {
    const db = makeDb();
    recordVisit(db, 'https://uncw.edu/registrar', 'Registrar');
    const rows = db.prepare('select url, title from browser_history').all() as { url: string; title: string }[];
    expect(rows).toEqual([{ url: 'https://uncw.edu/registrar', title: 'Registrar' }]);
  });

  it('accepts a null title', () => {
    const db = makeDb();
    recordVisit(db, 'https://example.com', null);
    const row = db.prepare('select title from browser_history').get() as { title: string | null };
    expect(row.title).toBeNull();
  });
});

describe('findHistory', () => {
  it('matches on url and on title, newest first', () => {
    const db = makeDb();
    seed(db, 'https://uncw.edu/a', 'Older page', '2026-08-01 10:00:00');
    seed(db, 'https://example.com/b', 'UNCW mention', '2026-08-02 10:00:00');
    seed(db, 'https://unrelated.test/c', 'Nothing', '2026-08-03 10:00:00');

    const results = findHistory(db, 'uncw');

    expect(results.map((entry) => entry.url)).toEqual([
      'https://example.com/b',
      'https://uncw.edu/a',
    ]);
  });

  it('returns nothing for an empty prefix', () => {
    const db = makeDb();
    seed(db, 'https://uncw.edu/a', 'A', '2026-08-01 10:00:00');
    expect(findHistory(db, '   ')).toEqual([]);
  });

  it('honours the limit', () => {
    const db = makeDb();
    seed(db, 'https://uncw.edu/a', 'A', '2026-08-01 10:00:00');
    seed(db, 'https://uncw.edu/b', 'B', '2026-08-02 10:00:00');
    seed(db, 'https://uncw.edu/c', 'C', '2026-08-03 10:00:00');
    expect(findHistory(db, 'uncw', 2)).toHaveLength(2);
  });

  it('treats % as a literal character, not a wildcard', () => {
    const db = makeDb();
    seed(db, 'https://example.com/100%', 'Full marks', '2026-08-01 10:00:00');
    seed(db, 'https://other.test/', 'Other', '2026-08-02 10:00:00');
    expect(findHistory(db, '100%').map((entry) => entry.url)).toEqual(['https://example.com/100%']);
  });
});

describe('historyCutoff', () => {
  it('subtracts the given number of days and formats as a SQLite datetime', () => {
    expect(historyCutoff(90, new Date('2026-08-21T12:34:56Z'))).toBe('2026-05-23 12:34:56');
  });
});

describe('pruneHistory', () => {
  it('deletes rows strictly older than the cutoff and keeps the boundary row', () => {
    const db = makeDb();
    seed(db, 'https://too-old.test/', 'Old', '2026-05-22 23:59:59');
    seed(db, 'https://exactly-at.test/', 'Boundary', '2026-05-23 12:34:56');
    seed(db, 'https://recent.test/', 'Recent', '2026-08-20 09:00:00');

    const deleted = pruneHistory(db, '2026-05-23 12:34:56');

    expect(deleted).toBe(1);
    const remaining = db.prepare('select url from browser_history order by url').all() as { url: string }[];
    expect(remaining.map((row) => row.url)).toEqual([
      'https://exactly-at.test/',
      'https://recent.test/',
    ]);
  });
});

describe('clearHistory', () => {
  it('removes every row', () => {
    const db = makeDb();
    seed(db, 'https://a.test/', 'A', '2026-08-01 10:00:00');
    seed(db, 'https://b.test/', 'B', '2026-08-02 10:00:00');
    clearHistory(db);
    const count = db.prepare('select count(*) as n from browser_history').get() as { n: number };
    expect(count.n).toBe(0);
  });
});
