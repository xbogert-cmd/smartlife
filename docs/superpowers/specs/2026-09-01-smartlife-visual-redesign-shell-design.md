# Visual Redesign: Shell, Home, and AI Screen — Design

## Problem

The user's own words: the app "looks kinda ugly" and they want it to read as "a well put together browser" with "design aspects of apple and other high quality websites." Two concrete complaints, both confirmed live against the packaged app:

1. **A real layout bug**: the sidebar's "Home" label overlaps the macOS traffic-light window buttons at the top-left. `src/main/index.ts:50` sets `titleBarStyle: 'hiddenInset'` with no `trafficLightPosition`, so macOS draws the traffic lights at its own default inset — but `Sidebar.tsx` reserves no space for them at all, so the nav list starts at `y: 0` and the first item's text sits directly under the dots.
2. **General visual flatness**: every screen is a single flat black (or white) surface with hard-edged, individually-boxed list rows, no icons anywhere, and the active sidebar item is a solid, saturated color block rather than anything with depth or restraint.

Confirmed with the user (via visual mockups, all approved) which specific directions to take. This spec covers only the shared shell plus two proof-of-concept screens (Home, AI) — not a full redesign of all ~10 screens in one pass.

## Scope

**In scope:**
- Sidebar (`src/renderer/src/nav/Sidebar.tsx`) and the traffic-light bug.
- New/extended design tokens (`src/renderer/src/theme/tokens.css`) that the rest of the app will inherit automatically.
- Home's due-date sections: `NeedsAttention.tsx`, `TodayPanel.tsx`, `DueSoon.tsx` (the three components rendering the "Needs attention" / "Today" / "Next 7 days" panels shown in the mockups).
- The AI screen: `ChatPanel.tsx`'s empty state, message bubbles, and input bar.

**Explicitly out of scope for this pass:**
- The other ~8 screens (Calendar, School, Browser, Tasks, Notes, Goals, Files, Search, Settings). They inherit the new color/spacing/type tokens automatically since they already read the same CSS custom properties, but their individual layouts are not being touched now.
- Home's `GradeStrip.tsx`, `TokenBanner.tsx`, and the inline Announcements section in `Home.tsx` — not shown in any approved mockup, and the user has already flagged Home as getting its own deeper follow-up pass after this one lands.
- Any change to app behavior, data, or the AI/permission-mode systems from the prior phase.

## Design tokens (`src/renderer/src/theme/tokens.css`)

Today's tokens: `--color-bg`, `--color-surface`, `--color-border`, `--color-text`, `--color-text-muted`, plus `--font-shell` (already the system font stack — no font change needed anywhere in this spec).

New tokens, added to both the `:root, [data-theme="dark"]` block and the `[data-theme="light"]` block:

- `--color-sidebar-bg` — a background one step darker/lighter than `--color-surface`, giving the sidebar its own visual layer instead of blending into the content pane. Dark: `#151517`. Light: `#f0f0f2`.
- `--color-panel-bg` — the background for a grouped panel (Home's redesigned sections). Same value as `--color-sidebar-bg` is fine to start (both are "a surface one step off the base"), kept as a separate token because they mean different things and may diverge later.
- `--color-danger` — the most-urgent overdue color. Dark: `#f87171`. Light: `#dc2626`.
- `--color-warning` — the less-urgent overdue color. Dark: `#fb923c`. Light: `#ea580c`.

`sectionThemes.ts`'s existing per-section `accent`/`gradient` registry is unchanged — the redesign changes *how* those colors are applied (a muted icon tint plus a pill on the active row, not a full solid block), not the colors themselves.

## Sidebar (`Sidebar.tsx`, `App.tsx`, `src/main/index.ts`)

**Traffic-light fix.** `src/main/index.ts`'s `BrowserWindow` constructor gets an explicit `trafficLightPosition: { x: 20, y: 20 }` instead of relying on `hiddenInset`'s OS-chosen default — this makes the offset a value the code actually knows, rather than an undocumented OS default the renderer has to guess at. `Sidebar.tsx` reserves matching top space via a `paddingTop` chosen to clear the dots with comfortable room (starting value: `44px`; the implementation step verifies this against the real packaged app via a screenshot and adjusts the pixel value if it looks off — the same way every prior phase in this project verified native/visual behavior, not by trusting the number in isolation).

**Icons.** New dependency: `lucide-react` (MIT-licensed, tree-shakeable, one icon per import). One icon per nav section, matched to `sections.ts`'s existing slugs:

| slug | icon |
|---|---|
| home | `Home` |
| ai | `Sparkles` |
| calendar | `Calendar` |
| school | `GraduationCap` |
| browser | `Globe` |
| tasks | `CheckSquare` |
| notes | `FileText` |
| goals | `Target` |
| files | `Folder` |
| search | `Search` |
| settings | `Settings` |

**Active/inactive states.** Replaces the current `backgroundColor: isActive ? theme.accent : 'transparent'` full-block treatment:
- Inactive: icon rendered at ~50% opacity of `theme.accent` (a quiet tint), label in `--color-text-muted`.
- Active: a soft pill (`background-color: ${theme.accent} at ~16% opacity`, `border-radius: 7px`) behind the row, icon at full `theme.accent` opacity, label in a lightened version of the accent (not pure white) at semibold weight.

The sidebar's own background becomes `var(--color-sidebar-bg)` with a `1px solid var(--color-border)` right edge (already present), giving it visual separation from the content pane it doesn't have today.

The existing `Ask AI` button and its `pending-confirmation-badge` red-dot indicator (`Sidebar.tsx`'s bottom `<button>`) are restyled to match the new surface tokens but keep their exact existing behavior and test coverage — this is a visual pass only, not a behavior change.

## Home (`NeedsAttention.tsx`, `TodayPanel.tsx`, `DueSoon.tsx`)

**Structural change.** Today, each of these three components renders its list as independently-boxed rows — every `<li>` gets its own `rounded-lg` + `1px solid var(--color-border)` box. The redesign moves the border/rounding to the **section** instead: one `var(--color-panel-bg)` panel per section, with the existing `<h2>` heading now living *inside* the panel as its header row (separated by a `1px` bottom border), and each item below it separated from its neighbor by a hairline (`1px solid var(--color-border)`) rather than each being its own box.

**Urgency coloring.** Today, `NeedsAttention`'s row renders `formatDue(item.dueAt)` in a single fixed color (`SCHOOL_ACCENT`) regardless of how overdue something is. New: a small pure helper, `overdueSeverity(dueAt: string, now: Date = new Date()): 'critical' | 'moderate'`, colocated with `formatDue` in `src/renderer/src/school/formatters.ts` — `'critical'` for anything under 2 days overdue, `'moderate'` otherwise. `NeedsAttention.tsx` maps that to `var(--color-danger)` / `var(--color-warning)` for both the row's leading dot and its trailing due-text color (replacing the single fixed `SCHOOL_ACCENT`). `TodayPanel.tsx` and `DueSoon.tsx` are restyled to the same panel/hairline visual language for consistency within the screen, but their own due-text coloring is unchanged (`DueSoon` already dims a submitted item; `TodayPanel` has no overdue concept at all, since "Today" items are due today, not overdue).

**`Home.tsx`** itself changes only in that the section-to-section vertical gap and heading treatment now come for free from each subcomponent's own panel styling — no structural change to `Home.tsx` other than possibly trimming a now-redundant heading style if one turns out to be duplicated.

## AI screen (`ChatPanel.tsx`)

**Empty state.** Currently: nothing renders until the first message — a flat black rectangle. New: centered small gradient mark (a `44px` rounded-square div using `linear-gradient(135deg, var(--color-...))` — reusing the `ai` section's own accent/gradient from `sectionThemes.ts` rather than inventing new colors), a "What can I help with?" heading, and 3 tappable suggestion chips with static, generic starter prompts (e.g. "What's due this week?", "Summarize today's readings", "Add a study block") that populate the input field on click but do not auto-send — the user still presses Send, consistent with this app's confirm-before-write posture elsewhere.

**Message bubbles.** Currently: `border-radius` is uniform on all four corners, flat `#22D3EE`/`var(--color-surface)` fill, no shadow. New: a "tail" corner (`border-radius: 16px 16px 4px 16px` for the user's right-aligned bubble, mirrored for the assistant's left-aligned one), a subtle `box-shadow`, and the existing `answeredBy` caption (`ChatPanel.tsx:135`) restyled smaller/muted underneath the bubble rather than wherever it renders today — its underlying logic and test coverage are unchanged.

**Input bar.** Currently a plain rectangular row of a text input, attach button, and Send button. New: the whole row becomes a single pill-shaped container (`border-radius: 14px`) that the input, attach, and send controls sit inside, matching the mockup. No change to the existing attach/send handlers or their tests.

**Model picker / Voice mode buttons** (top of the panel) get corner-radius and spacing adjustments to match the new pill/panel language elsewhere, no functional change.

## Testing

- Pure new logic (`overdueSeverity`) gets its own unit tests: boundary cases at exactly 2 days overdue, 1 minute overdue, and far in the past.
- Existing component tests for `Sidebar.tsx`, `NeedsAttention.tsx`, `TodayPanel.tsx`, `DueSoon.tsx`, and `ChatPanel.tsx` continue to assert behavior (which route is active, which items render, which handlers fire) — visual-only changes (colors, border-radius, padding) are not usually asserted on directly in this codebase's existing tests and won't need new assertions purely for styling. Any test that currently asserts on now-removed per-row `border`/`rounded-lg` classes will need updating to match the new panel-level styling.
- After implementation, rebuild the packaged app (`npm run package`) and screenshot Home, AI, and the sidebar in both light and dark mode to confirm the traffic-light fix and overall look before considering the phase done — this project's established verification method for anything visual or native, not something a test suite alone can confirm.

## Out of scope, explicitly

- Redesigning Calendar, School, Browser, Tasks, Notes, Goals, Files, Search, or Settings layouts.
- `GradeStrip`, `TokenBanner`, and Home's Announcements section.
- Any change to AI permission modes, tool behavior, or data.
- A deeper Home-screen redesign pass — the user has already indicated this is coming next, as its own follow-up after this phase ships.
