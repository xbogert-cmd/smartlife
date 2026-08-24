import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getRanking, setRanking } from './providerRanking';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(
    `create table ai_provider_ranking (
      rank integer primary key,
      provider text not null,
      model text not null
    );`
  );
  return db;
}

describe('provider ranking', () => {
  it('returns an empty list when nothing is configured', () => {
    const db = makeDb();
    expect(getRanking(db)).toEqual([]);
  });

  it('stores and returns entries in rank order', () => {
    const db = makeDb();
    setRanking(db, [
      { providerId: 'anthropic', model: 'claude-sonnet-5' },
      { providerId: 'gemini', model: 'gemini-2.5-flash' },
      { providerId: 'ollama', model: 'llama3.1' },
    ]);
    expect(getRanking(db)).toEqual([
      { providerId: 'anthropic', model: 'claude-sonnet-5' },
      { providerId: 'gemini', model: 'gemini-2.5-flash' },
      { providerId: 'ollama', model: 'llama3.1' },
    ]);
  });

  it('replaces the whole list, not just appending, on a second call', () => {
    const db = makeDb();
    setRanking(db, [{ providerId: 'anthropic', model: 'claude-opus-5' }]);
    setRanking(db, [{ providerId: 'gemini', model: 'gemini-2.5-pro' }]);
    expect(getRanking(db)).toEqual([{ providerId: 'gemini', model: 'gemini-2.5-pro' }]);
  });

  it('re-sequences ranks 0..n-1 to reflect reordering, regardless of insertion order passed in', () => {
    const db = makeDb();
    setRanking(db, [
      { providerId: 'gemini', model: 'gemini-2.5-flash' },
      { providerId: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    ]);
    const rows = db.prepare('select rank, provider from ai_provider_ranking order by rank').all() as Array<{
      rank: number;
      provider: string;
    }>;
    expect(rows).toEqual([
      { rank: 0, provider: 'gemini' },
      { rank: 1, provider: 'anthropic' },
    ]);
  });
});
