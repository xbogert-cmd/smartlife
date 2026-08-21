export interface SuspendCounter {
  acquire(): void;
  release(): void;
  isSuspended(): boolean;
  count(): number;
  reset(): void;
}

/**
 * A WebContentsView is a native view composited above the window's HTML, so
 * every React overlay -- the Cmd+J assistant, the Cmd+K palette, the download
 * prompt -- would be painted underneath it. The view is hidden while any of
 * them is open.
 *
 * This is a counter and not a boolean for one specific reason: with a boolean,
 * opening Cmd+K on top of Cmd+J and then closing just one restores the page
 * over a still-open overlay. Nesting is the normal case, not the edge case.
 */
export function createSuspendCounter(): SuspendCounter {
  let depth = 0;

  return {
    acquire(): void {
      depth += 1;
    },
    release(): void {
      // Clamped rather than allowed to go negative: an unmatched release
      // (a renderer reload mid-overlay) must not leave the counter in a state
      // where the next acquire fails to suspend.
      depth = Math.max(0, depth - 1);
    },
    isSuspended(): boolean {
      return depth > 0;
    },
    count(): number {
      return depth;
    },
    reset(): void {
      depth = 0;
    },
  };
}
