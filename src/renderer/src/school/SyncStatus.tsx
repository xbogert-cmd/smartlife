import { formatRelative } from './formatters';
import type { CanvasSyncStatus } from './types';

export function SyncStatus({
  status,
  syncing,
  onRefresh,
}: {
  status: CanvasSyncStatus;
  syncing: boolean;
  onRefresh: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span style={{ color: 'var(--color-text-muted)' }}>
        Synced {formatRelative(status.lastSyncedAt)}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={syncing}
        className="rounded-md px-2.5 py-1 text-xs"
        style={{
          backgroundColor: 'var(--color-surface)',
          color: 'var(--color-text)',
          border: '1px solid var(--color-border)',
          opacity: syncing ? 0.6 : 1,
        }}
      >
        {syncing ? 'Syncing…' : 'Refresh'}
      </button>
    </div>
  );
}
