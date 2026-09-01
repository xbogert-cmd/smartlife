const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function formatRelative(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return 'never';
  const elapsed = now.getTime() - Date.parse(iso);
  if (Number.isNaN(elapsed)) return 'never';
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} hr ago`;
  const days = Math.floor(elapsed / DAY);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

export function formatDue(iso: string, now: Date = new Date()): string {
  const remaining = Date.parse(iso) - now.getTime();
  if (Number.isNaN(remaining)) return '';
  if (remaining < 0) {
    const elapsed = -remaining;
    if (elapsed < HOUR) return `${Math.max(1, Math.floor(elapsed / MINUTE))} min overdue`;
    if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} hr overdue`;
    const overdueDays = Math.floor(elapsed / DAY);
    return overdueDays === 1 ? '1 day overdue' : `${overdueDays} days overdue`;
  }
  if (remaining < HOUR) return `due in ${Math.max(1, Math.floor(remaining / MINUTE))} min`;
  if (remaining < DAY) return `due in ${Math.floor(remaining / HOUR)} hr`;
  const days = Math.floor(remaining / DAY);
  return days === 1 ? 'due in 1 day' : `due in ${days} days`;
}

/** Only meaningful for something already overdue -- callers that only ever
 *  pass past-due items (NeedsAttention.tsx) don't need to check first, but
 *  passing a not-yet-due dueAt here isn't guarded against, since a negative
 *  `elapsed` is just always < 2 * DAY and reads as 'critical', which is
 *  harmless for a caller that would never show it in the first place. */
export function overdueSeverity(dueAt: string, now: Date = new Date()): 'critical' | 'moderate' {
  const elapsed = now.getTime() - Date.parse(dueAt);
  return elapsed < 2 * DAY ? 'critical' : 'moderate';
}
