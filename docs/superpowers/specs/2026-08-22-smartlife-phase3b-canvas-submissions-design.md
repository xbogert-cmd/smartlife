# Phase 3b: Assignment Workspace & Submissions — Design

**Date:** 2026-08-22
**Depends on:** Phase 1 (shell, DB, IPC), Phase 2 (AI core, permission tiers),
Phase 3 (Canvas read), Phase 5 (embedded browser)
**Status:** approved, not yet planned

## Goal

Make SmartLife the place assignments get done and turned in: one route per
assignment that adapts to what that assignment actually is, real submission
through the Canvas API where the API can do it, and a smooth handoff into the
embedded browser where it cannot.

## How this differs from the roadmap entry

The roadmap describes 3b as "assignment workspace, editor, submission
confirmation flow, browser fallback for unsupported submission types." That
framing treats the browser as an edge case. The user's actual Canvas data says
otherwise.

Current-semester assignments, by submission type:

| Type | Count | Share | Submittable via Canvas API? |
|---|---:|---:|---|
| `external_tool` | 97 | 45% | No — LTI |
| `none` | 51 | 24% | Nothing to submit |
| `online_upload` | 42 | 20% | Yes |
| `discussion_topic` | 13 | 6% | Yes, different endpoint |
| `online_text_entry` | 5 | 2% | Yes |
| `online_text_entry` + `online_upload` | 4 | 2% | Yes |
| `online_quiz` | 1 | <1% | No — quiz UI only |

`external_tool` is concentrated almost entirely in two courses: Financial
Accounting (58) and Financial Accounting Lab (26), plus Intro to Weather and
Climate (12).

**The browser handoff is the majority path, not the fallback.** 98 assignments
(45%) can only be completed in a browser; 64 (30%) are API-submittable. The
design weights them accordingly: the browser handoff is a first-class,
fully-designed surface, not a stub that opens a link.

Two other changes from the roadmap line:

1. **Discussion topics get a real submission path**, not a browser handoff. They
   recur across humanities and language courses every semester and reuse the
   text editor wholesale.
2. **The AI panel converts from a modal overlay to a collapsible dock**, and
   gains ambient awareness of what the user is looking at. This is
   cross-cutting rather than 3b-specific, but it belongs here: an AI that covers
   the assignment it is helping with is the wrong shape for this phase's central
   use case.

## Scope

### In

- A per-assignment route, `/assignment/:id`, with type-aware content
- Text-entry submission (editor, draft autosave, submit)
- File-upload submission (native file picker, Canvas three-step upload, submit)
- Discussion-topic submission (initial post only)
- Browser handoff for `external_tool` and `online_quiz`, in-workspace
- Server-verified submission confirmation and state
- A fourth permission tier, `ALWAYS_CONFIRM`, and one AI tool in it
- Conversion of the AI overlay to a collapsible right-hand dock with a
  persistent toggle control
- Ambient view context injected into the AI's system prompt

### Out

- Peer replies to classmates' discussion entries. The API supports it
  (`POST .../entries/:entry_id/replies`), but replying meaningfully requires
  reading the thread, which means building a discussion viewer. Browser task for
  now; clean future add.
- `media_recording` and `student_annotation` submission types. Neither appears
  in the user's data.
- Quiz taking. Canvas quizzes have their own engine; the browser handles them.
- Re-submission policy modelling (attempt limits, late policies). We submit and
  report what Canvas says; we do not predict what Canvas will allow.
- Pulling assigned reading material and AI tutoring over it. That is Phase 3c,
  deliberately designed after this workspace exists rather than alongside it.

## Global Constraints

Inherited from the project and binding on every task:

- **Exactly two runtime dependencies:** `@anthropic-ai/sdk` and
  `better-sqlite3`. This phase adds none. No rich-text editor library, no
  multipart library, no markdown renderer.
- Main-process-only privileged operations. The renderer reaches Canvas only
  through IPC.
- No raw `shell` or Node API exposed to the renderer through the preload bridge.
- Migrations are additive and numbered; this phase adds `0006_submissions.sql`.
  (Phase 4b's blocked design has been renumbered to `0007_mail.sql` — see
  "Migration numbering".)
- TDD with real assertions; no test may assert only that a function was called.
- The existing main-window navigation guards must not be weakened.
- Canvas requests remain serial through Phase 3's scheduler exclusivity guard.
  Submission is user-initiated and must not race a background sync.

## External setup

**None new.** This phase uses the Canvas personal access token already stored
from Phase 3.

### One unverifiable gate

Canvas documents that submission requires an active student enrollment:
*"You must be actively enrolled as a student in the course/section to do this.
Concluded and pending enrollments are not permitted."* That is consistent with
the user's five concluded courses being un-submittable, which is correct
behavior rather than a limitation.

What cannot be verified from documentation is whether UNCW's Canvas instance
permits API-initiated submissions at all. Some institutions restrict API writes.
The endpoint is standard and a personal access token acts as the user, so it
should work — but **the first real submission is the test.** Do it on a
low-stakes assignment. If it fails, the failure surfaces as a Canvas error with
a status code, and the browser handoff path already covers every assignment as a
fallback, so the phase degrades rather than breaks.

## Canvas API contracts

Verified against Canvas's published API documentation on 2026-08-22. These are
the exact contracts the implementation must honor.

### Submit an assignment

```
POST /api/v1/courses/:course_id/assignments/:assignment_id/submissions
```

| Parameter | Used for |
|---|---|
| `submission[submission_type]` | required; selects which content field applies |
| `submission[body]` | `online_text_entry` — HTML snippet |
| `submission[file_ids][]` | `online_upload` — previously uploaded file ids |
| `submission[url]` | `online_url` / `basic_lti_launch` |
| `comment[text_comment]` | optional comment alongside the submission |

Accepted `submission_type` values: `online_text_entry`, `online_url`,
`online_upload`, `media_recording`, `basic_lti_launch`, `student_annotation`.

Note that `basic_lti_launch` is accepted, but it requires a URL that the LTI
tool produces after work is completed inside it. SmartLife never has that URL,
so `external_tool` assignments remain browser handoffs.

### File upload — three steps, and the second one is a trap

**Step 1 — request an upload slot:**

```
POST /api/v1/courses/:course_id/assignments/:assignment_id/submissions/self/files
```

with `name`, `size`, `content_type`. Returns `upload_url` and `upload_params`.
The returned signature is valid for 30 minutes.

**Step 2 — POST the file to `upload_url`** as `multipart/form-data`:

- Every field from `upload_params` must be included **unmodified**. Canvas
  states the request is signed and "will be denied if any parameters from the
  `upload_params` response are added, removed or modified."
- The `file` field must come **last** in the multipart body.
- **No `Authorization` header.** This is the trap: Phase 3's Canvas client
  attaches the bearer token to every request it makes. This upload must not go
  through that client at all — it is a plain `fetch` to a third-party signed URL,
  and attaching the token adds a parameter the signature does not cover.
- Responds 301/302 with a `Location` header, or 201.

**Step 3 — confirm** with a GET to that `Location`, this time *with* normal
`Authorization: Bearer` auth. Returns the file object carrying the `id` used in
`submission[file_ids][]`.

Each step fails independently and the workspace must say which one failed. A
step-2 failure after a successful step 1 is the common case (network drop
mid-upload) and must not read as "Canvas rejected your file."

### Discussion entries

```
POST /api/v1/courses/:course_id/discussion_topics/:topic_id/entries
```

with `message`.

**Assignments do not expose their discussion topic.** The relationship runs the
other way: a `DiscussionTopic` carries `assignment_id`, described as "the unique
identifier of the assignment if the topic is for grading, otherwise null." So
resolving an assignment to its topic requires listing the course's discussion
topics and matching backward. This phase adds that sync.

`require_initial_post`, when set, returns **HTTP 403 with the literal body
`require_initial_post`** if the thread is read before the user has posted. This
is a specific, nameable condition — not a permissions failure — and is surfaced
as "you have to post before you can see the thread," which is also the natural
order of operations.

## Architecture

### Submission-type routing

A pure module, `src/main/canvas/submission.ts`, classifies a stored
`submission_types` value into a handling path. No Electron import, no I/O, fully
unit-testable.

```
type SubmissionPath =
  | { kind: 'text' }
  | { kind: 'file' }
  | { kind: 'text-or-file' }
  | { kind: 'discussion'; topicId: number }
  | { kind: 'handoff'; reason: 'external_tool' | 'quiz' }
  | { kind: 'none' }
```

`submission_types` is stored as a JSON array string (e.g. `["online_upload"]`)
and may carry more than one type. Classification rules, in order:

1. Contains `external_tool` or `online_quiz` → `handoff`
2. Contains `discussion_topic` → `discussion` (topic id resolved from the new
   `canvas_discussion_topics` table; if unresolved, degrade to `handoff`)
3. Contains both `online_text_entry` and `online_upload` → `text-or-file`
4. Contains `online_text_entry` → `text`
5. Contains `online_upload` → `file`
6. Otherwise → `none`

Handoff wins over everything because an assignment offering both an external
tool and a text entry is one where the tool is the real work.

`text-or-file` is not a combined submission. Canvas accepts exactly one
`submission_type` per submission, so the workspace shows both surfaces and the
user picks which one they are submitting; the chosen surface determines the
`submission_type` sent. Submitting text does not also upload a staged file, and
the UI must not imply it will.

### The workspace route

`/assignment/:id`. Three regions:

- **Header** — assignment name, course, due date, points, and submission state
  (never submitted / submitted at T / graded X/Y). State comes from the DB,
  which Phase 3 already syncs.
- **Body** — the assignment description, rendered through Phase 3's existing
  `sanitizeHtml`, plus the type-specific surface below it.
- **Type surface** — editor, file picker, browser view, or nothing, per the
  classified path.

For `handoff` assignments the browser is *inside* the workspace, not a link that
navigates away. The workspace mounts a `ViewportSlot` and calls the existing
renderer-only `openTab(html_url)`, so the tab lands on the Canvas assignment
page with the user already logged in via `persist:browser` and Canvas's own LTI
launch firing normally. Navigating to the tool's own domain directly would not
authenticate — LTI requires a signed launch that only Canvas can send.

### Draft storage

Text and discussion drafts persist locally so closing the app does not lose
work. New table:

```sql
create table assignment_drafts (
  assignment_id integer primary key
    references canvas_assignments(id) on delete cascade,
  body text not null,
  updated_at text not null default (datetime('now'))
);
```

Autosave is debounced in the renderer and written through IPC. Drafts are
deliberately not synced anywhere — they are local scratch, and a draft is
cleared once Canvas confirms a submission carrying it.

### Discussion topic sync

New table, populated by a new sync step that lists each course's discussion
topics:

```sql
create table canvas_discussion_topics (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  assignment_id integer,
  title text,
  require_initial_post integer not null default 0,
  synced_at text not null default (datetime('now'))
);

create index canvas_discussion_topics_assignment_idx
  on canvas_discussion_topics(assignment_id);
```

This runs on the same tiered schedule as Phase 3's other course content, routed
through the scheduler's exclusivity guard. It is cheap — one request per course.

### Submission flow

All submission goes through one main-process module,
`src/main/canvas/submit.ts`, regardless of whether the UI button or the AI tool
initiated it. There is exactly one code path, so there is exactly one
confirmation gate and one place where verification happens.

```
submitAssignment(assignmentId, payload) →
  1. classify path from stored submission_types
  2. reject if path is handoff / none
  3. for file: run the three-step upload, collecting file ids
  4. POST the submission (or discussion entry)
  5. re-fetch the assignment's submission from Canvas
  6. write the server's answer to the DB
  7. clear any draft
  8. return the server-verified result
```

Step 5 is what makes "did it actually go through" answerable. The UI never shows
an optimistic local success — it shows the submission id and timestamp Canvas
returned. If step 4 succeeds but step 5 fails, the state is reported honestly as
"submitted, but we could not confirm — check Canvas" rather than resolved in
either direction.

### The `ALWAYS_CONFIRM` tier

`src/main/ai/permissions.ts` gains a fourth `ToolTier`. Unlike the existing
three, it appears in **every** mode's pause list — `ask`, `assist`, and `auto`
alike — and there is no escalation or override path that removes it. Phase 4b's
design specified this tier and Phase 5's deferred it to 5b; 3b delivers it, so
it exists and is tested whenever either of those unblocks.

One tool sits in it: `canvas_submit_assignment`.

The confirmation dialog shows **the exact content going out** — the full text
body, or the resolved filename and byte size — not a summary and not a
truncation. A user confirming a submission is confirming specific bytes.

For discussion submissions the dialog says plainly that the post will be
**visible to the whole class and generally cannot be deleted by a student.**
That is a materially different consequence from a file upload the professor
alone reads, and the dialog should not flatten the two into one generic
"Submit?" prompt.

Submitting from the UI button hits the same `submitAssignment` and shows the
same dialog. The AI has no capability the user does not, and the user gets no
shortcut the AI does not.

### AI dock conversion

Phase 2's Cmd+J modal overlay becomes a collapsible right-hand dock:

- A persistent toggle control lives in the app chrome, outside any browser
  viewport rectangle. This placement is required, not cosmetic: the embedded
  browser is a native `WebContentsView` composited *above* the React tree, so a
  control drawn over the browser's rectangle is invisible. The chrome is the
  only always-visible place.
- Opening the dock narrows the content area rather than covering it. On the
  browser route the `ViewportSlot` shrinks, `ResizeObserver` fires, and Phase
  5's existing `setBounds` path resizes the native view. That machinery already
  exists and is tested.
- **The AI panel no longer suspends the browser view.** Phase 5's suspend
  counter was needed because a modal overlay would otherwise render behind the
  native view; a dock has no overlap, so the AI panel drops out of the
  suspension callers entirely. The Cmd+K palette and the download prompt are
  true modals and continue to suspend.
- Cmd+J keeps working, now toggling the dock.
- The conversation is the same one the AI route shows, unchanged from Phase 2.

The suspend counter itself stays. It is still correct, still needed by two
callers, and removing it would be a regression the moment a third modal appears.

### Ambient view context

The renderer reports a structured descriptor of what the user is currently
looking at; the main process folds it into the system prompt on each turn.

**There is currently no system prompt at all.** `claudeProvider.streamTurn` calls
`client.beta.messages.toolRunner` with no `system` parameter, so this phase
introduces one rather than extending something existing. `AIProvider.streamTurn`
gains a `system: string` parameter, and the prompt is assembled main-side from
the view context plus the current date — the model has had neither until now.

The descriptor is **structured data, not prose**, and the main process renders
it. The renderer cannot inject arbitrary system-prompt text.

```
type ViewContext =
  | { route: 'home' | 'settings' | 'school' | 'ai' | 'browser' }
  | { route: 'course'; courseId: number }
  | { route: 'assignment'; assignmentId: number }
  | { route: 'calendar'; selectedEventId?: string }
```

Rendering rules, and the security boundary they encode:

- **Canvas- and calendar-derived fields are looked up in the local DB by the
  main process**, not passed as strings from the renderer. The renderer sends an
  id; the main process reads the name, course code, due date, submission type,
  and submitted state itself. A compromised renderer cannot forge context it did
  not earn.
- Those values still pass through Phase 5's existing `neutralizeMarkerText`
  before entering the prompt. They originate from the user's institution and are
  low-risk, but the neutralizer is already written and applying it costs
  nothing.
- **Browser context contributes the active tab's origin and nothing else** — no
  page title, no URL path, no body text. The renderer does not even send the
  origin: it sends `{ route: 'browser' }`, and the main process reads the active
  tab's URL from the live browser host and reduces it to an origin itself. The
  renderer never handles the value, so it cannot shape it. Page titles are attacker-controlled,
  and a hostile title reaching the *system prompt* would be strictly worse than
  the fenced tool output Phase 5 built specifically to contain it. Instead the
  context tells the model the browser is open and that `browser_read_page` will
  read it, so the model fetches content through the path that fences it.

The result is what the feature is for: "what's this event in my calendar" works
because the model knows which event is selected; "explain what's on this page"
works because the model knows to go read it, through the safe door.

## Error handling

| Condition | Surface |
|---|---|
| Concluded enrollment | "This course has ended; Canvas won't accept submissions." Handoff still offered. |
| API write forbidden (403 on submit) | Named as an institutional restriction, with the browser handoff offered as the working path. This is the unverified gate's failure mode. |
| Upload step 1 fails | "Canvas wouldn't start the upload" — quota or size, distinct from a rejected file. |
| Upload step 2 fails | "The file didn't finish uploading" — retryable, slot still valid for 30 minutes. |
| Upload step 3 fails | "Uploaded, but Canvas didn't confirm it" — do not submit with an unconfirmed id. |
| Submit succeeds, verify fails | "Submitted, but we couldn't confirm — check Canvas." Never resolved optimistically. |
| `require_initial_post` 403 | "You have to post before you can see the thread." |
| Expired Canvas token | Phase 3's existing token banner and cached-data fallback, unchanged. |
| Draft write fails | Non-blocking; the editor keeps the text in memory and warns. |

## Testing

- `submission.ts` classification is pure and gets exhaustive table-driven tests
  across every `submission_types` combination present in real data, plus the
  ambiguous multi-type cases and malformed JSON.
- The three-step upload is tested against a mocked transport asserting the
  things that actually break it: `upload_params` passed through byte-identical,
  `file` field last, **no `Authorization` header on step 2**, and auth present
  on step 3. A test that only checks "upload was called" is not acceptable here.
- `submitAssignment` is tested for each failure point independently, especially
  the submit-succeeded-verify-failed branch, which must not resolve to success.
- The `ALWAYS_CONFIRM` tier is tested to pause in all three modes including
  `auto`, mirroring the tier tests Phase 2 established.
- Dock conversion is tested for the suspension change specifically: opening the
  AI panel must **not** suspend the browser view, while Cmd+K and the download
  prompt still must.
- Ambient context is tested to confirm no page title or URL path reaches the
  prompt on the browser route, and that Canvas fields are resolved main-side
  from ids rather than trusted from the renderer.

## Migration numbering

This phase takes `0006_submissions.sql`. Phase 4b's blocked design, previously
holding `0006_mail.sql`, moves to `0007_mail.sql`. Phase 4b has no
implementation, so this is a documentation change to its spec only.

## What Phase 3c will need from this

Pinned now so 3b delivers the right seam:

1. **The workspace as a host.** 3c's material panel mounts inside
   `/assignment/:id`, so the route's layout must tolerate a third region without
   restructuring.
2. **Ambient assignment context already in the prompt.** 3c's tutoring flow
   builds on the model knowing which assignment is open; that arrives in 3b.
3. **The dock, not an overlay.** Tutoring requires reading and asking at the
   same time. 3b's dock conversion is a hard prerequisite.

## Deferred

- Peer replies to discussion entries, and any discussion thread viewer
- Assigned-material retrieval and AI tutoring over it (Phase 3c)
- `media_recording`, `student_annotation` submission types
- Attempt-limit and late-policy modelling
- Submission history and re-submission diffing
- Group-assignment submission semantics
