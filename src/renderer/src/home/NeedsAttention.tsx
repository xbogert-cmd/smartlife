import { Link } from 'react-router-dom';
import { formatDue } from '../school/formatters';
import { SCHOOL_ACCENT, type UpcomingAssignment } from '../school/types';

/**
 * Past-due, unsubmitted work.
 *
 * Renders nothing when empty rather than an empty state: a permanent
 * "nothing overdue" row is a daily false alarm the user learns to skip past,
 * which is exactly the wrong reflex to train for this section.
 */
export function NeedsAttention({ items }: { items: UpcomingAssignment[] }): React.JSX.Element | null {
  if (items.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: SCHOOL_ACCENT }}>
        Needs attention
      </h2>
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              to={`/assignment/${item.id}`}
              className="flex items-center justify-between rounded-lg px-3 py-2"
              style={{ backgroundColor: 'var(--color-surface)', border: `1px solid ${SCHOOL_ACCENT}` }}
            >
              <div className="flex min-w-0 flex-col">
                <span style={{ color: 'var(--color-text)' }}>{item.name}</span>
                <span className="truncate text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {item.courseName}
                </span>
              </div>
              <span className="ml-3 flex-shrink-0 text-xs" style={{ color: SCHOOL_ACCENT }}>
                {formatDue(item.dueAt)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
