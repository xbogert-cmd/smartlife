import type { ReactNode } from 'react';

/** A bordered, rounded group with a small muted header -- the shared shape
 *  behind Home's "Needs attention" / "Today" / "Next 7 days" sections.
 *  Rendered as <ul>/<li> (not plain <div>s) so assistive tech still gets
 *  list semantics and an item count on these information-dense rows.
 *  Rows get a hairline divider between them (see .panel-rows in
 *  tokens.css), not their own individual border/box the way this app's
 *  list sections used to render each row. */
export function Panel({ title, children }: { title: string; children: ReactNode }): React.JSX.Element {
  return (
    <div
      data-testid="panel"
      className="overflow-hidden rounded-xl border"
      style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-panel-bg)' }}
    >
      <div
        className="border-b px-4 py-2.5 text-xs font-semibold uppercase tracking-wide"
        style={{ color: 'var(--color-text-muted)', borderColor: 'var(--color-border)' }}
      >
        {title}
      </div>
      <ul className="panel-rows m-0 flex list-none flex-col p-0">{children}</ul>
    </div>
  );
}

/** No padding here -- padding belongs on the row's own interactive content
 *  (the Link or div each consumer renders inside), so the whole padded area
 *  becomes part of the click target instead of just an inset strip within it. */
export function PanelRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <li>{children}</li>;
}
