import { useEffect } from 'react';

/**
 * Hides the native browser view while `active` is true.
 *
 * A WebContentsView composites above the React tree, so any overlay -- the
 * Cmd+J assistant, the Cmd+K palette, a dialog -- would be painted underneath
 * the page. Pairing suspend with resume inside a single effect means the
 * cleanup guarantees a matching release, including on unmount; the main
 * process counts them, so two overlays open at once behave correctly.
 */
export function useBrowserSuspend(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    void window.smartlife.browser.suspend().catch(() => {});
    return () => {
      void window.smartlife.browser.resume().catch(() => {});
    };
  }, [active]);
}
