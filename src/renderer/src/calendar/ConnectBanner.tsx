import { useNavigate } from 'react-router-dom';
import type { CalendarStatus } from './types';

export function ConnectBanner({ status }: { status: CalendarStatus }): React.JSX.Element | null {
  const navigate = useNavigate();
  if (!status.tokenInvalid) return null;

  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm"
      style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
    >
      <span style={{ color: 'var(--color-text)' }}>
        Google Calendar access expired. Events below are the last synced copy — reconnect to bring
        them up to date.
      </span>
      <button
        type="button"
        onClick={() => navigate('/settings')}
        className="shrink-0 rounded-md px-2.5 py-1 text-xs"
        style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)' }}
      >
        Reconnect
      </button>
    </div>
  );
}
