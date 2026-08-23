# Phase 6a: Home Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Home's "Nothing wired up yet" placeholder with a today-first
dashboard that merges Canvas due dates and Google Calendar events, and surfaces
past-due assignments that no existing surface shows.

**Architecture:** One new main-process query (`getOverdueAssignments`) plus one
IPC handler; everything else is renderer-side composition over IPC that already
exists. Merge logic lives in a pure, React-free module so the date-boundary
rules are testable without a DOM.

**Tech Stack:** Electron 33, React 18, react-router-dom v6 (MemoryRouter),
better-sqlite3, Vitest + @testing-library/react, Tailwind utility classes with
CSS-variable colors.

## Global Constraints

- Run tests with `npm test` — it sets `ELECTRON_RUN_AS_NODE=1` and uses
  Electron's bundled Node, matching `better-sqlite3`'s compiled ABI. **Never
  `npx vitest run`**: system Node breaks the native ABI and produces ~200
  bogus failures.
- `npm run typecheck` must pass on every task. Vitest does not typecheck;
  a task is not done until `tsc` is clean.
- No database migration. This phase adds no tables and no columns.
- Local dates only: use `toDateKey` / `parseAllDayDate` from
  `src/renderer/src/calendar/layout.ts`. Never `toISOString().slice(0, 10)` —
  it returns the UTC date and files an 8pm event under tomorrow.
- Colors come from CSS variables (`var(--color-text)`, `var(--color-surface)`,
  `var(--color-border)`, `var(--color-text-muted)`) plus the existing
  `SCHOOL_ACCENT` / `CALENDAR_ACCENT` constants. No new hex literals.
- Tests assert rendered text or returned values, never mock call counts alone.
- `src/renderer/src/theme/ThemeProvider.test.tsx` fails intermittently (~2/30
  runs) under parallel workers due to jsdom `matchMedia` timing. It is
  pre-existing and unrelated to this phase. Confirm in isolation before
  reporting it.

---

### Task 1: Past-due assignment query

**Files:**
- Modify: `src/main/canvas/queries.ts`
- Test: `src/main/canvas/queries.test.ts`

**Interfaces:**
- Consumes: `classifySubmission` from `./submission` (already imported in
  `queries.ts`), `UpcomingAssignment` (already exported from `queries.ts`),
  `MS_PER_DAY` (already a module constant).
- Produces: `getOverdueAssignments(db, days, now?): UpcomingAssignment[]`,
  consumed by Task 2.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/canvas/queries.test.ts`. Add `getOverdueAssignments` to the
existing import block from `./queries` at the top of the file.

```ts
describe('getOverdueAssignments', () => {
  const NOW = new Date('2026-08-22T12:00:00.000Z');

  function seed(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    db.prepare("insert into canvas_courses (id, name) values (1, 'Financial Accounting')").run();
    const insert = db.prepare(
      `insert into canvas_assignments (id, course_id, name, due_at, submission_types, has_submitted)
       values (?, 1, ?, ?, ?, ?)`
    );
    // Two days late, unsubmitted, real upload -> the case this exists for.
    insert.run(10, 'Missed upload', '2026-08-20T04:00:00Z', '["online_upload"]', 0);
    // Two days late but already submitted -> not overdue.
    insert.run(11, 'Turned in late', '2026-08-20T04:00:00Z', '["online_upload"]', 1);
    // Two days late, nothing to submit -> noise, must be excluded.
    insert.run(12, 'Attendance 8/20', '2026-08-20T04:00:00Z', '["none"]', 0);
    // Two days late, LTI tool -> still the user's problem, must be kept.
    insert.run(13, 'Connect homework', '2026-08-20T04:00:00Z', '["external_tool"]', 0);
    // Due in the future -> not overdue.
    insert.run(14, 'Next week', '2026-08-29T04:00:00Z', '["online_upload"]', 0);
    // 40 days late -> outside a 14-day window.
    insert.run(15, 'Ancient history', '2026-07-13T04:00:00Z', '["online_upload"]', 0);
    // No due date at all -> never overdue.
    insert.run(16, 'Undated', null, '["online_upload"]', 0);
    return db;
  }

  it('returns unsubmitted assignments whose due date has passed', () => {
    const rows = getOverdueAssignments(seed(), 14, NOW);
    expect(rows.map((row) => row.id)).toContain(10);
  });

  it('excludes assignments that were already submitted', () => {
    const rows = getOverdueAssignments(seed(), 14, NOW);
    expect(rows.map((row) => row.id)).not.toContain(11);
  });

  it('excludes assignments with nothing to submit', () => {
    // ~24% of a real semester is submission_types ["none"] -- attendance and
    // gradebook placeholders. Without this filter the section is all noise.
    const rows = getOverdueAssignments(seed(), 14, NOW);
    expect(rows.map((row) => row.id)).not.toContain(12);
  });

  it('keeps external_tool assignments, which the user still has to go do', () => {
    const rows = getOverdueAssignments(seed(), 14, NOW);
    expect(rows.map((row) => row.id)).toContain(13);
  });

  it('excludes assignments that are not due yet', () => {
    const rows = getOverdueAssignments(seed(), 14, NOW);
    expect(rows.map((row) => row.id)).not.toContain(14);
  });

  it('excludes assignments older than the window', () => {
    const rows = getOverdueAssignments(seed(), 14, NOW);
    expect(rows.map((row) => row.id)).not.toContain(15);
  });

  it('excludes assignments with no due date', () => {
    const rows = getOverdueAssignments(seed(), 14, NOW);
    expect(rows.map((row) => row.id)).not.toContain(16);
  });

  it('orders the most recently missed first', () => {
    const db = seed();
    db.prepare(
      `insert into canvas_assignments (id, course_id, name, due_at, submission_types, has_submitted)
       values (17, 1, 'Missed yesterday', '2026-08-21T04:00:00Z', '["online_upload"]', 0)`
    ).run();
    const rows = getOverdueAssignments(db, 14, NOW);
    expect(rows[0].id).toBe(17);
  });

  it('resolves the course name', () => {
    const rows = getOverdueAssignments(seed(), 14, NOW);
    expect(rows[0].courseName).toBe('Financial Accounting');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/main/canvas/queries.test.ts`
Expected: FAIL — `getOverdueAssignments is not a function` (or an import error).

- [ ] **Step 3: Implement the query**

Add to `src/main/canvas/queries.ts`, directly below `getUpcomingAssignments`:

```ts
/**
 * Assignments whose due date has passed without a submission.
 *
 * getUpcomingAssignments only looks forward (`due_at >= now`), so a missed
 * deadline disappears from every surface in the app. This is the query that
 * puts it back.
 *
 * Rows with nothing to submit are dropped: roughly a quarter of a real
 * semester is submission_types ["none"] -- attendance rows, participation,
 * gradebook placeholders -- and a "needs attention" list full of them is
 * noise the user learns to ignore.
 */
export function getOverdueAssignments(
  db: Database.Database,
  days: number,
  now: Date = new Date()
): UpcomingAssignment[] {
  const from = new Date(now.getTime() - days * MS_PER_DAY).toISOString();
  const to = now.toISOString();
  const rows = db
    .prepare(
      `select a.id, a.course_id, c.name as course_name, a.name, a.due_at,
              a.points_possible, a.has_submitted, a.html_url, a.submission_types
       from canvas_assignments a
       join canvas_courses c on c.id = a.course_id
       where a.due_at is not null and a.due_at >= ? and a.due_at < ?
         and a.has_submitted = 0
       order by a.due_at desc, a.id`
    )
    .all(from, to) as Array<{
    id: number;
    course_id: number;
    course_name: string;
    name: string;
    due_at: string;
    points_possible: number | null;
    has_submitted: number;
    html_url: string | null;
    submission_types: string | null;
  }>;

  return rows
    // The topic id is irrelevant here: every path except 'none' means there is
    // something to hand in, and that is the only question being asked.
    .filter((row) => classifySubmission(row.submission_types, null).kind !== 'none')
    .map((row) => ({
      id: row.id,
      courseId: row.course_id,
      courseName: row.course_name,
      name: row.name,
      dueAt: row.due_at,
      pointsPossible: row.points_possible,
      hasSubmitted: row.has_submitted === 1,
      htmlUrl: row.html_url,
    }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/main/canvas/queries.test.ts`
Expected: PASS, all 9 new tests plus the existing ones.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean, no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/main/canvas/queries.ts src/main/canvas/queries.test.ts
git commit -m "Add a past-due assignment query for the Home dashboard"
```

---

### Task 2: Expose past-due over IPC

**Files:**
- Modify: `src/main/canvas/ipc.ts`
- Modify: `src/preload/index.ts`
- Test: `src/main/canvas/ipc.test.ts`

**Interfaces:**
- Consumes: `getOverdueAssignments` from Task 1.
- Produces: IPC channel `canvas:get-overdue` taking `days: number`, and
  `window.smartlife.canvas.getOverdue(days)` in the preload bridge. Consumed
  by Task 4.

- [ ] **Step 1: Write the failing test**

Append to `src/main/canvas/ipc.test.ts`, following that file's existing
handler-registration pattern (read the top of the file for how it captures
`ipcMain.handle` registrations and how it builds its test database — reuse
that harness exactly rather than inventing a second one).

```ts
it('registers canvas:get-overdue and returns past-due assignments', async () => {
  const handler = handlers['canvas:get-overdue'];
  expect(handler).toBeTypeOf('function');

  db.prepare("insert into canvas_courses (id, name) values (7, 'Weather and Climate')").run();
  db.prepare(
    `insert into canvas_assignments (id, course_id, name, due_at, submission_types, has_submitted)
     values (70, 7, 'Lab 3', ?, '["online_upload"]', 0)`
  ).run(new Date(Date.now() - 2 * 86_400_000).toISOString());

  const rows = (await handler({}, 14)) as Array<{ id: number; name: string }>;
  expect(rows.map((row) => row.name)).toContain('Lab 3');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/main/canvas/ipc.test.ts`
Expected: FAIL — `expect(handler).toBeTypeOf('function')` fails because the
channel is not registered.

- [ ] **Step 3: Register the handler**

In `src/main/canvas/ipc.ts`, add `getOverdueAssignments` to the existing
import block from `./queries`, then add this line directly beneath the
existing `canvas:get-upcoming` registration:

```ts
  ipcMain.handle('canvas:get-overdue', (_event, days: number) => getOverdueAssignments(db, days));
```

- [ ] **Step 4: Add the preload method**

In `src/preload/index.ts`, inside the `canvas` object, directly beneath
`getUpcoming`:

```ts
    getOverdue: (days: number): Promise<unknown[]> => ipcRenderer.invoke('canvas:get-overdue', days),
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -- src/main/canvas/ipc.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/canvas/ipc.ts src/main/canvas/ipc.test.ts src/preload/index.ts
git commit -m "Expose past-due assignments over IPC"
```

---

### Task 3: Pure today-agenda merge

**Files:**
- Create: `src/renderer/src/home/timeline.ts`
- Test: `src/renderer/src/home/timeline.test.ts`

**Interfaces:**
- Consumes: `eventDayKeys`, `parseAllDayDate`, `toDateKey` from
  `../calendar/layout`; `CalendarEvent` from `../calendar/types`;
  `UpcomingAssignment` from `../school/types`.
- Produces: `TodayItem` union and `buildToday(events, assignments, now?)`,
  consumed by Tasks 5 and 7.

This module must not import React and must not touch `window`.

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/home/timeline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildToday } from './timeline';
import type { CalendarEvent } from '../calendar/types';
import type { UpcomingAssignment } from '../school/types';

// Local noon, so nothing in these fixtures straddles a UTC date boundary by
// accident and hides a real bug.
const NOW = new Date(2026, 7, 22, 12, 0, 0);

function event(overrides: Partial<CalendarEvent> & { startAt: string; endAt: string }): CalendarEvent {
  return {
    calendarId: 'primary',
    id: 'e1',
    summary: 'Event',
    description: null,
    location: null,
    isAllDay: false,
    htmlLink: null,
    hasGuests: false,
    guestCount: 0,
    etag: null,
    ...overrides,
  };
}

function assignment(overrides: Partial<UpcomingAssignment> & { dueAt: string }): UpcomingAssignment {
  return {
    id: 1,
    courseId: 1,
    courseName: 'Course',
    name: 'Assignment',
    pointsPossible: 10,
    hasSubmitted: false,
    htmlUrl: null,
    ...overrides,
  };
}

function iso(hour: number, minute = 0, day = 22): string {
  return new Date(2026, 7, day, hour, minute, 0).toISOString();
}

describe('buildToday', () => {
  it('includes a timed event happening today', () => {
    const items = buildToday([event({ id: 'a', summary: 'Lecture', startAt: iso(14), endAt: iso(15) })], [], NOW);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('event');
  });

  it('includes an assignment due today', () => {
    const items = buildToday([], [assignment({ dueAt: iso(23, 59) })], NOW);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('due');
  });

  it('excludes an event on another day', () => {
    const items = buildToday([event({ startAt: iso(14, 0, 23), endAt: iso(15, 0, 23) })], [], NOW);
    expect(items).toHaveLength(0);
  });

  it('excludes an assignment due on another day', () => {
    const items = buildToday([], [assignment({ dueAt: iso(9, 0, 21) })], NOW);
    expect(items).toHaveLength(0);
  });

  it('keeps a late-evening event on today, not tomorrow', () => {
    // The UTC date of an 11pm local timestamp west of Greenwich is already
    // tomorrow. Using the UTC date here would drop this item.
    const items = buildToday([event({ startAt: iso(23, 30), endAt: iso(23, 45) })], [], NOW);
    expect(items).toHaveLength(1);
  });

  it('keeps a just-after-midnight event on today', () => {
    const items = buildToday([event({ startAt: iso(0, 15), endAt: iso(1, 0) })], [], NOW);
    expect(items).toHaveLength(1);
  });

  it('sorts by time ascending', () => {
    const items = buildToday(
      [
        event({ id: 'late', summary: 'Late', startAt: iso(16), endAt: iso(17) }),
        event({ id: 'early', summary: 'Early', startAt: iso(9), endAt: iso(10) }),
      ],
      [],
      NOW
    );
    expect(items.map((item) => (item.kind === 'event' ? item.event.summary : null))).toEqual(['Early', 'Late']);
  });

  it('puts all-day events before timed ones', () => {
    const items = buildToday(
      [
        event({ id: 'timed', summary: 'Timed', startAt: iso(8), endAt: iso(9) }),
        event({ id: 'allday', summary: 'Holiday', isAllDay: true, startAt: '2026-08-22', endAt: '2026-08-23' }),
      ],
      [],
      NOW
    );
    expect(items.map((item) => (item.kind === 'event' ? item.event.summary : null))).toEqual(['Holiday', 'Timed']);
  });

  it("respects Google's exclusive all-day end date", () => {
    // An all-day event on the 21st ends on the 22nd. It is NOT a 22nd event.
    const items = buildToday(
      [event({ isAllDay: true, startAt: '2026-08-21', endAt: '2026-08-22' })],
      [],
      NOW
    );
    expect(items).toHaveLength(0);
  });

  it('puts an event before a due time at the same instant', () => {
    const at = iso(15);
    const items = buildToday([event({ startAt: at, endAt: iso(16) })], [assignment({ dueAt: at })], NOW);
    expect(items.map((item) => item.kind)).toEqual(['event', 'due']);
  });

  it('drops an item with an unparseable timestamp instead of corrupting the sort', () => {
    const items = buildToday(
      [event({ startAt: 'not a date', endAt: 'not a date' })],
      [assignment({ dueAt: 'also not a date' })],
      NOW
    );
    expect(items).toHaveLength(0);
  });

  it('keeps a submitted assignment, marked as submitted', () => {
    // Removing it would make a finished day look empty rather than finished.
    const items = buildToday([], [assignment({ dueAt: iso(17), hasSubmitted: true })], NOW);
    expect(items).toHaveLength(1);
    expect(items[0].kind === 'due' && items[0].assignment.hasSubmitted).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/renderer/src/home/timeline.test.ts`
Expected: FAIL — `Failed to resolve import "./timeline"`.

- [ ] **Step 3: Implement the module**

Create `src/renderer/src/home/timeline.ts`:

```ts
import { eventDayKeys, parseAllDayDate, toDateKey } from '../calendar/layout';
import type { CalendarEvent } from '../calendar/types';
import type { UpcomingAssignment } from '../school/types';

/**
 * One line of the Home agenda. `at` is epoch milliseconds -- local midnight
 * for an all-day event, the start instant otherwise -- so sorting never has
 * to reason about two different date shapes.
 */
export type TodayItem =
  | { kind: 'event'; at: number; allDay: boolean; event: CalendarEvent }
  | { kind: 'due'; at: number; assignment: UpcomingAssignment };

function rank(item: TodayItem): number {
  // All-day events have no meaningful time of day, so they head the list
  // rather than sorting to local midnight among the early-morning items.
  return item.kind === 'event' && item.allDay ? 0 : 1;
}

function compare(a: TodayItem, b: TodayItem): number {
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  if (a.at !== b.at) return a.at - b.at;
  // A class you have to be at outranks a deadline you can meet from anywhere.
  if (a.kind !== b.kind) return a.kind === 'event' ? -1 : 1;
  return 0;
}

/**
 * Today's calendar events and assignment due times, interleaved in the order
 * they happen. The only surface in the app that shows both together.
 */
export function buildToday(
  events: CalendarEvent[],
  assignments: UpcomingAssignment[],
  now: Date = new Date()
): TodayItem[] {
  const today = toDateKey(now);
  const items: TodayItem[] = [];

  for (const event of events) {
    if (!eventDayKeys(event).includes(today)) continue;
    const at = event.isAllDay ? parseAllDayDate(event.startAt).getTime() : Date.parse(event.startAt);
    if (Number.isNaN(at)) continue;
    items.push({ kind: 'event', at, allDay: event.isAllDay, event });
  }

  for (const assignment of assignments) {
    const at = Date.parse(assignment.dueAt);
    if (Number.isNaN(at)) continue;
    if (toDateKey(new Date(at)) !== today) continue;
    items.push({ kind: 'due', at, assignment });
  }

  return items.sort(compare);
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -- src/renderer/src/home/timeline.test.ts && npm run typecheck`
Expected: PASS (13 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/home/timeline.ts src/renderer/src/home/timeline.test.ts
git commit -m "Add the pure today-agenda merge for the Home dashboard"
```

---

### Task 4: The `useHome` data hook

**Files:**
- Create: `src/renderer/src/home/useHome.ts`
- Test: `src/renderer/src/home/useHome.test.ts`

**Interfaces:**
- Consumes: `window.smartlife.canvas.{getStatus,getUpcoming,getOverdue,getGrades,getAnnouncements,syncNow,onSyncChanged}`
  and `window.smartlife.calendar.{getStatus,getEvents,syncNow,onSyncChanged}`;
  `toDateKey` from `../calendar/layout`.
- Produces: `useHome(): HomeState`, consumed by Task 7.

Follow the shape of `src/renderer/src/school/useCanvas.ts` — same
load-once-then-subscribe structure, same `refresh` semantics.

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/home/useHome.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useHome } from './useHome';

const canvas = {
  getStatus: vi.fn(),
  getUpcoming: vi.fn(),
  getOverdue: vi.fn(),
  getGrades: vi.fn(),
  getAnnouncements: vi.fn(),
  syncNow: vi.fn(),
  onSyncChanged: vi.fn(() => () => {}),
};
const calendar = {
  getStatus: vi.fn(),
  getEvents: vi.fn(),
  syncNow: vi.fn(),
  onSyncChanged: vi.fn(() => () => {}),
};

beforeEach(() => {
  vi.clearAllMocks();
  canvas.getStatus.mockResolvedValue({ tokenConfigured: true, baseUrlConfigured: true });
  canvas.getUpcoming.mockResolvedValue([{ id: 1, name: 'Essay' }]);
  canvas.getOverdue.mockResolvedValue([{ id: 2, name: 'Missed lab' }]);
  canvas.getGrades.mockResolvedValue([{ id: 3, name: 'Accounting' }]);
  canvas.getAnnouncements.mockResolvedValue([{ id: 4, title: 'Class cancelled' }]);
  canvas.syncNow.mockResolvedValue({});
  calendar.getStatus.mockResolvedValue({ connected: true });
  calendar.getEvents.mockResolvedValue([{ id: 'e1', summary: 'Lecture' }]);
  calendar.syncNow.mockResolvedValue({});
  canvas.onSyncChanged.mockReturnValue(() => {});
  calendar.onSyncChanged.mockReturnValue(() => {});
  (globalThis as unknown as { window: unknown }).window = globalThis.window;
  Object.defineProperty(globalThis.window, 'smartlife', {
    configurable: true,
    value: { canvas, calendar },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useHome', () => {
  it('loads every source and reports loaded', async () => {
    const { result } = renderHook(() => useHome());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.upcoming).toHaveLength(1);
    expect(result.current.overdue).toHaveLength(1);
    expect(result.current.grades).toHaveLength(1);
    expect(result.current.announcements).toHaveLength(1);
    expect(result.current.events).toHaveLength(1);
  });

  it("asks the calendar for today's date on both ends of the range", async () => {
    const { result } = renderHook(() => useHome());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const [from, to] = calendar.getEvents.mock.calls[0];
    expect(from).toBe(to);
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('still loads Canvas data when the calendar read rejects', async () => {
    // One disconnected account must never blank the whole dashboard.
    calendar.getEvents.mockRejectedValue(new Error('not connected'));
    const { result } = renderHook(() => useHome());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.upcoming).toHaveLength(1);
    expect(result.current.events).toEqual([]);
  });

  it('still loads calendar data when a Canvas read rejects', async () => {
    canvas.getOverdue.mockRejectedValue(new Error('no token'));
    const { result } = renderHook(() => useHome());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.overdue).toEqual([]);
    expect(result.current.events).toHaveLength(1);
  });

  it('refreshes both sources and reloads', async () => {
    const { result } = renderHook(() => useHome());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      await result.current.refresh();
    });
    expect(canvas.syncNow).toHaveBeenCalled();
    expect(calendar.syncNow).toHaveBeenCalled();
    expect(canvas.getUpcoming.mock.calls.length).toBeGreaterThan(1);
  });

  it('completes a refresh even when one sync fails', async () => {
    // A Google outage must not block a Canvas refresh.
    calendar.syncNow.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useHome());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      await result.current.refresh();
    });
    expect(canvas.syncNow).toHaveBeenCalled();
    expect(result.current.refreshing).toBe(false);
  });

  it('subscribes to both sync-changed channels', async () => {
    const { result } = renderHook(() => useHome());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(canvas.onSyncChanged).toHaveBeenCalled();
    expect(calendar.onSyncChanged).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/renderer/src/home/useHome.test.ts`
Expected: FAIL — `Failed to resolve import "./useHome"`.

- [ ] **Step 3: Implement the hook**

Create `src/renderer/src/home/useHome.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import { toDateKey } from '../calendar/layout';
import type { CalendarEvent, CalendarStatus } from '../calendar/types';
import type {
  AnnouncementRow,
  CanvasSyncStatus,
  CourseGrade,
  UpcomingAssignment,
} from '../school/types';

const UPCOMING_DAYS = 7;
const OVERDUE_DAYS = 14;
const ANNOUNCEMENT_LIMIT = 3;

export interface HomeState {
  canvasStatus: CanvasSyncStatus | null;
  calendarStatus: CalendarStatus | null;
  upcoming: UpcomingAssignment[];
  overdue: UpcomingAssignment[];
  grades: CourseGrade[];
  announcements: AnnouncementRow[];
  events: CalendarEvent[];
  loaded: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
}

/**
 * Each source resolves independently: a disconnected Google account must
 * leave the Canvas half of the dashboard intact, and vice versa.
 */
async function safeRead<T>(read: () => Promise<unknown>, fallback: T): Promise<T> {
  try {
    return (await read()) as T;
  } catch {
    return fallback;
  }
}

export function useHome(): HomeState {
  const [canvasStatus, setCanvasStatus] = useState<CanvasSyncStatus | null>(null);
  const [calendarStatus, setCalendarStatus] = useState<CalendarStatus | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingAssignment[]>([]);
  const [overdue, setOverdue] = useState<UpcomingAssignment[]>([]);
  const [grades, setGrades] = useState<CourseGrade[]>([]);
  const [announcements, setAnnouncements] = useState<AnnouncementRow[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    // Resolved per load, not per mount: an app left open overnight should
    // roll over to the new day on its next sync, not keep showing yesterday.
    const today = toDateKey(new Date());
    const api = window.smartlife;

    const [
      nextCanvasStatus,
      nextCalendarStatus,
      nextUpcoming,
      nextOverdue,
      nextGrades,
      nextAnnouncements,
      nextEvents,
    ] = await Promise.all([
      safeRead<CanvasSyncStatus | null>(() => api.canvas.getStatus(), null),
      safeRead<CalendarStatus | null>(() => api.calendar.getStatus(), null),
      safeRead<UpcomingAssignment[]>(() => api.canvas.getUpcoming(UPCOMING_DAYS), []),
      safeRead<UpcomingAssignment[]>(() => api.canvas.getOverdue(OVERDUE_DAYS), []),
      safeRead<CourseGrade[]>(() => api.canvas.getGrades(), []),
      safeRead<AnnouncementRow[]>(() => api.canvas.getAnnouncements(ANNOUNCEMENT_LIMIT), []),
      safeRead<CalendarEvent[]>(() => api.calendar.getEvents(today, today), []),
    ]);

    setCanvasStatus(nextCanvasStatus);
    setCalendarStatus(nextCalendarStatus);
    setUpcoming(nextUpcoming);
    setOverdue(nextOverdue);
    setGrades(nextGrades);
    setAnnouncements(nextAnnouncements);
    setEvents(nextEvents);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load().catch(() => setLoaded(true));
    const stopCanvas = window.smartlife.canvas.onSyncChanged(() => {
      void load().catch(() => {});
    });
    const stopCalendar = window.smartlife.calendar.onSyncChanged(() => {
      void load().catch(() => {});
    });
    return () => {
      stopCanvas();
      stopCalendar();
    };
  }, [load]);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      // allSettled, not all: a Google outage must not block a Canvas refresh.
      await Promise.allSettled([
        window.smartlife.canvas.syncNow(),
        window.smartlife.calendar.syncNow(),
      ]);
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  return {
    canvasStatus,
    calendarStatus,
    upcoming,
    overdue,
    grades,
    announcements,
    events,
    loaded,
    refreshing,
    refresh,
  };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -- src/renderer/src/home/useHome.test.ts && npm run typecheck`
Expected: PASS (7 tests), typecheck clean.

If the `window.smartlife` stub in the test conflicts with an existing global
setup in `vitest.setup.ts`, prefer matching however other renderer hook tests
in this repo already stub the bridge (check
`src/renderer/src/calendar/` and `src/renderer/src/school/` test files) rather
than inventing a third pattern.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/home/useHome.ts src/renderer/src/home/useHome.test.ts
git commit -m "Add the useHome data hook aggregating Canvas and calendar reads"
```

---

### Task 5: Today panel

**Files:**
- Create: `src/renderer/src/home/TodayPanel.tsx`
- Test: `src/renderer/src/home/TodayPanel.test.tsx`

**Interfaces:**
- Consumes: `TodayItem` from `./timeline`; `formatEventTime` from
  `../calendar/formatters`; `CALENDAR_ACCENT` from `../calendar/types`;
  `SCHOOL_ACCENT` from `../school/types`; `Link` from `react-router-dom`.
- Produces: `TodayPanel({ items }: { items: TodayItem[] })`, consumed by Task 7.

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/home/TodayPanel.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TodayPanel } from './TodayPanel';
import type { TodayItem } from './timeline';

function eventItem(summary: string, allDay = false): TodayItem {
  return {
    kind: 'event',
    at: new Date(2026, 7, 22, 14, 0).getTime(),
    allDay,
    event: {
      calendarId: 'primary',
      id: 'e1',
      summary,
      description: null,
      location: null,
      startAt: new Date(2026, 7, 22, 14, 0).toISOString(),
      endAt: new Date(2026, 7, 22, 15, 0).toISOString(),
      isAllDay: allDay,
      htmlLink: null,
      hasGuests: false,
      guestCount: 0,
      etag: null,
    },
  };
}

function dueItem(name: string, hasSubmitted = false): TodayItem {
  return {
    kind: 'due',
    at: new Date(2026, 7, 22, 23, 59).getTime(),
    assignment: {
      id: 42,
      courseId: 1,
      courseName: 'Financial Accounting',
      name,
      dueAt: new Date(2026, 7, 22, 23, 59).toISOString(),
      pointsPossible: 20,
      hasSubmitted,
      htmlUrl: null,
    },
  };
}

function renderPanel(items: TodayItem[]) {
  return render(
    <MemoryRouter>
      <TodayPanel items={items} />
    </MemoryRouter>
  );
}

describe('TodayPanel', () => {
  it('renders an event summary', () => {
    renderPanel([eventItem('Accounting lecture')]);
    expect(screen.getByText('Accounting lecture')).toBeTruthy();
  });

  it('renders an assignment name and its course', () => {
    renderPanel([dueItem('Chapter 4 homework')]);
    expect(screen.getByText('Chapter 4 homework')).toBeTruthy();
    expect(screen.getByText(/Financial Accounting/)).toBeTruthy();
  });

  it('links an assignment to its workspace', () => {
    renderPanel([dueItem('Chapter 4 homework')]);
    const link = screen.getByRole('link', { name: /Chapter 4 homework/ });
    expect(link.getAttribute('href')).toBe('/assignment/42');
  });

  it('marks a submitted assignment as submitted', () => {
    renderPanel([dueItem('Already done', true)]);
    expect(screen.getByText(/submitted/i)).toBeTruthy();
  });

  it('labels an all-day event rather than showing a time range', () => {
    renderPanel([eventItem('Reading day', true)]);
    expect(screen.getByText(/all day/i)).toBeTruthy();
  });

  it('says the day is clear when there is nothing on it', () => {
    renderPanel([]);
    expect(screen.getByText(/nothing scheduled/i)).toBeTruthy();
  });

  it('renders an untitled event without printing null', () => {
    const item = eventItem('placeholder');
    if (item.kind === 'event') item.event.summary = null;
    renderPanel([item]);
    expect(screen.queryByText('null')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/renderer/src/home/TodayPanel.test.tsx`
Expected: FAIL — `Failed to resolve import "./TodayPanel"`.

- [ ] **Step 3: Implement the component**

Create `src/renderer/src/home/TodayPanel.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { formatEventTime } from '../calendar/formatters';
import { CALENDAR_ACCENT } from '../calendar/types';
import { SCHOOL_ACCENT } from '../school/types';
import type { TodayItem } from './timeline';

function timeLabel(item: TodayItem): string {
  if (item.kind === 'event') return formatEventTime(item.event);
  const due = new Date(item.at);
  const hours = due.getHours();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(due.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

function Row({ item }: { item: TodayItem }): React.JSX.Element {
  const accent = item.kind === 'event' ? CALENDAR_ACCENT : SCHOOL_ACCENT;
  const title =
    item.kind === 'event' ? (item.event.summary ?? 'Untitled event') : item.assignment.name;
  const detail = item.kind === 'event' ? item.event.location : item.assignment.courseName;

  const body = (
    <>
      <span
        aria-hidden="true"
        className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full"
        style={{ backgroundColor: accent }}
      />
      <div className="flex min-w-0 flex-col">
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

  const className = 'flex items-start gap-3 rounded-lg px-3 py-2';
  const style = { backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' };

  // Only due items have somewhere to go. An event's own surface is the
  // calendar week grid, which has no per-event route.
  return item.kind === 'due' ? (
    <Link to={`/assignment/${item.assignment.id}`} className={className} style={style}>
      {body}
    </Link>
  ) : (
    <div className={className} style={style}>
      {body}
    </div>
  );
}

export function TodayPanel({ items }: { items: TodayItem[] }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
        Today
      </h2>
      {items.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>Nothing scheduled today.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li key={item.kind === 'event' ? `e${item.event.id}` : `a${item.assignment.id}`}>
              <Row item={item} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -- src/renderer/src/home/TodayPanel.test.tsx && npm run typecheck`
Expected: PASS (7 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/home/TodayPanel.tsx src/renderer/src/home/TodayPanel.test.tsx
git commit -m "Add the Today agenda panel"
```

---

### Task 6: Needs-attention section, and reusable `DueSoon`

**Files:**
- Create: `src/renderer/src/home/NeedsAttention.tsx`
- Test: `src/renderer/src/home/NeedsAttention.test.tsx`
- Modify: `src/renderer/src/school/DueSoon.tsx`
- Test: `src/renderer/src/school/DueSoon.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `UpcomingAssignment`, `SCHOOL_ACCENT` from `../school/types`;
  `formatDue` from `../school/formatters`.
- Produces: `NeedsAttention({ items })` and a `DueSoon` that accepts optional
  `title` and `emptyText` props. Both consumed by Task 7.

`DueSoon`'s new props must default to its current literal strings so School
renders byte-identically. Do not change School.

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/home/NeedsAttention.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NeedsAttention } from './NeedsAttention';
import type { UpcomingAssignment } from '../school/types';

function overdue(id: number, name: string): UpcomingAssignment {
  return {
    id,
    courseId: 1,
    courseName: 'Financial Accounting',
    name,
    dueAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    pointsPossible: 20,
    hasSubmitted: false,
    htmlUrl: null,
  };
}

function renderSection(items: UpcomingAssignment[]) {
  return render(
    <MemoryRouter>
      <NeedsAttention items={items} />
    </MemoryRouter>
  );
}

describe('NeedsAttention', () => {
  it('renders each past-due assignment with its course', () => {
    renderSection([overdue(10, 'Missed lab')]);
    expect(screen.getByText('Missed lab')).toBeTruthy();
    expect(screen.getByText(/Financial Accounting/)).toBeTruthy();
  });

  it('links each item to its assignment workspace', () => {
    renderSection([overdue(10, 'Missed lab')]);
    expect(screen.getByRole('link', { name: /Missed lab/ }).getAttribute('href')).toBe('/assignment/10');
  });

  it('says how late each item is', () => {
    renderSection([overdue(10, 'Missed lab')]);
    expect(screen.getByText(/overdue/i)).toBeTruthy();
  });

  it('renders nothing at all when there is nothing past due', () => {
    // An empty state here would be a daily false alarm about nothing.
    const { container } = renderSection([]);
    expect(container.textContent).toBe('');
  });
});
```

Create `src/renderer/src/school/DueSoon.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DueSoon } from './DueSoon';
import type { UpcomingAssignment } from './types';

const items: UpcomingAssignment[] = [
  {
    id: 1,
    courseId: 1,
    courseName: 'Arabic',
    name: 'Vocabulary quiz',
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    pointsPossible: 10,
    hasSubmitted: false,
    htmlUrl: null,
  },
];

describe('DueSoon', () => {
  it('defaults to the School heading and empty text', () => {
    const { rerender } = render(<DueSoon items={items} />);
    expect(screen.getByText('Due soon')).toBeTruthy();
    rerender(<DueSoon items={[]} />);
    expect(screen.getByText(/next two weeks/i)).toBeTruthy();
  });

  it('accepts an overriding title and empty text', () => {
    const { rerender } = render(<DueSoon items={items} title="Next 7 days" emptyText="Clear week." />);
    expect(screen.getByText('Next 7 days')).toBeTruthy();
    rerender(<DueSoon items={[]} title="Next 7 days" emptyText="Clear week." />);
    expect(screen.getByText('Clear week.')).toBeTruthy();
  });

  it('still renders the assignment name and course', () => {
    render(<DueSoon items={items} />);
    expect(screen.getByText('Vocabulary quiz')).toBeTruthy();
    expect(screen.getByText('Arabic')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/renderer/src/home/NeedsAttention.test.tsx src/renderer/src/school/DueSoon.test.tsx`
Expected: FAIL — missing `./NeedsAttention`, and the title-override test fails
because `DueSoon` hardcodes its heading.

- [ ] **Step 3: Parameterize `DueSoon`**

In `src/renderer/src/school/DueSoon.tsx`, replace the component signature and
the two hardcoded strings. Everything else in the file is unchanged:

```tsx
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
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
        {title}
      </h2>
      {items.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>{emptyText}</p>
      ) : (
```

- [ ] **Step 4: Implement `NeedsAttention`**

Create `src/renderer/src/home/NeedsAttention.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { formatDue } from '../school/formatters';
import { SCHOOL_ACCENT, type UpcomingAssignment } from '../school/types';

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
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: SCHOOL_ACCENT }}>
        Needs attention
      </h2>
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              to={`/assignment/${item.id}`}
              className="flex items-center justify-between rounded-lg px-3 py-2"
              style={{ backgroundColor: 'var(--color-surface)', border: `1px solid ${SCHOOL_ACCENT}` }}
            >
              <div className="flex min-w-0 flex-col">
                <span style={{ color: 'var(--color-text)' }}>{item.name}</span>
                <span className="truncate text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {item.courseName}
                </span>
              </div>
              <span className="ml-3 flex-shrink-0 text-xs" style={{ color: SCHOOL_ACCENT }}>
                {formatDue(item.dueAt)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -- src/renderer/src/home/ src/renderer/src/school/ && npm run typecheck`
Expected: PASS, including every pre-existing School test unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/home/NeedsAttention.tsx src/renderer/src/home/NeedsAttention.test.tsx src/renderer/src/school/DueSoon.tsx src/renderer/src/school/DueSoon.test.tsx
git commit -m "Add the needs-attention section and make DueSoon reusable"
```

---

### Task 7: Compose the Home route

**Files:**
- Modify: `src/renderer/src/routes/Home.tsx`
- Test: `src/renderer/src/routes/Home.test.tsx`

**Interfaces:**
- Consumes: `useHome` (Task 4), `buildToday` (Task 3), `TodayPanel` (Task 5),
  `NeedsAttention` + parameterized `DueSoon` (Task 6), plus the existing
  `GradeStrip`, `TokenBanner`, and `formatRelative` from `../school/`.
- Produces: the finished route. Nothing consumes it.

`greeting(hour)` is already exported from this file and already has tests —
keep it exported and keep its behavior identical.

- [ ] **Step 1: Write the failing tests**

Replace the contents of `src/renderer/src/routes/Home.test.tsx`, keeping the
existing `greeting` describe block exactly as it is and adding the route tests
below it. Stub `window.smartlife` the same way Task 4's hook test does.

```tsx
describe('Home route', () => {
  function renderHome() {
    return render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );
  }

  it('prompts for Settings when neither source is connected', async () => {
    canvas.getStatus.mockResolvedValue({ tokenConfigured: false, baseUrlConfigured: false });
    calendar.getStatus.mockResolvedValue({ connected: false });
    renderHome();
    expect(await screen.findByRole('button', { name: /settings/i })).toBeTruthy();
  });

  it('does not render dashboard sections when nothing is connected', async () => {
    canvas.getStatus.mockResolvedValue({ tokenConfigured: false, baseUrlConfigured: false });
    calendar.getStatus.mockResolvedValue({ connected: false });
    renderHome();
    await screen.findByRole('button', { name: /settings/i });
    expect(screen.queryByText('Today')).toBeNull();
  });

  it('renders the Today agenda when a source is connected', async () => {
    renderHome();
    expect(await screen.findByText('Today')).toBeTruthy();
  });

  it('shows past-due work when there is any', async () => {
    canvas.getOverdue.mockResolvedValue([
      {
        id: 10,
        courseId: 1,
        courseName: 'Accounting',
        name: 'Missed lab',
        dueAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        pointsPossible: 20,
        hasSubmitted: false,
        htmlUrl: null,
      },
    ]);
    renderHome();
    expect(await screen.findByText('Missed lab')).toBeTruthy();
  });

  it('omits the needs-attention heading when nothing is past due', async () => {
    canvas.getOverdue.mockResolvedValue([]);
    renderHome();
    await screen.findByText('Today');
    expect(screen.queryByText(/needs attention/i)).toBeNull();
  });

  it('renders courses and announcements', async () => {
    renderHome();
    expect(await screen.findByText('Courses')).toBeTruthy();
    expect(screen.getByText('Announcements')).toBeTruthy();
  });

  it('offers to connect the calendar when only Canvas is connected', async () => {
    calendar.getStatus.mockResolvedValue({ connected: false });
    renderHome();
    await screen.findByText('Today');
    expect(screen.getByText(/connect google calendar/i)).toBeTruthy();
  });

  it('refreshes both sources from the header control', async () => {
    renderHome();
    const button = await screen.findByRole('button', { name: /refresh/i });
    await userEvent.click(button);
    await waitFor(() => expect(canvas.syncNow).toHaveBeenCalled());
    expect(calendar.syncNow).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/renderer/src/routes/Home.test.tsx`
Expected: FAIL — the route still renders the "Nothing wired up yet"
placeholder, so every new assertion fails while the `greeting` block passes.

- [ ] **Step 3: Implement the route**

Replace `src/renderer/src/routes/Home.tsx`:

```tsx
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHome } from '../home/useHome';
import { buildToday } from '../home/timeline';
import { TodayPanel } from '../home/TodayPanel';
import { NeedsAttention } from '../home/NeedsAttention';
import { DueSoon } from '../school/DueSoon';
import { GradeStrip } from '../school/GradeStrip';
import { TokenBanner } from '../school/TokenBanner';
import { formatRelative } from '../school/formatters';

export function greeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function formatToday(date: Date): string {
  return `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

export function Home(): React.JSX.Element {
  const home = useHome();
  const navigate = useNavigate();

  const canvasConnected =
    home.canvasStatus !== null &&
    home.canvasStatus.tokenConfigured &&
    home.canvasStatus.baseUrlConfigured;
  const calendarConnected = home.calendarStatus !== null && home.calendarStatus.connected;

  const today = useMemo(
    () => buildToday(home.events, home.upcoming, new Date()),
    [home.events, home.upcoming]
  );

  const now = new Date();
  const heading = `${greeting(now.getHours())}`;

  // Loading and fully-disconnected render the same prompt, so there is no
  // flash of an empty dashboard before the two statuses resolve.
  if (!home.loaded || (!canvasConnected && !calendarConnected)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--color-text)' }}>
          {heading}
        </h1>
        <p style={{ color: 'var(--color-text-muted)' }}>
          Connect Canvas or Google Calendar to see your day here.
        </p>
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="rounded-md px-4 py-2 text-sm"
          style={{
            backgroundColor: 'var(--color-text)',
            color: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
          }}
        >
          Go to Settings
        </button>
      </div>
    );
  }

  const lastSynced = home.canvasStatus?.lastSyncedAt ?? home.calendarStatus?.lastSyncedAt ?? null;

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col">
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--color-text)' }}>
            {heading}
          </h1>
          <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            {formatToday(now)} · synced {formatRelative(lastSynced)}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void home.refresh()}
          disabled={home.refreshing}
          className="rounded-md px-3 py-1.5 text-sm"
          style={{
            backgroundColor: 'var(--color-surface)',
            color: 'var(--color-text)',
            border: '1px solid var(--color-border)',
          }}
        >
          {home.refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <TokenBanner status={home.canvasStatus} />
      <NeedsAttention items={home.overdue} />
      <TodayPanel items={today} />

      {canvasConnected && (
        <>
          <DueSoon items={home.upcoming} title="Next 7 days" emptyText="Nothing due in the next week." />
          <GradeStrip courses={home.grades} />
          <section className="flex flex-col gap-2">
            <h2
              className="text-sm font-semibold uppercase tracking-wide"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Announcements
            </h2>
            {home.announcements.length === 0 ? (
              <p style={{ color: 'var(--color-text-muted)' }}>No recent announcements.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {home.announcements.map((announcement) => (
                  <li
                    key={announcement.id}
                    className="flex items-baseline justify-between gap-3 rounded-lg px-3 py-2"
                    style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
                  >
                    <span className="truncate" style={{ color: 'var(--color-text)' }}>
                      {announcement.title ?? 'Untitled'}
                    </span>
                    <span className="flex-shrink-0 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      {announcement.courseName} · {formatRelative(announcement.postedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {!canvasConnected && (
        <p style={{ color: 'var(--color-text-muted)' }}>
          Connect Canvas in Settings to see assignments, grades, and announcements.
        </p>
      )}
      {!calendarConnected && (
        <p style={{ color: 'var(--color-text-muted)' }}>
          Connect Google Calendar in Settings to see today&apos;s events.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -- src/renderer/src/routes/Home.test.tsx && npm run typecheck`
Expected: PASS, including the untouched `greeting` tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: every test passes. `ThemeProvider.test.tsx` may flake — rerun it in
isolation before reporting it as a failure.

- [ ] **Step 6: Build and package**

Run: `npm run build && npm run package`
Expected: `release/mac-arm64/SmartLife.app` exists. Code signing is skipped in
this environment; that is expected, not a defect.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/routes/Home.tsx src/renderer/src/routes/Home.test.tsx
git commit -m "Replace the Home placeholder with the real dashboard"
```

---

## Manual smoke checklist

Only the user can run these, against the packaged app with real accounts:

1. Open the app on Home — the greeting, today's date, and a sync age appear.
2. Today lists real calendar events for today, in chronological order.
3. An assignment due today appears in Today alongside those events.
4. An all-day event appears at the top of Today, labeled "All day".
5. Clicking an assignment row in Today opens `/assignment/:id`.
6. "Needs attention" lists genuinely missed work — and does not list
   attendance or participation rows.
7. "Needs attention" is absent entirely when nothing is past due.
8. "Next 7 days" matches School's due-soon list, narrowed to a week.
9. Courses and Announcements match what School shows.
10. Refresh updates the sync age and repaints without a route change.
11. Disconnecting Canvas in Settings leaves the calendar half working.
12. An expiring Canvas token surfaces the existing banner on Home.
