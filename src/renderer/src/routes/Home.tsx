import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHome } from '../home/useHome';
import { buildToday } from '../home/timeline';
import { TodayPanel } from '../home/TodayPanel';
import { NeedsAttention } from '../home/NeedsAttention';
import { DueSoon } from '../school/DueSoon';
import { GradeStrip } from '../school/GradeStrip';
import { TokenBanner } from '../school/TokenBanner';
import { formatRelative } from '../school/formatters';

export function greeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function formatToday(date: Date): string {
  return `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

export function Home(): React.JSX.Element {
  const home = useHome();
  const navigate = useNavigate();

  const canvasConnected =
    home.canvasStatus !== null &&
    home.canvasStatus.tokenConfigured &&
    home.canvasStatus.baseUrlConfigured;
  const calendarConnected = home.calendarStatus !== null && home.calendarStatus.connected;

  const today = useMemo(
    () => buildToday(home.events, home.upcoming, new Date()),
    [home.events, home.upcoming]
  );

  const now = new Date();
  const heading = `${greeting(now.getHours())}`;

  // Loading and fully-disconnected render the same prompt, so there is no
  // flash of an empty dashboard before the two statuses resolve.
  if (!home.loaded || (!canvasConnected && !calendarConnected)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--color-text)' }}>
          {heading}
        </h1>
        <p style={{ color: 'var(--color-text-muted)' }}>
          Connect Canvas or Google Calendar to see your day here.
        </p>
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="rounded-md px-4 py-2 text-sm"
          style={{
            backgroundColor: 'var(--color-text)',
            color: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
          }}
        >
          Go to Settings
        </button>
      </div>
    );
  }

  const lastSynced = home.canvasStatus?.lastSyncedAt ?? home.calendarStatus?.lastSyncedAt ?? null;

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col">
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--color-text)' }}>
            {heading}
          </h1>
          <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            {formatToday(now)} · synced {formatRelative(lastSynced)}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void home.refresh()}
          disabled={home.refreshing}
          className="rounded-md px-3 py-1.5 text-sm"
          style={{
            backgroundColor: 'var(--color-surface)',
            color: 'var(--color-text)',
            border: '1px solid var(--color-border)',
          }}
        >
          {home.refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {home.canvasStatus && <TokenBanner status={home.canvasStatus} />}
      <NeedsAttention items={home.overdue} />
      <TodayPanel items={today} />

      {canvasConnected && (
        <>
          <DueSoon items={home.upcoming} title="Next 7 days" emptyText="Nothing due in the next week." />
          <GradeStrip courses={home.grades} />
          <section className="flex flex-col gap-2">
            <h2
              className="text-sm font-semibold uppercase tracking-wide"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Announcements
            </h2>
            {home.announcements.length === 0 ? (
              <p style={{ color: 'var(--color-text-muted)' }}>No recent announcements.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {home.announcements.map((announcement) => (
                  <li
                    key={announcement.id}
                    className="flex items-baseline justify-between gap-3 rounded-lg px-3 py-2"
                    style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
                  >
                    <span className="truncate" style={{ color: 'var(--color-text)' }}>
                      {announcement.title ?? 'Untitled'}
                    </span>
                    <span className="flex-shrink-0 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      {announcement.courseName} · {formatRelative(announcement.postedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {!canvasConnected && (
        <p style={{ color: 'var(--color-text-muted)' }}>
          Connect Canvas in Settings to see assignments, grades, and announcements.
        </p>
      )}
      {!calendarConnected && (
        <p style={{ color: 'var(--color-text-muted)' }}>
          Connect Google Calendar in Settings to see today&apos;s events.
        </p>
      )}
    </div>
  );
}
