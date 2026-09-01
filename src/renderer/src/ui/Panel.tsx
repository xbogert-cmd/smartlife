import type { ReactNode } from 'react';

/** A bordered, rounded group with a small muted header -- the shared shape
 *  behind Home's "Needs attention" / "Today" / "Next 7 days" sections. Rows
 *  inside get a hairline divider between them (see .panel-rows in
 *  tokens.css), not their own individual border/box the way this app's list
 *  sections used to render each row. */
export function Panel({ title, children }: { title: string; children: ReactNode }): React.JSX.Element {
  return (
    <div
      className="overflow-hidden rounded-xl border"
      style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-panel-bg)' }}
    >
      <div
        className="border-b px-4 py-2.5 text-xs font-semibold uppercase tracking-wide"
        style={{ color: 'var(--color-text-muted)', borderColor: 'var(--color-border)' }}
      >
        {title}
      </div>
      <div className="panel-rows flex flex-col">{children}</div>
    </div>
  );
}

export function PanelRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-3 px-4 py-2.5">{children}</div>;
}
