import { useNavigate } from 'react-router-dom';
import { useCanvas } from '../school/useCanvas';
import { DueSoon } from '../school/DueSoon';
import { GradeStrip } from '../school/GradeStrip';
import { SyncStatus } from '../school/SyncStatus';
import { TokenBanner } from '../school/TokenBanner';
import { sanitizeHtml } from '../school/sanitizeHtml';
import { formatRelative } from '../school/formatters';

export function School(): React.JSX.Element {
  const { status, upcoming, grades, announcements, syncing, refresh } = useCanvas();
  const navigate = useNavigate();

  // null (loading) and an unconfigured connection render the same prompt, so
  // there is no flash of an empty dashboard before the status resolves.
  const connected = status !== null && status.tokenConfigured && status.baseUrlConfigured;

  if (!connected) {
    return (
      <div className="flex flex-col items-start gap-4 p-8">
        <h1 className="text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
          School
        </h1>
        <p style={{ color: 'var(--color-text-muted)' }}>
          Connect Canvas to see what is due, your current grades, and your course materials.
        </p>
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="rounded-md px-3 py-1.5 text-sm"
          style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
        >
          Go to Settings
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
          School
        </h1>
        <SyncStatus status={status} syncing={syncing} onRefresh={() => void refresh()} />
      </div>

      <TokenBanner status={status} />
      <DueSoon items={upcoming} />
      <GradeStrip courses={grades} />

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
          Announcements
        </h2>
        {announcements.length === 0 ? (
          <p style={{ color: 'var(--color-text-muted)' }}>No recent announcements.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {announcements.map((announcement) => (
              <li
                key={announcement.id}
                className="rounded-lg px-3 py-2"
                style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span style={{ color: 'var(--color-text)' }}>{announcement.title ?? 'Untitled'}</span>
                  <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {announcement.courseName} · {formatRelative(announcement.postedAt)}
                  </span>
                </div>
                {announcement.message && (
                  <div
                    className="mt-1 text-sm"
                    style={{ color: 'var(--color-text-muted)' }}
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(announcement.message) }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
