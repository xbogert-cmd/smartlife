import { Link } from 'react-router-dom';
import { formatClockTime, formatEventTime } from '../calendar/formatters';
import { CALENDAR_ACCENT } from '../calendar/types';
import { SCHOOL_ACCENT } from '../school/types';
import { Panel, PanelRow } from '../ui/Panel';
import type { TodayItem } from './timeline';

function timeLabel(item: TodayItem): string {
  if (item.kind === 'event') return formatEventTime(item.event);
  return formatClockTime(new Date(item.at));
}

function Row({ item }: { item: TodayItem }): React.JSX.Element {
  const accent = item.kind === 'event' ? CALENDAR_ACCENT : SCHOOL_ACCENT;
  const title = item.kind === 'event' ? (item.event.summary ?? 'Untitled event') : item.assignment.name;
  const detail = item.kind === 'event' ? item.event.location : item.assignment.courseName;

  const body = (
    <>
      <span aria-hidden="true" className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ backgroundColor: accent }} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span style={{ color: 'var(--color-text)' }}>{title}</span>
        {detail && (
          <span className="truncate text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {detail}
          </span>
        )}
      </div>
      <span className="ml-auto flex-shrink-0 text-xs" style={{ color: 'var(--color-text-muted)' }}>
        {item.kind === 'due' && item.assignment.hasSubmitted ? 'submitted' : timeLabel(item)}
      </span>
    </>
  );

  const className = 'flex min-w-0 flex-1 items-center gap-3';

  // Only due items have somewhere to go. An event's own surface is the
  // calendar week grid, which has no per-event route.
  return item.kind === 'due' ? (
    <Link to={`/assignment/${item.assignment.id}`} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

export function TodayPanel({ items }: { items: TodayItem[] }): React.JSX.Element {
  return (
    <Panel title="Today">
      {items.length === 0 ? (
        <PanelRow>
          <span style={{ color: 'var(--color-text-muted)' }}>Nothing scheduled today.</span>
        </PanelRow>
      ) : (
        items.map((item) => (
          <PanelRow key={item.kind === 'event' ? `e${item.event.calendarId}:${item.event.id}` : `a${item.assignment.id}`}>
            <Row item={item} />
          </PanelRow>
        ))
      )}
    </Panel>
  );
}
