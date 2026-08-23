import { useEffect, useState } from 'react';

/**
 * Lives at the app-shell level, not inside useConversation/AIDock -- it must
 * survive the AI dock being closed and reopened, since that is exactly the
 * scenario a long-running confirmation (browser_click/type/select, up to 24
 * hours) needs to notify through. Asks main directly on mount rather than
 * only relying on a push event, so a confirmation requested while the dock
 * was closed is still picked up.
 */
export function usePendingConfirmationBadge(): boolean {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.smartlife.ai
      .getPendingConfirmation()
      .then((current) => {
        if (!cancelled) setPending(current !== null);
      })
      .catch(() => {});

    const stopRequest = window.smartlife.ai.onConfirmRequest(() => setPending(true));
    const stopResolved = window.smartlife.ai.onConfirmResolved(() => setPending(false));

    return () => {
      cancelled = true;
      stopRequest();
      stopResolved();
    };
  }, []);

  return pending;
}
