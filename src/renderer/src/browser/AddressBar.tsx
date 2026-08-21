import { useEffect, useState } from 'react';
import type { BrowserHistoryEntry, BrowserTab } from './types';

const BUTTON_STYLE = {
  border: '1px solid var(--color-border)',
  color: 'var(--color-text)',
} as const;

export function AddressBar({
  tab,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  onToggleFind,
}: {
  tab: BrowserTab;
  onNavigate: (input: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
  onToggleFind: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(tab.url);
  const [suggestions, setSuggestions] = useState<BrowserHistoryEntry[]>([]);
  const [focused, setFocused] = useState(false);

  // Follow the tab's real url whenever it changes underneath us -- a redirect,
  // a link click, or a tab switch -- but never while the user is mid-edit.
  useEffect(() => {
    if (!focused) setDraft(tab.url);
  }, [tab.url, focused]);

  useEffect(() => {
    if (!focused || draft.trim().length === 0) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    void window.smartlife.browser
      .findHistory(draft)
      .then((entries) => {
        if (!cancelled) setSuggestions(entries as BrowserHistoryEntry[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [draft, focused]);

  return (
    <div className="relative flex items-center gap-1">
      <button type="button" aria-label="Back" disabled={!tab.canGoBack} onClick={onBack} className="rounded px-2 py-1 text-sm disabled:opacity-40" style={BUTTON_STYLE}>
        ‹
      </button>
      <button type="button" aria-label="Forward" disabled={!tab.canGoForward} onClick={onForward} className="rounded px-2 py-1 text-sm disabled:opacity-40" style={BUTTON_STYLE}>
        ›
      </button>
      <button type="button" aria-label={tab.loading ? 'Stop' : 'Reload'} onClick={tab.loading ? onStop : onReload} className="rounded px-2 py-1 text-sm" style={BUTTON_STYLE}>
        {tab.loading ? '×' : '⟳'}
      </button>

      <form
        className="flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          setSuggestions([]);
          onNavigate(draft);
        }}
      >
        <input
          type="text"
          aria-label="Address"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setSuggestions([]);
          }}
          className="w-full rounded-md px-3 py-1.5 text-sm"
          style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
        />
      </form>

      <button type="button" aria-label="Find in page" onClick={onToggleFind} className="rounded px-2 py-1 text-sm" style={BUTTON_STYLE}>
        ⌕
      </button>

      {suggestions.length > 0 && (
        <ul
          className="absolute left-0 right-0 top-full z-10 mt-1 max-h-60 overflow-auto rounded-md"
          style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
          aria-label="History suggestions"
        >
          {suggestions.map((entry) => (
            <li key={`${entry.url}-${entry.visitedAt}`}>
              <button
                type="button"
                // onMouseDown, not onClick: the input's onBlur fires first and
                // clears the list, so a click would never land.
                onMouseDown={() => {
                  setSuggestions([]);
                  onNavigate(entry.url);
                }}
                className="block w-full truncate px-3 py-1.5 text-left text-xs"
                style={{ color: 'var(--color-text)' }}
              >
                {entry.title ?? entry.url}
                <span style={{ color: 'var(--color-text-muted)' }}> — {entry.url}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
