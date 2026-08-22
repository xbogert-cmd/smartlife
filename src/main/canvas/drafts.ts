import type Database from 'better-sqlite3';

/**
 * Local scratch for in-progress text and discussion submissions. Never synced
 * anywhere. An empty string is a real draft — the user cleared the editor —
 * and is distinct from null, which means nothing was ever saved.
 */

export function getDraft(db: Database.Database, assignmentId: number): string | null {
  const row = db
    .prepare('select body from assignment_drafts where assignment_id = ?')
    .get(assignmentId) as { body: string } | undefined;
  return row ? row.body : null;
}

export function saveDraft(
  db: Database.Database,
  assignmentId: number,
  body: string,
  now: Date = new Date()
): void {
  db.prepare(
    `insert into assignment_drafts (assignment_id, body, updated_at)
     values (?, ?, ?)
     on conflict(assignment_id) do update set body = excluded.body, updated_at = excluded.updated_at`
  ).run(assignmentId, body, now.toISOString());
}

export function clearDraft(db: Database.Database, assignmentId: number): void {
  db.prepare('delete from assignment_drafts where assignment_id = ?').run(assignmentId);
}
