# Visual Redesign: Shell, Home, AI Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the sidebar/traffic-light overlap bug and give the app's shared shell, Home dashboard, and AI chat screen a more polished, "Apple-quality" look, using the app's existing CSS-custom-property theming system.

**Architecture:** Extend `tokens.css`'s existing token set with a few new colors, consumed via the same `var(--color-x)` inline-style pattern already used everywhere in this codebase (never Tailwind color utilities — this project deliberately never wired these tokens into Tailwind's theme). A new small shared `Panel`/`PanelRow` presentational component removes triplicated box styling across three Home components. `sectionThemes.ts`'s existing per-section accent/gradient registry is reused as-is, not replaced.

**Tech Stack:** Electron + React 19 + TypeScript, Tailwind CSS v4 (utility classes for layout only, never these color tokens), Vitest (`npm test`, never `npx vitest run` — breaks better-sqlite3's native ABI). New dependency: `lucide-react` (MIT, tree-shakeable icon components).

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-09-01-smartlife-visual-redesign-shell-design.md` — source of truth for every value below.
- New tokens go in both the `:root, [data-theme="dark"]` block and the `[data-theme="light"]` block of `src/renderer/src/theme/tokens.css`, matching the existing 5 tokens' pattern exactly.
- `sectionThemes.ts`'s existing accent/gradient values are not changed.
- Color values are never asserted on directly in tests (matches this codebase's existing convention — no test file anywhere asserts an inline `style.color`/`style.backgroundColor` value). Tests cover structure and behavior (icons present, correct routing, correct `data-severity`, chip click behavior) — not aesthetics. The one exception is the traffic-light `paddingTop` value in Task 1, which is a numeric bug-fix contract worth pinning down, not an aesthetic choice.
- `src/main/index.ts` has no existing test file and this plan does not add one — Electron's `BrowserWindow` bootstrap has never been unit-tested in this codebase. Task 1's traffic-light fix is verified by rebuilding the packaged app and taking a screenshot instead.
- No behavior change to any existing handler, IPC call, AI tool, or permission-mode logic — this is a styling/structure-only pass.
- Voice mode is out of scope (standing project instruction, unrelated to this work).

---

### Task 1: Fix the sidebar/traffic-light overlap

**Files:**
- Modify: `src/main/index.ts:44-58`
- Modify: `src/renderer/src/nav/Sidebar.tsx:12-13`
- Test: `src/renderer/src/nav/Sidebar.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing later tasks depend on directly, though Task 2 edits the same `<nav>` element again right after this lands.

- [ ] **Step 1: Write the failing test**

Add this test to `src/renderer/src/nav/Sidebar.test.tsx`, inside the existing `describe('Sidebar pending-confirmation badge', ...)` block is the wrong place for it (it's not about the badge) — add a new `describe` block instead, after that one:

```tsx
describe('Sidebar traffic-light clearance', () => {
  it('reserves top padding so the nav list clears the macOS traffic-light buttons', () => {
    renderSidebar();
    const nav = screen.getByRole('navigation');
    expect(nav.style.paddingTop).toBe('44px');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/renderer/src/nav/Sidebar.test.tsx`
Expected: FAIL — `nav.style.paddingTop` is currently `''` (only the Tailwind `p-3` class sets padding today, no inline `paddingTop` override exists).

- [ ] **Step 3: Fix the window's traffic-light position**

In `src/main/index.ts`, change the `BrowserWindow` constructor (currently lines 45-58) from:

```ts
    const window = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      titleBarStyle: 'hiddenInset',
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
```

to:

```ts
    const window = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      titleBarStyle: 'hiddenInset',
      // Explicit, not the OS default -- Sidebar.tsx's paddingTop below reserves
      // space for exactly this position, so the two can never silently drift
      // apart the way "leave it at the OS default and hope the CSS guess is
      // still right" would.
      trafficLightPosition: { x: 20, y: 20 },
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
```

- [ ] **Step 4: Reserve matching space in the sidebar**

In `src/renderer/src/nav/Sidebar.tsx`, change the opening `<nav>` element (currently lines 12-13):

```tsx
    <nav className="flex w-56 flex-shrink-0 flex-col gap-1 border-r p-3" style={{ borderColor: 'var(--color-border)' }}>
```

to:

```tsx
    <nav
      className="flex w-56 flex-shrink-0 flex-col gap-1 border-r p-3"
      // Clears the traffic-light buttons -- src/main/index.ts sets
      // trafficLightPosition: { x: 20, y: 20 } explicitly, so this number is
      // a deliberate match to that, not a guess at the OS default.
      style={{ borderColor: 'var(--color-border)', paddingTop: 44 }}
    >
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/renderer/src/nav/Sidebar.test.tsx`
Expected: PASS, all tests in the file green.

- [ ] **Step 6: Rebuild the packaged app and verify visually**

```bash
pkill -9 -f "SmartLife.app" || true
npm run package
rm -rf "/Applications/SmartLife.app"
cp -R release/mac-arm64/SmartLife.app /Applications/
```

Open the app and take a screenshot of the sidebar. Confirm the "Home" label (and every other nav label) no longer overlaps the red/yellow/green traffic-light buttons. If it still looks off, adjust the `44` in `Sidebar.tsx` (and update the test's expected value to match) until it looks right, then re-run Step 5.

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts src/renderer/src/nav/Sidebar.tsx src/renderer/src/nav/Sidebar.test.tsx
git commit -m "Fix the sidebar overlapping the macOS traffic-light buttons

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Redesign the sidebar — icons, refined active/inactive states

**Files:**
- Modify: `package.json` (new dependency)
- Modify: `src/renderer/src/theme/tokens.css`
- Modify: `src/renderer/src/nav/Sidebar.tsx`
- Test: `src/renderer/src/nav/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `NAV_SECTIONS` from `./sections` (unchanged), `getSectionTheme` from `./sectionThemes` (unchanged — `{ gradient: string; accent: string }`), the `paddingTop: 44` structure from Task 1 (this task edits the same `<nav>` element again, keep that line).
- Produces: a new `--color-sidebar-bg` token later tasks may reuse; nothing else depends on this task's internals.

- [ ] **Step 1: Install the icon library**

```bash
npm install lucide-react
```

- [ ] **Step 2: Write the failing test**

Add this test to `src/renderer/src/nav/Sidebar.test.tsx`, in the same new `describe('Sidebar traffic-light clearance', ...)` block Task 1 added, or a new one — add it as its own block after that one:

```tsx
import { NAV_SECTIONS } from './sections';

describe('Sidebar icons', () => {
  it('renders exactly one icon per nav section', () => {
    renderSidebar();
    const nav = screen.getByRole('navigation');
    const icons = nav.querySelectorAll('svg');
    expect(icons.length).toBe(NAV_SECTIONS.length);
  });
});
```

(Add the `import { NAV_SECTIONS } from './sections';` line once, at the top of the file with the other imports — not repeated per describe block.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/renderer/src/nav/Sidebar.test.tsx`
Expected: FAIL — `icons.length` is currently `0` (no `<svg>` anywhere in the sidebar today).

- [ ] **Step 4: Add the new sidebar-background token**

In `src/renderer/src/theme/tokens.css`, change the two theme blocks from:

```css
:root,
[data-theme="dark"] {
  --color-bg: #0b0b0d;
  --color-surface: #17171a;
  --color-border: #27272a;
  --color-text: #f4f4f5;
  --color-text-muted: #a1a1aa;
}

[data-theme="light"] {
  --color-bg: #f7f7f8;
  --color-surface: #ffffff;
  --color-border: #e4e4e7;
  --color-text: #18181b;
  --color-text-muted: #71717a;
}
```

to:

```css
:root,
[data-theme="dark"] {
  --color-bg: #0b0b0d;
  --color-surface: #17171a;
  --color-sidebar-bg: #151517;
  --color-border: #27272a;
  --color-text: #f4f4f5;
  --color-text-muted: #a1a1aa;
}

[data-theme="light"] {
  --color-bg: #f7f7f8;
  --color-surface: #ffffff;
  --color-sidebar-bg: #f0f0f2;
  --color-border: #e4e4e7;
  --color-text: #18181b;
  --color-text-muted: #71717a;
}
```

- [ ] **Step 5: Rewrite the sidebar**

Replace the full contents of `src/renderer/src/nav/Sidebar.tsx` with:

```tsx
import { NavLink } from 'react-router-dom';
import {
  Home as HomeIcon,
  Sparkles,
  Calendar,
  GraduationCap,
  Globe,
  CheckSquare,
  FileText,
  Target,
  Folder,
  Search,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';
import { NAV_SECTIONS } from './sections';
import { getSectionTheme } from './sectionThemes';

interface SidebarProps {
  aiOpen: boolean;
  onToggleAi: () => void;
  hasPendingConfirmation: boolean;
}

const ICONS: Record<string, LucideIcon> = {
  home: HomeIcon,
  ai: Sparkles,
  calendar: Calendar,
  school: GraduationCap,
  browser: Globe,
  tasks: CheckSquare,
  notes: FileText,
  goals: Target,
  files: Folder,
  search: Search,
  settings: SettingsIcon,
};

export function Sidebar({ aiOpen, onToggleAi, hasPendingConfirmation }: SidebarProps) {
  return (
    <nav
      className="flex w-56 flex-shrink-0 flex-col gap-1 border-r p-3"
      // Clears the traffic-light buttons -- src/main/index.ts sets
      // trafficLightPosition: { x: 20, y: 20 } explicitly, so this number is
      // a deliberate match to that, not a guess at the OS default.
      style={{
        borderColor: 'var(--color-border)',
        backgroundColor: 'var(--color-sidebar-bg)',
        paddingTop: 44,
      }}
    >
      {NAV_SECTIONS.map((section) => {
        const theme = getSectionTheme(section.slug);
        const Icon = ICONS[section.slug] ?? HomeIcon;
        return (
          <NavLink
            key={section.slug}
            to={section.path}
            end={section.path === '/'}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:opacity-80"
            style={({ isActive }) => ({
              backgroundColor: isActive ? `color-mix(in srgb, ${theme.accent} 16%, transparent)` : 'transparent',
              color: isActive ? `color-mix(in srgb, ${theme.accent} 75%, white)` : 'var(--color-text-muted)',
            })}
          >
            {({ isActive }) => (
              <>
                <Icon
                  size={16}
                  aria-hidden="true"
                  style={{
                    flexShrink: 0,
                    color: isActive ? theme.accent : `color-mix(in srgb, ${theme.accent} 50%, transparent)`,
                  }}
                />
                {section.label}
              </>
            )}
          </NavLink>
        );
      })}

      {/*
        The assistant toggle lives here rather than floating over the content
        area: the embedded browser is a native view composited above the React
        tree, so a button drawn over its rectangle would be invisible on
        /browser -- the one route where it is most needed. The sidebar is
        chrome the native view never covers.
      */}
      <button
        type="button"
        onClick={onToggleAi}
        aria-pressed={aiOpen}
        className="relative mt-auto rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors hover:opacity-80"
        style={{
          border: '1px solid var(--color-border)',
          color: 'var(--color-text-muted)',
          backgroundColor: aiOpen ? 'var(--color-surface)' : 'transparent',
        }}
      >
        {aiOpen ? 'Hide assistant' : 'Ask AI'}
        <span className="ml-2 opacity-60">⌘J</span>
        {hasPendingConfirmation && !aiOpen && (
          <span
            data-testid="pending-confirmation-badge"
            aria-label="Waiting for your approval"
            className="absolute right-2 top-2 h-2 w-2 rounded-full"
            style={{ backgroundColor: '#EF4444' }}
          />
        )}
      </button>
    </nav>
  );
}
```

Note: the `Ask AI` button is unchanged from before this task — it already used `var(--color-surface)`/`var(--color-border)`, which still read correctly against the new `var(--color-sidebar-bg)` background.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- src/renderer/src/nav/Sidebar.test.tsx`
Expected: PASS, all tests in the file green (including Task 1's traffic-light test, still passing since `paddingTop: 44` is preserved).

- [ ] **Step 7: Rebuild and verify visually**

```bash
pkill -9 -f "SmartLife.app" || true
npm run package
rm -rf "/Applications/SmartLife.app"
cp -R release/mac-arm64/SmartLife.app /Applications/
```

Screenshot the sidebar in both light and dark mode (toggle in Settings). Confirm every item has an icon, the active item shows a soft tinted pill (not a solid color block), and inactive icons read as a quiet muted tint of their section's color.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/renderer/src/theme/tokens.css src/renderer/src/nav/Sidebar.tsx src/renderer/src/nav/Sidebar.test.tsx
git commit -m "Redesign the sidebar with icons and refined per-section color tints

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Add an `overdueSeverity` helper

**Files:**
- Modify: `src/renderer/src/school/formatters.ts`
- Test: `src/renderer/src/school/formatters.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function overdueSeverity(dueAt: string, now: Date = new Date()): 'critical' | 'moderate'`. Task 4 imports this from `../school/formatters` (used inside `home/NeedsAttention.tsx`, which is not in the `school/` folder — that relative import path is correct and already used elsewhere in this codebase the same way, e.g. `home/NeedsAttention.tsx` already imports `formatDue` from `'../school/formatters'`).

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `src/renderer/src/school/formatters.test.ts`, after the existing `describe('formatDue', ...)` block:

```ts
describe('overdueSeverity', () => {
  it('is critical for something overdue by less than 2 days', () => {
    expect(overdueSeverity('2026-08-18T11:55:00Z', NOW)).toBe('critical');
    expect(overdueSeverity('2026-08-17T12:00:00Z', NOW)).toBe('critical'); // exactly 1 day
  });

  it('is moderate at exactly 2 days overdue', () => {
    expect(overdueSeverity('2026-08-16T12:00:00Z', NOW)).toBe('moderate');
  });

  it('is moderate for something overdue by many days', () => {
    expect(overdueSeverity('2026-08-01T12:00:00Z', NOW)).toBe('moderate');
  });

  it('is critical for something overdue by a single minute', () => {
    expect(overdueSeverity('2026-08-18T11:59:00Z', NOW)).toBe('critical');
  });
});
```

Also change the file's import line at the top from:

```ts
import { describe, expect, it } from 'vitest';
import { formatDue, formatRelative } from './formatters';
```

to:

```ts
import { describe, expect, it } from 'vitest';
import { formatDue, formatRelative, overdueSeverity } from './formatters';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/renderer/src/school/formatters.test.ts`
Expected: FAIL — `overdueSeverity` is not exported yet (`TypeError: overdueSeverity is not a function` or an import error).

- [ ] **Step 3: Implement `overdueSeverity`**

In `src/renderer/src/school/formatters.ts`, add this function after `formatDue` (at the end of the file):

```ts
/** Only meaningful for something already overdue -- callers that only ever
 *  pass past-due items (NeedsAttention.tsx) don't need to check first, but
 *  passing a not-yet-due dueAt here isn't guarded against, since a negative
 *  `elapsed` is just always < 2 * DAY and reads as 'critical', which is
 *  harmless for a caller that would never show it in the first place. */
export function overdueSeverity(dueAt: string, now: Date = new Date()): 'critical' | 'moderate' {
  const elapsed = now.getTime() - Date.parse(dueAt);
  return elapsed < 2 * DAY ? 'critical' : 'moderate';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/renderer/src/school/formatters.test.ts`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/school/formatters.ts src/renderer/src/school/formatters.test.ts
git commit -m "Add overdueSeverity helper for color-coding how late something is

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Redesign Home's due-date panels

**Files:**
- Create: `src/renderer/src/ui/Panel.tsx`
- Create: `src/renderer/src/ui/Panel.test.tsx`
- Modify: `src/renderer/src/theme/tokens.css`
- Modify: `src/renderer/src/home/NeedsAttention.tsx`
- Modify: `src/renderer/src/home/TodayPanel.tsx`
- Modify: `src/renderer/src/school/DueSoon.tsx`
- Test: `src/renderer/src/home/NeedsAttention.test.tsx`

**Interfaces:**
- Consumes: `overdueSeverity` from `../school/formatters` (Task 3).
- Produces: `Panel` and `PanelRow` from `../ui/Panel`, both `({ title, children }: { title: string; children: ReactNode })` / `({ children }: { children: ReactNode })` — no other task consumes these, but they're written generically enough that the "deeper Home pass" the user has already flagged as a follow-up can reuse them for `GradeStrip`/`TokenBanner`/Announcements later.

- [ ] **Step 1: Write the failing test for `Panel`**

Create `src/renderer/src/ui/Panel.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Panel, PanelRow } from './Panel';

describe('Panel', () => {
  it('renders its title and children', () => {
    render(
      <Panel title="Needs attention">
        <PanelRow>Row one</PanelRow>
        <PanelRow>Row two</PanelRow>
      </Panel>
    );
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('Row one')).toBeInTheDocument();
    expect(screen.getByText('Row two')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/renderer/src/ui/Panel.test.tsx`
Expected: FAIL with "Cannot find module './Panel'" (the file doesn't exist yet).

- [ ] **Step 3: Add the panel-body divider rule and new tokens**

In `src/renderer/src/theme/tokens.css`, change the two theme blocks from (this is the state Task 2 left them in):

```css
:root,
[data-theme="dark"] {
  --color-bg: #0b0b0d;
  --color-surface: #17171a;
  --color-sidebar-bg: #151517;
  --color-border: #27272a;
  --color-text: #f4f4f5;
  --color-text-muted: #a1a1aa;
}

[data-theme="light"] {
  --color-bg: #f7f7f8;
  --color-surface: #ffffff;
  --color-sidebar-bg: #f0f0f2;
  --color-border: #e4e4e7;
  --color-text: #18181b;
  --color-text-muted: #71717a;
}
```

to:

```css
:root,
[data-theme="dark"] {
  --color-bg: #0b0b0d;
  --color-surface: #17171a;
  --color-sidebar-bg: #151517;
  --color-panel-bg: #151517;
  --color-border: #27272a;
  --color-text: #f4f4f5;
  --color-text-muted: #a1a1aa;
  --color-danger: #f87171;
  --color-warning: #fb923c;
}

[data-theme="light"] {
  --color-bg: #f7f7f8;
  --color-surface: #ffffff;
  --color-sidebar-bg: #f0f0f2;
  --color-panel-bg: #f0f0f2;
  --color-border: #e4e4e7;
  --color-text: #18181b;
  --color-text-muted: #71717a;
  --color-danger: #dc2626;
  --color-warning: #ea580c;
}
```

Then, at the end of the same file (after the existing `body { ... }` block), add:

```css
/* Hairline between panel rows -- only between rows, not above the first or
   below the last, via the classic adjacent-sibling pattern. Deliberately not
   Tailwind's divide-y utility: this project's --color-* tokens are plain CSS
   custom properties (see the :root block above), never registered into
   Tailwind's theme, so every color in this codebase is applied via inline
   style rather than a Tailwind color class -- this rule follows that same
   convention instead of introducing the one exception. */
.panel-rows > * + * {
  border-top: 1px solid var(--color-border);
}
```

- [ ] **Step 4: Implement `Panel`**

Create `src/renderer/src/ui/Panel.tsx`:

```tsx
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/renderer/src/ui/Panel.test.tsx`
Expected: PASS.

- [ ] **Step 6: Write the failing test for `NeedsAttention`'s severity coloring**

Add this test to `src/renderer/src/home/NeedsAttention.test.tsx`, after the existing `'says how late each item is'` test:

```tsx
  it('marks a critically-overdue item with data-severity="critical" and a longer-overdue item as "moderate"', () => {
    const critical: UpcomingAssignment = { ...overdue(10, 'Missed lab'), dueAt: new Date(Date.now() - 3 * 3_600_000).toISOString() };
    const moderate: UpcomingAssignment = { ...overdue(11, 'Old assignment'), dueAt: new Date(Date.now() - 5 * 86_400_000).toISOString() };
    renderSection([critical, moderate]);
    expect(screen.getByRole('link', { name: /Missed lab/ }).getAttribute('data-severity')).toBe('critical');
    expect(screen.getByRole('link', { name: /Old assignment/ }).getAttribute('data-severity')).toBe('moderate');
  });
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm test -- src/renderer/src/home/NeedsAttention.test.tsx`
Expected: FAIL — `getAttribute('data-severity')` is currently `null` (no such attribute exists yet).

- [ ] **Step 8: Rewrite `NeedsAttention.tsx`**

Replace the full contents of `src/renderer/src/home/NeedsAttention.tsx` with:

```tsx
import { Link } from 'react-router-dom';
import { formatDue, overdueSeverity } from '../school/formatters';
import { type UpcomingAssignment } from '../school/types';
import { Panel, PanelRow } from '../ui/Panel';

/**
 * Past-due, unsubmitted work.
 *
 * Renders nothing when empty rather than an empty state: a permanent
 * "nothing overdue" row is a daily false alarm the user learns to skip past,
 * which is exactly the wrong reflex to train for this section.
 */
export function NeedsAttention({ items }: { items: UpcomingAssignment[] }): React.JSX.Element | null {
  if (items.length === 0) return null;

  return (
    <Panel title="Needs attention">
      {items.map((item) => {
        const severity = overdueSeverity(item.dueAt);
        const color = severity === 'critical' ? 'var(--color-danger)' : 'var(--color-warning)';
        return (
          <PanelRow key={item.id}>
            <Link to={`/assignment/${item.id}`} data-severity={severity} className="flex min-w-0 flex-1 items-center gap-3">
              <span aria-hidden="true" className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span style={{ color: 'var(--color-text)' }}>{item.name}</span>
                <span className="truncate text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {item.courseName}
                </span>
              </div>
              <span className="ml-3 flex-shrink-0 text-xs font-medium" style={{ color }}>
                {formatDue(item.dueAt)}
              </span>
            </Link>
          </PanelRow>
        );
      })}
    </Panel>
  );
}
```

Note: `SCHOOL_ACCENT` is no longer imported/used here — the panel header is now uniformly muted (matching the approved mockup) rather than colored, and the per-row color is now severity-driven instead of a single fixed accent.

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test -- src/renderer/src/home/NeedsAttention.test.tsx`
Expected: PASS, all tests in the file green (including the 3 pre-existing tests — text/link/overdue-text assertions all still hold since the visible text content is unchanged, only the DOM wrapper and coloring changed).

- [ ] **Step 10: Rewrite `TodayPanel.tsx`**

Replace the full contents of `src/renderer/src/home/TodayPanel.tsx` with:

```tsx
import { Link } from 'react-router-dom';
import { formatClockTime, formatEventTime } from '../calendar/formatters';
import { CALENDAR_ACCENT } from '../calendar/types';
import { SCHOOL_ACCENT } from '../school/types';
import { Panel, PanelRow } from '../ui/Panel';
import type { TodayItem } from './timeline';

function timeLabel(item: TodayItem): string {
  if (item.kind === 'event') return formatEventTime(item.event);
  return formatClockTime(new Date(item.at));
}

function Row({ item }: { item: TodayItem }): React.JSX.Element {
  const accent = item.kind === 'event' ? CALENDAR_ACCENT : SCHOOL_ACCENT;
  const title = item.kind === 'event' ? (item.event.summary ?? 'Untitled event') : item.assignment.name;
  const detail = item.kind === 'event' ? item.event.location : item.assignment.courseName;

  const body = (
    <>
      <span aria-hidden="true" className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ backgroundColor: accent }} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span style={{ color: 'var(--color-text)' }}>{title}</span>
        {detail && (
          <span className="truncate text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {detail}
          </span>
        )}
      </div>
      <span className="ml-auto flex-shrink-0 text-xs" style={{ color: 'var(--color-text-muted)' }}>
        {item.kind === 'due' && item.assignment.hasSubmitted ? 'submitted' : timeLabel(item)}
      </span>
    </>
  );

  const className = 'flex min-w-0 flex-1 items-center gap-3';

  // Only due items have somewhere to go. An event's own surface is the
  // calendar week grid, which has no per-event route.
  return item.kind === 'due' ? (
    <Link to={`/assignment/${item.assignment.id}`} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

export function TodayPanel({ items }: { items: TodayItem[] }): React.JSX.Element {
  return (
    <Panel title="Today">
      {items.length === 0 ? (
        <PanelRow>
          <span style={{ color: 'var(--color-text-muted)' }}>Nothing scheduled today.</span>
        </PanelRow>
      ) : (
        items.map((item) => (
          <PanelRow key={item.kind === 'event' ? `e${item.event.calendarId}:${item.event.id}` : `a${item.assignment.id}`}>
            <Row item={item} />
          </PanelRow>
        ))
      )}
    </Panel>
  );
}
```

Note: `TodayPanel.tsx` no longer renders its own `<ul>`/`<li>`/`<h2>` — the existing `TodayPanel.test.tsx` file queries by text/role, not by list markup, so it is unaffected by this structural change (verified in Step 12).

- [ ] **Step 11: Rewrite `DueSoon.tsx`**

Replace the full contents of `src/renderer/src/school/DueSoon.tsx` with:

```tsx
import { formatDue } from './formatters';
import { SCHOOL_ACCENT, type UpcomingAssignment } from './types';
import { Panel, PanelRow } from '../ui/Panel';

export function DueSoon({
  items,
  title = 'Due soon',
  emptyText = 'Nothing due in the next two weeks.',
}: {
  items: UpcomingAssignment[];
  title?: string;
  emptyText?: string;
}): React.JSX.Element {
  return (
    <Panel title={title}>
      {items.length === 0 ? (
        <PanelRow>
          <span style={{ color: 'var(--color-text-muted)' }}>{emptyText}</span>
        </PanelRow>
      ) : (
        items.map((item) => (
          <PanelRow key={item.id}>
            <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col">
                <span style={{ color: 'var(--color-text)' }}>{item.name}</span>
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {item.courseName}
                </span>
              </div>
              <span className="flex-shrink-0 text-xs" style={{ color: item.hasSubmitted ? 'var(--color-text-muted)' : SCHOOL_ACCENT }}>
                {item.hasSubmitted ? 'submitted' : formatDue(item.dueAt)}
              </span>
            </div>
          </PanelRow>
        ))
      )}
    </Panel>
  );
}
```

- [ ] **Step 12: Run the full set of affected tests**

Run: `npm test -- src/renderer/src/ui/Panel.test.tsx src/renderer/src/home/NeedsAttention.test.tsx src/renderer/src/home/TodayPanel.test.tsx src/renderer/src/school/DueSoon.test.tsx`
Expected: PASS — every pre-existing test in all three home/school files, plus the new `Panel` test and the new severity test, all green.

- [ ] **Step 13: Rebuild and verify visually**

```bash
pkill -9 -f "SmartLife.app" || true
npm run package
rm -rf "/Applications/SmartLife.app"
cp -R release/mac-arm64/SmartLife.app /Applications/
```

Screenshot the Home screen with at least one overdue and one moderately-overdue item, confirming the grouped-panel look with color-coded urgency text (red for the most urgent, orange for the rest), matching the approved mockup.

- [ ] **Step 14: Commit**

```bash
git add src/renderer/src/ui/Panel.tsx src/renderer/src/ui/Panel.test.tsx \
        src/renderer/src/theme/tokens.css \
        src/renderer/src/home/NeedsAttention.tsx src/renderer/src/home/NeedsAttention.test.tsx \
        src/renderer/src/home/TodayPanel.tsx \
        src/renderer/src/school/DueSoon.tsx
git commit -m "Redesign Home's due-date sections as grouped panels with urgency colors

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Redesign the AI chat panel

**Files:**
- Modify: `src/renderer/src/ai/ChatPanel.tsx`
- Test: `src/renderer/src/ai/ChatPanel.test.tsx`

**Interfaces:**
- Consumes: `getSectionTheme` from `../nav/sectionThemes` (unchanged).
- Produces: nothing later tasks depend on — this is the last task in the plan.

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `src/renderer/src/ai/ChatPanel.test.tsx`, after the existing `describe('ChatPanel switch notices', ...)` block:

```tsx
describe('ChatPanel empty state', () => {
  const emptyProps = {
    messages: [] as ChatMessage[],
    statusLabel: null,
    pendingConfirm: null,
    sending: false,
    apiKeyConfigured: true,
    input: '',
    onInputChange: vi.fn(),
    onSubmit: vi.fn(),
    onRespondToConfirm: vi.fn(),
    attachments: [] as { id: string; name: string; kind: 'text' | 'image' }[],
    attachError: null as string | null,
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    voiceModeOn: false,
    onToggleVoiceMode: vi.fn(),
    isRecording: false,
    onToggleRecording: vi.fn(),
    voiceError: null as string | null,
  };

  it('shows a greeting and suggestion chips when there is nothing in the transcript yet', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...emptyProps} />
      </MemoryRouter>
    );
    expect(screen.getByText('What can I help with?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "What's due this week?" })).toBeInTheDocument();
  });

  it('fills the input with a suggestion when a chip is clicked, without sending it', async () => {
    const onInputChange = vi.fn();
    const onSubmit = vi.fn();
    render(
      <MemoryRouter>
        <ChatPanel {...emptyProps} onInputChange={onInputChange} onSubmit={onSubmit} />
      </MemoryRouter>
    );
    await userEvent.click(screen.getByRole('button', { name: "What's due this week?" }));
    expect(onInputChange).toHaveBeenCalledWith("What's due this week?");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not show the empty state once there are messages', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...emptyProps} messages={[{ id: '1', role: 'user', text: 'hi' }]} />
      </MemoryRouter>
    );
    expect(screen.queryByText('What can I help with?')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/renderer/src/ai/ChatPanel.test.tsx`
Expected: FAIL — none of the new elements/text exist yet.

- [ ] **Step 3: Add the empty state, restyle the bubbles, and make the input bar a pill**

In `src/renderer/src/ai/ChatPanel.tsx`, add this import alongside the existing ones at the top of the file:

```tsx
import { getSectionTheme } from '../nav/sectionThemes';
```

Add this constant right after the imports, before `export interface ChatPanelProps`:

```tsx
const SUGGESTIONS = ["What's due this week?", "Summarize today's readings", 'Add a study block'];
```

Change the transcript area (currently lines 103-167 — the `<div ref={scrollRef} ...>` and everything inside it) from:

```tsx
      <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-auto p-6">
        {messages.map((message) =>
          message.kind === 'switch-notice' ? (
            <div
              key={message.id}
              style={{ alignSelf: 'center', color: 'var(--color-text-muted)', fontSize: 13, textAlign: 'center' }}
            >
              {message.text}
            </div>
          ) : (
            <div
              key={message.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
                alignItems: message.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '70%',
              }}
            >
              <div
                style={{
                  padding: '8px 12px',
                  borderRadius: 8,
                  whiteSpace: 'pre-wrap',
                  backgroundColor: message.role === 'user' ? '#22D3EE' : 'var(--color-surface)',
                  color: message.role === 'user' ? '#ffffff' : 'var(--color-text)',
                  border: message.role === 'assistant' ? '1px solid var(--color-border)' : undefined,
                }}
              >
                {message.text}
              </div>
              {message.role === 'assistant' && message.answeredBy && (
                <div style={{ color: 'var(--color-text-muted)', fontSize: 11, marginTop: 2 }}>{message.answeredBy}</div>
              )}
            </div>
          )
        )}
        {statusLabel && <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>{statusLabel}…</div>}
        {pendingConfirm && (
          <div
            style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: 12, backgroundColor: 'var(--color-surface)' }}
          >
            <p style={{ color: 'var(--color-text)', marginBottom: 8, whiteSpace: 'pre-wrap' }}>{pendingConfirm.description}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onRespondToConfirm(true)}
                className="rounded-md px-3 py-1.5 text-sm"
                style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => onRespondToConfirm(false)}
                className="rounded-md px-3 py-1.5 text-sm"
                style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
              >
                Deny
              </button>
            </div>
          </div>
        )}
      </div>
```

to:

```tsx
      <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-auto p-6">
        {messages.length === 0 && !statusLabel && !pendingConfirm ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4">
            <div className="h-11 w-11 flex-shrink-0 rounded-xl" style={{ background: getSectionTheme('ai').gradient }} />
            <p className="text-base font-semibold" style={{ color: 'var(--color-text)' }}>
              What can I help with?
            </p>
            <div className="flex flex-wrap justify-center gap-2" style={{ maxWidth: 380 }}>
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => onInputChange(suggestion)}
                  className="rounded-full px-3.5 py-1.5 text-xs"
                  style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((message) =>
              message.kind === 'switch-notice' ? (
                <div
                  key={message.id}
                  style={{ alignSelf: 'center', color: 'var(--color-text-muted)', fontSize: 13, textAlign: 'center' }}
                >
                  {message.text}
                </div>
              ) : (
                <div
                  key={message.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
                    alignItems: message.role === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '70%',
                  }}
                >
                  <div
                    style={{
                      padding: '8px 12px',
                      borderRadius: message.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                      boxShadow: '0 2px 6px rgba(0, 0, 0, 0.15)',
                      whiteSpace: 'pre-wrap',
                      backgroundColor: message.role === 'user' ? getSectionTheme('ai').accent : 'var(--color-surface)',
                      color: message.role === 'user' ? '#ffffff' : 'var(--color-text)',
                      border: message.role === 'assistant' ? '1px solid var(--color-border)' : undefined,
                    }}
                  >
                    {message.text}
                  </div>
                  {message.role === 'assistant' && message.answeredBy && (
                    <div style={{ color: 'var(--color-text-muted)', fontSize: 11, marginTop: 2 }}>{message.answeredBy}</div>
                  )}
                </div>
              )
            )}
            {statusLabel && <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>{statusLabel}…</div>}
            {pendingConfirm && (
              <div
                style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: 12, backgroundColor: 'var(--color-surface)' }}
              >
                <p style={{ color: 'var(--color-text)', marginBottom: 8, whiteSpace: 'pre-wrap' }}>{pendingConfirm.description}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => onRespondToConfirm(true)}
                    className="rounded-md px-3 py-1.5 text-sm"
                    style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => onRespondToConfirm(false)}
                    className="rounded-md px-3 py-1.5 text-sm"
                    style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                  >
                    Deny
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
```

Now change the input form (currently lines 195-236) from:

```tsx
      <form onSubmit={onSubmit} className="flex gap-2 p-4" style={{ borderTop: '1px solid var(--color-border)' }}>
        {voiceModeOn && (
          <button
            type="button"
            onClick={onToggleRecording}
            aria-label={isRecording ? 'Stop voice input' : 'Start voice input'}
            disabled={!isRecording && sending}
            className="rounded-md px-3 py-2 text-sm"
            style={{
              backgroundColor: isRecording ? '#EF4444' : 'var(--color-surface)',
              color: isRecording ? '#ffffff' : 'var(--color-text)',
              border: '1px solid var(--color-border)',
            }}
          >
            {isRecording ? '● Stop' : '🎙'}
          </button>
        )}
        <button
          type="button"
          onClick={onAddAttachment}
          aria-label="Attach a file"
          className="rounded-md px-3 py-2 text-sm"
          style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
        >
          Attach
        </button>
        <input
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          placeholder="Ask SmartLife…"
          className="flex-1 rounded-md px-3 py-2 text-sm"
          style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="rounded-md px-4 py-2 text-sm"
          style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
        >
          Send
        </button>
      </form>
```

to:

```tsx
      <form onSubmit={onSubmit} className="p-4" style={{ borderTop: '1px solid var(--color-border)' }}>
        <div
          className="flex items-center gap-1.5 rounded-2xl px-2 py-1.5"
          style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
        >
          {voiceModeOn && (
            <button
              type="button"
              onClick={onToggleRecording}
              aria-label={isRecording ? 'Stop voice input' : 'Start voice input'}
              disabled={!isRecording && sending}
              className="flex-shrink-0 rounded-xl px-3 py-1.5 text-sm"
              style={{
                backgroundColor: isRecording ? '#EF4444' : 'transparent',
                color: isRecording ? '#ffffff' : 'var(--color-text)',
              }}
            >
              {isRecording ? '● Stop' : '🎙'}
            </button>
          )}
          <button
            type="button"
            onClick={onAddAttachment}
            aria-label="Attach a file"
            className="flex-shrink-0 rounded-xl px-2.5 py-1.5 text-sm"
            style={{ color: 'var(--color-text)' }}
          >
            Attach
          </button>
          <input
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            placeholder="Ask SmartLife…"
            className="flex-1 bg-transparent px-1 py-1.5 text-sm outline-none"
            style={{ color: 'var(--color-text)' }}
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            className="flex-shrink-0 rounded-xl px-4 py-1.5 text-sm"
            style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)' }}
          >
            Send
          </button>
        </div>
      </form>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/renderer/src/ai/ChatPanel.test.tsx`
Expected: PASS — every pre-existing test in the file, plus the 3 new empty-state tests, all green. (The attachment/voice-mode tests use `messages: []` in their own `baseProps`, which now renders the new empty state in the transcript area — but none of them query anything inside that area, so they are unaffected; verify this is actually true by reading the full green output, not just trusting this note.)

- [ ] **Step 5: Rebuild and verify visually**

```bash
pkill -9 -f "SmartLife.app" || true
npm run package
rm -rf "/Applications/SmartLife.app"
cp -R release/mac-arm64/SmartLife.app /Applications/
```

Open the AI screen with no active conversation and confirm the greeting + suggestion chips render. Click a chip and confirm it fills the input without sending. Send a message and confirm the bubble has a rounded "tail" corner and a soft shadow, and the input bar is now one pill-shaped container.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/ai/ChatPanel.tsx src/renderer/src/ai/ChatPanel.test.tsx
git commit -m "Redesign the AI chat panel: empty state, bubble tails, pill input bar

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Final Verification

After all five tasks are complete:

```bash
npm test
npm run typecheck
npm run lint
```

Expected: full suite green, clean typecheck, zero lint errors. Then do one last full pass through the packaged app — Home, AI, and the sidebar in both light and dark mode — confirming the whole shell reads as one coherent, polished look rather than three separately-redesigned pieces.
