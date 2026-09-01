import { Link } from 'react-router-dom';
import { formatDue, overdueSeverity } from '../school/formatters';
import { type UpcomingAssignment } from '../school/types';
import { Panel, PanelRow } from '../ui/Panel';

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
    <Panel title="Needs attention">
      {items.map((item) => {
        const severity = overdueSeverity(item.dueAt);
        const color = severity === 'critical' ? 'var(--color-danger)' : 'var(--color-warning)';
        return (
          <PanelRow key={item.id}>
            <Link to={`/assignment/${item.id}`} data-severity={severity} className="flex w-full min-w-0 items-center gap-3 px-4 py-2.5">
              <span aria-hidden="true" className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span style={{ color: 'var(--color-text)' }}>{item.name}</span>
                <span className="truncate text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {item.courseName}
                </span>
              </div>
              <span className="ml-3 flex-shrink-0 text-xs font-medium" style={{ color }}>
                {formatDue(item.dueAt)}
              </span>
            </Link>
          </PanelRow>
        );
      })}
    </Panel>
  );
}
