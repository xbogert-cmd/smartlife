# SmartLife Phase 3: Canvas (read-only) — Design Spec

**Status:** approved 2026-08-18
**Depends on:** Phase 1 (Foundation), Phase 2 (AI Core) — both shipped and verified
**Roadmap line:** "Canvas REST client, courses/assignments/grades/modules, sync to local DB, School UI, course pages"

## Goal

Turn the `school` nav section from a `ComingSoon` placeholder into the app the user
actually opens every morning: what is due, where their grades stand, and access to
their course materials — all served from a local mirror so it is instant and works
offline.

## Scope

**In:** Canvas REST client, token storage, tiered sync engine, eight new tables
(seven mirroring Canvas data, one for sync bookkeeping), a
School home view, a course detail view, Settings integration, three READ-tier AI
tools, and first-class handling of token expiry.

**Out — deliberately:**

- **Anything that writes to Canvas.** No submissions, no comments, no edits. The
  submission workspace is Phase 3b, resequenced after Phase 5 per ROADMAP correction
  #3, because its "fall back to the embedded browser for unsupported submission
  types" path has nothing to fall back to until the embedded browser exists.
- **OAuth.** Personal access token only, per ROADMAP correction #2 — registering an
  OAuth developer key on a university Canvas instance requires institutional admin
  approval a student account will not have.
- **Quizzes, discussions, and the planner/todo endpoints.** Adjacent and tempting,
  but not needed for the three jobs this phase exists to do. Revisit if a real need
  appears.
- **An in-app PDF/document viewer.** Files open in the user's own Mac apps.

## Confirmed external context

Verified with the user on 2026-08-18 before design, because the whole phase depends
on it:

- **Institution:** UNCW, `uncw.instructure.com` — Instructure cloud, not self-hosted.
- **Token generation is available** to the student account
  (Account → Settings → Approved Integrations → `+ New Access Token`).
- **UNCW caps token lifetime at 90 days.** This is the single most consequential
  external constraint in the phase: the token *will* expire roughly twice a semester.
  Expiry is therefore designed as a routine, expected event — not an error path.

## Canvas API mechanics (verified against Instructure docs, not assumed)

1. **Pagination** is via the `Link` header with `rel="next"`, and **defaults to 10
   items per page.** Requests must set `per_page=100` or a course with 40 assignments
   silently syncs 10 of them. `next` URLs are opaque and followed as-is.
2. **Throttling** returns **429** with `X-Rate-Limit-Remaining` and `X-Request-Cost`
   headers. Instructure explicitly advises **no more than one simultaneous request** —
   parallel requests incur a pre-flight quota penalty. The sync engine is therefore a
   **serial queue**, never a `Promise.all` fan-out.
3. **Grades come free with the course list.**
   `GET /courses?include[]=total_scores&enrollment_state=active` returns
   `computed_current_score` / `computed_current_grade` on each enrollment. The entire
   grade dashboard costs **one request**, not one per course.
4. **Course filtering:** `enrollment_state=active&state[]=available` excludes finished
   and unpublished courses.

## Architecture

### Sync strategy: tiered mirror

Chosen over a full mirror (first run would serially crawl every module, page, and
file listing across all courses — slow, and mostly never read) and over live-fetch
(spinners everywhere, nothing works offline, latency on the most-used view).

| Tier | Data | When |
|---|---|---|
| **1** | courses + grades (1 call), assignments with submission state (1 call/course), announcements | Every sync |
| **2** | modules, module items, file list, page list | First time a course is opened, then cached |
| **3** | file bytes, page HTML body | On click |

Tier 1 is ~2 + *N* requests for *N* active courses (~7 calls for 5 courses), keeping
first sync fast and the daily-driver view always pre-loaded and offline-capable.

**Cadence:** on launch; on window focus (throttled to once per 5 minutes so
alt-tabbing does not hammer Canvas); a 30-minute background interval; and a manual
refresh button. In-process only — no external scheduler, per ROADMAP correction #5.

### Storage

Token storage mirrors Phase 2's `src/main/ai/apiKey.ts`: safeStorage-encrypted
(Keychain-backed) into the existing `settings` table. The base URL is stored
alongside as plain text, since it is not a secret.

**Migration `0003_canvas.sql`** — schema mirrors Canvas's own shapes so sync stays a
dumb upsert:

| Table | Holds | Tier |
|---|---|---|
| `canvas_courses` | id, name, course_code, term_name, current_score, current_grade, synced_at | 1 |
| `canvas_assignments` | id, course_id, name, description, due_at, points_possible, html_url, submission_types, has_submitted, submitted_at, score, grade, workflow_state, synced_at | 1 |
| `canvas_announcements` | id, course_id, title, message, posted_at, html_url, synced_at | 1 |
| `canvas_modules` | id, course_id, name, position, synced_at | 2 |
| `canvas_module_items` | id, module_id, course_id, title, type, content_id, page_url, html_url, external_url, position | 2 |
| `canvas_files` | id, course_id, display_name, filename, content_type, size, updated_at, synced_at | 2 |
| `canvas_pages` | (course_id, url) PK, title, body (null until opened), updated_at, synced_at | 2/3 |
| `canvas_sync_state` | key/value: per-course and global last-sync timestamps, token-invalid flag | — |

Child tables cascade off `canvas_courses`. This depends on the `PRAGMA foreign_keys = ON`
that Phase 2's review added to `openDb()` — without it the cascades are inert.

Canvas IDs are used directly as primary keys (they are stable integers), so re-syncing
is an idempotent upsert rather than a diff.

**Deliberately not stored: file download URLs.** Canvas file URLs expire, so a URL
captured at sync time would break unpredictably later. Clicking a file re-fetches that
file's record for a fresh URL at click time.

### Main-process modules

- **`src/main/canvas/token.ts`** — safeStorage get/set/clear for the token, plus base
  URL and `token_saved_at`. Near-copy of `apiKey.ts`.
- **`src/main/canvas/client.ts`** — the only module that touches the network. Injects
  the auth header, forces `per_page=100`, follows `Link` `rel="next"` serially, and
  maps HTTP failures to typed errors (`CanvasAuthError`, `CanvasRateLimitError`,
  `CanvasNetworkError`) so no caller ever parses a status code.
- **`src/main/canvas/api.ts`** — thin typed endpoint wrappers: `listCourses`,
  `listAssignments`, `listAnnouncements`, `listModules`, `listModuleItems`,
  `listFiles`, `listPages`, `getPage`, `getFile`, `getSelf`. No logic.
- **`src/main/canvas/sync.ts`** — the serial queue. `syncCore()` (tier 1) and
  `syncCourseContent(courseId)` (tier 2). One request in flight at a time; each
  course's writes wrapped in a transaction.
- **`src/main/canvas/scheduler.ts`** — launch/focus/interval triggers, with the
  5-minute focus throttle.
- **`src/main/canvas/files.ts`** — fresh-URL fetch, download to the app cache dir,
  `shell.openPath`.
- **`src/main/canvas/ipc.ts`** — renderer handlers, registered the same way as
  `src/main/ai/ipc.ts`.

### Renderer

- **`/school`** — sync status line ("Synced 3 min ago" + refresh); **Due soon**
  (assignments across all courses within 14 days, sorted by `due_at`, each showing
  course, title, due date, submitted state); **grade strip** (one row per course);
  **recent announcements**. With no token configured, renders a "Connect Canvas in
  Settings" empty state — the same proactive pattern Phase 2 settled on.
- **`/school/course/:id`** — course header with name and current grade, then
  Assignments, Modules (items nested), Files, Announcements. Module items route by
  type: `Page` renders inline as HTML, `File` downloads and opens in the system app,
  `Assignment` links to its detail, `ExternalUrl` opens in the system browser
  (Phase 5 brings this in-app).
- **Settings** gains a Canvas block: base URL, masked token field, and a **Test
  connection** button that calls `getSelf()` and displays the returned name — so a
  bad token surfaces immediately rather than at the next silent sync.

Components live under `src/renderer/src/school/`, following the `src/renderer/src/ai/`
layout. Styling uses the existing `school` section theme (blue,
`#1E3A8A → #3B82F6`) already registered in `sectionThemes.ts`, with
`var(--color-*)` tokens and Tailwind for layout only, matching established convention.

### AI tools

Three tools appended to Phase 2's `TOOLS` registry, all **READ tier** so they are never
gated by a confirmation prompt in any mode:

- `canvas_upcoming_assignments(days)` — what is due in the next *N* days
- `canvas_course_grades` — current standing per course
- `canvas_search_materials(query)` — find a file or page by name

**These query SQLite, not Canvas.** They are therefore instant, work offline, and
cannot consume Canvas rate limit regardless of chat volume.

## Error handling

Expiry and failure are core features of this phase, not edge cases.

- **401 →** set the token-invalid flag in `canvas_sync_state`; show a banner in School
  and Settings with regeneration steps; **continue displaying cached data.** A dead
  token means stale, never blank.
- **Token aging →** `token_saved_at` drives a warning at day 83. UNCW's 90-day cap
  makes this a recurring, predictable event, so the app warns before it bites.
- **429 →** back off and skip the cycle rather than retry-hammering a depleted quota.
- **Offline / network error →** no error spam; the sync status line simply reports
  "last synced 2 hours ago."
- **Per-course failure →** recorded and skipped; the sync continues. One broken course
  must not cost the user the other four.

## Testing

Follows Phase 2's discipline exactly. **No test performs a live Canvas call.**

- **`client.ts`** — fake `fetch`: multi-page `Link` traversal, `per_page` enforcement,
  and each error mapping (401 → `CanvasAuthError`, 429 → `CanvasRateLimitError`,
  network failure → `CanvasNetworkError`).
- **`sync.ts`** — fake `api.ts` responses against a real in-memory SQLite DB: assert
  rows land correctly, that a second sync is idempotent, and that one course's failure
  does not abort the run.
- **`token.ts`** — mocked `safeStorage`, mirroring `apiKey.test.ts`.
- **Renderer** — render tests against a mocked `window.smartlife`, covering the
  no-token empty state, the populated due-soon list, and the token-expired banner.

Live end-to-end verification against the real UNCW instance is a manual step the user
performs after implementation, exactly as with Phase 2's API key.

## Success criteria

1. User pastes their Canvas token and base URL into Settings; Test connection returns
   their name.
2. First sync populates courses, assignments, grades, and announcements within a few
   seconds.
3. `/school` shows what is due and current grades, instantly, on subsequent launches —
   including with the network off.
4. Opening a course loads its modules and files; clicking a PDF opens it in Preview.
5. Asking the AI "what's due this week?" returns a correct answer from local data.
6. Revoking the token in Canvas produces a clear expired-token banner, not a crash or
   a blank screen, and previously synced data remains visible.
