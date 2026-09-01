import { formatDue } from './formatters';
import { SCHOOL_ACCENT, type UpcomingAssignment } from './types';
import { Panel, PanelRow } from '../ui/Panel';

export function DueSoon({
  items,
  title = 'Due soon',
  emptyText = 'Nothing due in the next two weeks.',
}: {
  items: UpcomingAssignment[];
  title?: string;
  emptyText?: string;
}): React.JSX.Element {
  return (
    <Panel title={title}>
      {items.length === 0 ? (
        <PanelRow>
          <span className="block px-4 py-2.5" style={{ color: 'var(--color-text-muted)' }}>
            {emptyText}
          </span>
        </PanelRow>
      ) : (
        items.map((item) => (
          <PanelRow key={item.id}>
            <div className="flex w-full min-w-0 items-center justify-between gap-3 px-4 py-2.5">
              <div className="flex min-w-0 flex-col">
                <span style={{ color: 'var(--color-text)' }}>{item.name}</span>
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {item.courseName}
                </span>
              </div>
              <span className="flex-shrink-0 text-xs" style={{ color: item.hasSubmitted ? 'var(--color-text-muted)' : SCHOOL_ACCENT }}>
                {item.hasSubmitted ? 'submitted' : formatDue(item.dueAt)}
              </span>
            </div>
          </PanelRow>
        ))
      )}
    </Panel>
  );
}
