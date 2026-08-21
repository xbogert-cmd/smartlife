import { useCallback, useEffect, useState } from 'react';
import { formatBytes } from './formatters';
import type { BrowserDownloadRequest } from './types';
import { useBrowserSuspend } from './useBrowserSuspend';

export function DownloadPrompt(): React.JSX.Element | null {
  // A queue, not a single slot: a second download arriving while the first
  // prompt is open would otherwise overwrite it, and the main process would
  // wait forever on a promise nobody can answer.
  const [queue, setQueue] = useState<BrowserDownloadRequest[]>([]);

  useEffect(
    () =>
      window.smartlife.browser.onDownloadRequest((request) => {
        setQueue((pending) => [...pending, request as BrowserDownloadRequest]);
      }),
    []
  );

  const current = queue[0] ?? null;
  useBrowserSuspend(current !== null);

  const respond = useCallback(
    (approved: boolean) => {
      if (current === null) return;
      void window.smartlife.browser.respondToDownload(current.id, approved).catch(() => {});
      setQueue((pending) => pending.slice(1));
    },
    [current]
  );

  if (current === null) return null;

  let host = current.sourceUrl;
  try {
    host = new URL(current.sourceUrl).host;
  } catch {
    // Keep the raw string; a malformed url is still worth showing.
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Download file"
        className="flex w-96 flex-col gap-3 rounded-lg p-5"
        style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
      >
        <h2 className="text-base font-semibold" style={{ color: 'var(--color-text)' }}>
          Download this file?
        </h2>
        <div className="flex flex-col gap-1 text-sm" style={{ color: 'var(--color-text)' }}>
          <span className="truncate font-medium">{current.filename}</span>
          <span style={{ color: 'var(--color-text-muted)' }}>{formatBytes(current.sizeBytes)}</span>
          <span className="truncate" style={{ color: 'var(--color-text-muted)' }}>
            from {host}
          </span>
        </div>
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Saves to your Downloads folder. Nothing is written unless you choose Save.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => respond(false)}
            className="rounded-md px-3 py-1.5 text-sm"
            style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => respond(true)}
            className="rounded-md px-3 py-1.5 text-sm"
            style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)' }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
