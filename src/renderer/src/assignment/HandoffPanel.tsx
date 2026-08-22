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
  useBrowser();
  const opened = useRef(false);

  useEffect(() => {
    if (htmlUrl === null || opened.current) return;
    opened.current = true;
    void window.smartlife.browser.openTab(htmlUrl).catch(() => {});
  }, [htmlUrl]);

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
