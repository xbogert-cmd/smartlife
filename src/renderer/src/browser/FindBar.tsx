import { useEffect, useState } from 'react';
import type { BrowserFindResult } from './types';

export function FindBar({
  onFind,
  onClose,
}: {
  onFind: (text: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [result, setResult] = useState<BrowserFindResult | null>(null);

  useEffect(() => window.smartlife.browser.onFindResult(setResult), []);

  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <input
        type="text"
        aria-label="Find in page"
        autoFocus
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onFind(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
        className="rounded-md px-2 py-1 text-sm"
        style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
      />
      {result !== null && result.matches > 0 && (
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {result.activeMatchOrdinal} of {result.matches}
        </span>
      )}
      {result !== null && result.matches === 0 && text.length > 0 && (
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          No matches
        </span>
      )}
      <button type="button" aria-label="Close find" onClick={onClose} className="rounded px-2 py-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
        ×
      </button>
    </div>
  );
}
