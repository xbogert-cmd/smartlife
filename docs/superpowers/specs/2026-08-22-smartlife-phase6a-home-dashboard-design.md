# Phase 6a: Home Dashboard — Design

**Date:** 2026-08-22
**Depends on:** Phase 1 (shell, routing, IPC), Phase 3 (Canvas read),
Phase 4 (Google Calendar)
**Status:** approved, not yet planned

## Goal

Make the Home route answer one question the moment the app opens: *what do I
need to deal with today?* Today it renders a greeting and the sentence
"Nothing wired up yet — start with Settings," which has been false since
Phase 3 shipped.

## Why this is its own phase, not part of Phase 6

The roadmap's Phase 6 (Planner) bundles a unified task system, a work
schedule, a smart scheduler, and a Today briefing. Three of those four need
things that do not exist yet, and one of them (the class schedule) depends on
Phase 4b, which is blocked on university IT approval.

The Home dashboard needs none of that. Every value it displays is already
synced into the local database and already exposed over IPC. It is a
composition over shipped data, so it ships now rather than waiting behind a
blocked dependency.

## What makes Home different from School and Calendar

If Home simply repeated School's due-soon list and grade strip, it would earn
nothing. The distinction is **cross-domain and time-anchored**:

| Route | Answers |
|---|---|
| School | "How am I doing in my courses, and what's in them?" |
| Calendar | "What does my week look like?" |
| **Home** | **"What is happening today, and what have I missed?"** |

Home is the only surface that merges Canvas due dates and Google Calendar
events into a single time-ordered list, and the only one that surfaces
assignments whose due date has already passed.

## Scope

### In

- A merged **Today** agenda: today's calendar events and today's assignment
  due times, interleaved in chronological order
- A **Needs attention** section: assignments that are past due and not
  submitted, which no existing surface shows at all
- **Next 7 days** of upcoming assignments
- **Courses** with current grades (reusing the existing `GradeStrip`)
- **Announcements**, compact — title, course, and age only
- Per-source connection and staleness handling, so a disconnected Canvas or
  Google account degrades to a prompt rather than an empty section
- One combined refresh control

### Out

- Any AI-generated briefing or summary. It would spend tokens on every visit
  to Home, and the assistant dock is one click away. Phase 6 owns this.
- Tasks, notes, goals, work schedule — Phases 6 and 7 own these.
- Open browser tabs. Not time-anchored, and the browser route already lists
  them.
- Any write action. Home links to the surfaces that own each write; it
  performs none itself.
- Drag-to-reschedule, dismissal, or any per-card state. No persistence means
  no migration in this phase.

## Global Constraints

- Run tests with `npm test` (sets `ELECTRON_RUN_AS_NODE=1`), never
  `npx vitest run` — system Node breaks `better-sqlite3`'s native ABI and
  produces ~200 bogus failures.
- `npm run typecheck` must pass; it is not optional and vitest does not
  cover it.
- No new database migration. This phase adds no tables and no columns.
- Local dates only. Use `toDateKey`/`parseAllDayDate` from
  `src/renderer/src/calendar/layout.ts` — `toISOString().slice(0, 10)`
  returns the *UTC* date and files an 8pm event under tomorrow.
- Reuse before rebuilding: `GradeStrip`, `DueSoon`, `formatDue`,
  `formatRelative`, `formatEventTime`, `toDateKey`, `eventDayKeys`,
  `classifySubmission` all exist and are tested.
- Home must never render a wall of empty sections. A section with nothing in
  it either states that plainly in one line or does not render.

## External setup

None. No new account, key, scope, or permission. Every data source this
phase reads was connected in an earlier phase.

## Architecture

### Data flow

Everything Home needs is already on the IPC surface except one query:

| Data | Existing IPC | Status |
|---|---|---|
| Canvas connection/staleness | `canvas:get-status` | exists |
| Upcoming assignments | `canvas:get-upcoming(days)` | exists |
| Course grades | `canvas:get-grades` | exists |
| Announcements | `canvas:get-announcements(limit)` | exists |
| Calendar connection | `calendar:get-status` | exists |
| Calendar events in a range | `calendar:get-events(from, to)` | exists |
| **Past-due assignments** | — | **new** |

### The one new query: past due

`getUpcomingAssignments` filters `due_at >= now`, so an assignment whose
deadline passed while unsubmitted disappears from every surface in the app.
For a student dashboard that is the single most important thing to show.

`getOverdueAssignments(db, days, now)` returns rows where `due_at` is between
`now - days` and `now`, and `has_submitted = 0`.

**It excludes assignments with nothing to submit.** 24% of the user's
current-semester assignments are `submission_types: ["none"]` — attendance
rows, in-class participation, gradebook placeholders. Without this filter
"Needs attention" would be mostly noise. The filter reuses the existing pure
`classifySubmission` in `src/main/canvas/submission.ts` and drops rows whose
resolved path is `{ kind: 'none' }`. Handoff kinds (`external_tool`, quizzes)
are *kept* — a missed Financial Accounting lab is exactly what this section
exists to surface.

Filtering happens in the main process after the query rather than in SQL,
because `submission_types` is a stored JSON array and the classifier already
encodes every rule about how to read it.

### Merging the Today agenda

`src/renderer/src/home/timeline.ts` is a pure module with no React and no
IPC, matching the pattern of `calendar/layout.ts` and `school/formatters.ts`.

```ts
export type TodayItem =
  | { kind: 'event'; at: Date; allDay: boolean; event: CalendarEvent }
  | { kind: 'due'; at: Date; assignment: UpcomingAssignment };

export function buildToday(
  events: CalendarEvent[],
  assignments: UpcomingAssignment[],
  now: Date
): TodayItem[];
```

Rules the pure module owns, so they are testable without a DOM:

1. Only items whose local date key equals today's are included. All-day
   events use `eventDayKeys`, which handles Google's exclusive end date.
2. All-day events sort first, then everything else by timestamp ascending.
3. Ties between an event and a due time at the same instant put the event
   first — a class you have to attend outranks a deadline you can meet from
   anywhere.
4. Already-submitted assignments still appear, marked submitted. Removing
   them would make a finished day look empty rather than finished.

### Section order

Ordered by how urgently the user must act, not by data source:

1. **Header** — greeting, today's full date, combined refresh
2. **Needs attention** — past due and unsubmitted. Renders only when
   non-empty; an empty state here would be a daily false alarm about nothing.
3. **Today** — the merged agenda
4. **Next 7 days** — upcoming assignments
5. **Courses** — grades
6. **Announcements** — three most recent, compact

### Reusing `DueSoon`

`DueSoon` already renders exactly what "Next 7 days" needs. It gains two
optional props, `title` and `emptyText`, both defaulting to today's literal
strings so School renders byte-identically. No new component.

### Degradation

Each source is independent, so one disconnected account never blanks the
page:

- **Neither Canvas nor Google connected** — Home renders the greeting and a
  single prompt pointing at Settings. This is the current behavior and the
  only case where it is still correct.
- **One connected** — that source's sections render; the other contributes
  one muted line offering to connect it.
- **Connected but never synced** — sections render their own empty states.
  The header's staleness line carries the "last synced" fact.
- **Canvas token invalid or expiring** — reuse `TokenBanner`, which already
  handles both and is already wired to the same status object.

### Refresh

One control in the header refreshes both sources. It calls
`canvas.syncNow()` and `calendar.syncNow()` and tolerates either failing
independently: a Google outage must not block a Canvas refresh. Failures are
not modal — the staleness line already tells the truth about what the user is
looking at.

Home subscribes to both `canvas:sync-changed` and `calendar:sync-changed`, so
a background sync repaints it without a visit to another route.

## Error handling

- Every IPC read is wrapped; a rejection leaves that section's data empty
  rather than throwing through the route.
- A malformed or unparseable `dueAt`/`startAt` drops that one item from the
  agenda rather than corrupting the sort. `Date.parse` returning `NaN` is
  checked explicitly in `timeline.ts`.
- Sync failures are silent in the UI beyond the staleness line, matching how
  School and Calendar already behave.

## Testing

- `timeline.ts` gets pure unit tests: local-date boundaries (an 11pm event
  and a 12:30am one), all-day ordering, event-before-due ties, `NaN`
  timestamps, and Google's exclusive all-day end date.
- `getOverdueAssignments` gets DB tests against an in-memory schema, covering
  the window bounds, the `has_submitted` filter, and — most importantly — that
  a `["none"]` assignment is excluded while an `["external_tool"]` one is kept.
- Route tests cover all four degradation states and confirm that a section
  with no data never renders an empty shell.
- Component tests assert rendered text, not mock call counts.

## Deferred

- Two-column layout on wide windows. Single column matches every other route
  and reads correctly at every width the dock leaves behind.
- Dismissing or snoozing a "needs attention" item — that is per-card state,
  which means persistence, which means a migration this phase does not need.
- An AI "here's your day" briefing. Phase 6.
- Surfacing Canvas announcements' body text on Home. School shows the full
  sanitized HTML; Home shows the headline and links there.
