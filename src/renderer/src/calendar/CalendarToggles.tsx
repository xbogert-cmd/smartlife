import type { CalendarRow } from './types';

export function CalendarToggles({
  calendars,
  onToggle,
}: {
  calendars: CalendarRow[];
  onToggle: (calendarId: string, enabled: boolean) => void;
}): React.JSX.Element {
  if (calendars.length === 0) {
    return <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No calendars synced yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-1">
      {calendars.map((row) => (
        <li key={row.id}>
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--color-text)' }}>
            <input
              type="checkbox"
              checked={row.enabled}
              onChange={(e) => onToggle(row.id, e.target.checked)}
            />
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: row.backgroundColor ?? 'var(--color-border)' }}
            />
            {row.summary}
          </label>
        </li>
      ))}
    </ul>
  );
}
