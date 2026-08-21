import type { BrowserTab } from './types';

export function TabStrip({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onNewTab,
}: {
  tabs: BrowserTab[];
  activeTabId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1" role="tablist" aria-label="Open tabs">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const label = tab.loading && tab.title.length === 0 ? 'Loading…' : tab.title;
        return (
          <div key={tab.id} className="flex min-w-0 items-center">
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onActivate(tab.id)}
              title={tab.url}
              className="max-w-40 truncate rounded-t px-3 py-1.5 text-xs"
              style={{
                color: 'var(--color-text)',
                backgroundColor: isActive ? 'var(--color-surface)' : 'transparent',
                borderBottom: isActive ? '2px solid #2DD4BF' : '2px solid transparent',
              }}
            >
              {label}
            </button>
            <button
              type="button"
              aria-label={`Close ${label}`}
              onClick={() => onClose(tab.id)}
              className="rounded px-1 text-xs"
              style={{ color: 'var(--color-text-muted)' }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        aria-label="New tab"
        onClick={onNewTab}
        className="rounded px-2 py-1 text-sm"
        style={{ color: 'var(--color-text-muted)' }}
      >
        +
      </button>
    </div>
  );
}
