import { formatDue } from './formatters';
import { SCHOOL_ACCENT, type UpcomingAssignment } from './types';

export function DueSoon({ items }: { items: UpcomingAssignment[] }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
        Due soon
      </h2>
      {items.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>Nothing due in the next two weeks.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between rounded-lg px-3 py-2"
              style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
            >
              <div className="flex flex-col">
                <span style={{ color: 'var(--color-text)' }}>{item.name}</span>
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {item.courseName}
                </span>
              </div>
              <span
                className="text-xs"
                style={{ color: item.hasSubmitted ? 'var(--color-text-muted)' : SCHOOL_ACCENT }}
              >
                {item.hasSubmitted ? 'submitted' : formatDue(item.dueAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
