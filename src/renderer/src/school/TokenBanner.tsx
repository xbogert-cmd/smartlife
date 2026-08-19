import type { CanvasSyncStatus } from './types';

export function TokenBanner({ status }: { status: CanvasSyncStatus }): React.JSX.Element | null {
  if (status.tokenInvalid) {
    return (
      <div
        className="rounded-lg px-4 py-3 text-sm"
        style={{ backgroundColor: 'var(--color-surface)', border: '1px solid #F87171', color: 'var(--color-text)' }}
      >
        <strong>Your Canvas token has expired.</strong> Showing the last data that synced. Generate a
        new token in Canvas under Account → Settings → Approved Integrations, then paste it into
        Settings.
      </div>
    );
  }

  if (status.tokenExpiringSoon) {
    return (
      <div
        className="rounded-lg px-4 py-3 text-sm"
        style={{ backgroundColor: 'var(--color-surface)', border: '1px solid #FBBF24', color: 'var(--color-text)' }}
      >
        Your Canvas token is {status.tokenAgeDays} days old and expires at 90. Generate a
        replacement before it lapses.
      </div>
    );
  }

  return null;
}
