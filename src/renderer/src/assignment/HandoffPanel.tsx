import { useEffect, useRef } from 'react';
import { ViewportSlot } from '../browser/ViewportSlot';
import { useBrowser } from '../browser/useBrowser';

const EXPLANATIONS: Record<string, string> = {
  external_tool:
    'This assignment runs in an external tool, so Canvas has no way to accept a submission for it from here. Complete it here in the browser — you are already signed in.',
  quiz: 'This is a Canvas quiz. Quizzes have to be taken in the quiz interface — complete it here in the browser.',
  unresolved_discussion:
    'This is a discussion, but its topic has not synced yet. Complete it here in the browser, or sync the course and come back.',
};

interface HandoffPanelProps {
  htmlUrl: string | null;
  reason: 'external_tool' | 'quiz' | 'unresolved_discussion';
}

// Module-level, not component state: it must survive HandoffPanel remounting
// (navigate away from the assignment and back is a fresh component
// instance) so a second visit reuses the tab instead of opening a duplicate.
// Keyed by htmlUrl rather than assignment id -- each assignment already has
// a distinct Canvas URL, so no separate id is needed. Holds a tab id, not a
// url: once Canvas's own LTI launch navigates the tab to the tool's domain,
// its live url no longer matches htmlUrl, but the id is still the same tab.
const handoffTabByUrl = new Map<string, string>();

/**
 * The embedded browser, in the workspace, already on the Canvas assignment page.
 *
 * It must be the Canvas URL and not the tool's own domain: LTI tools
 * authenticate through a signed launch that only Canvas can send, so loading
 * the tool directly produces a logged-out page. Canvas fires its own launch
 * from this page, and Phase 5's persistent session keeps the user signed in.
 */
export function HandoffPanel({ htmlUrl, reason }: HandoffPanelProps): React.JSX.Element {
  // useBrowser is what calls setRouteActive, which is what puts the native view
  // on screen. Routes are mutually exclusive, so this never fights /browser.
  const { state, activateTab } = useBrowser();
  const opened = useRef(false);

  useEffect(() => {
    // Wait for the initial tab list so the reuse check below has something
    // real to check against -- opening blind here would race a tab that
    // already exists but hasn't loaded into state yet.
    if (htmlUrl === null || opened.current || state === null) return;
    opened.current = true;

    const existingTabId = handoffTabByUrl.get(htmlUrl);
    const stillOpen = existingTabId !== undefined && state.tabs.some((tab) => tab.id === existingTabId);

    if (stillOpen) {
      void activateTab(existingTabId);
      return;
    }

    void window.smartlife.browser
      .openTab(htmlUrl)
      .then((tabId) => handoffTabByUrl.set(htmlUrl, tabId))
      .catch(() => {});
  }, [htmlUrl, state, activateTab]);

  if (htmlUrl === null) {
    return (
      <section aria-label="Browser handoff">
        <p style={{ color: 'var(--color-text)' }}>
          {EXPLANATIONS[reason]} There is no link stored for this assignment — open it from Canvas directly.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Browser handoff" className="flex min-h-0 flex-1 flex-col">
      <p className="mb-3 text-sm" style={{ color: 'var(--color-text-muted)' }}>
        {EXPLANATIONS[reason]}
      </p>
      <ViewportSlot />
    </section>
  );
}
