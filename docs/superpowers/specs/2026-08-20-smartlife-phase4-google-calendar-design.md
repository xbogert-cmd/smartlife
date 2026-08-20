# SmartLife Phase 4: Google Calendar — Design Spec

**Status:** approved 2026-08-20
**Depends on:** Phase 1 (Foundation), Phase 2 (AI Core), Phase 3 (Canvas read) — all shipped
**Roadmap line:** "OAuth, multiple calendars, CRUD events, in-process sync, calendar AI tools, confirm-before-write"

## Goal

Turn the `calendar` nav section from a `ComingSoon` placeholder into a working week
view of the user's Google Calendar — readable offline, editable in place, and
driveable by the assistant. This is the first phase in which SmartLife writes to a
real external service, so the confirm-before-write machinery built in Phase 2 gets
its first consequential workout.

## Scope

**In:** OAuth 2.0 loopback flow with PKCE, encrypted refresh-token storage, calendar
list with per-calendar enable/disable, a windowed event mirror, week grid + agenda
panel, create/update/delete events, a display-only Canvas due-date overlay, four AI
tools, and a Settings connection block.

**Out — deliberately:**

- **Writing Canvas assignments into Google Calendar.** This phase overlays Canvas
  deadlines for display only. Real Canvas↔Calendar syncing is Phase 6 (Planner),
  where the roadmap places it and where a task model exists to hang it on. Pulling
  it forward would mean inventing that model early.
- **An offline write queue.** Writes require network and fail fast when it is
  absent. A replay queue needs conflict resolution, retry bookkeeping, and pending
  state in the UI — real complexity for a case that barely occurs on a desktop app.
- **RSVP / responding to invitations, attachments, conferencing links, and
  reminder editing.** Adjacent but not needed for the three jobs this phase does.
- **Outlook / Microsoft calendar.** The user's class schedule and email live in
  Microsoft, not Google. This is a genuine gap in what "everything in one place"
  means today, and it deserves its own phase — see "Roadmap amendments" below.

## Roadmap corrections

Two claims in `ROADMAP.md` do not survive contact with Google's actual rules.

1. **"Can reuse the same OAuth client already being set up for the dashboard
   project — just add SmartLife's redirect URI to it."** Not possible. The loopback
   redirect (`http://127.0.0.1:PORT`) that installed apps use requires an OAuth
   client of type **Desktop app**; the dashboard is a serverless web app and its
   client is type **Web application**. Client type is fixed at creation and a web
   client will not accept a loopback redirect URI. The real shortcut is one level
   up: reuse the same Google Cloud **project** and OAuth consent screen, and create
   a *second* client of type Desktop app inside it.

2. **Consent-screen publishing status is a hard requirement, not a nicety.** A
   project with External user type and publishing status **"Testing"** is issued
   refresh tokens that **expire after 7 days** (the exception covers only
   name/email/profile scopes, which is not what Calendar needs). Left in Testing,
   the user would reauthorize weekly. The consent screen must be published to
   **In production**, whose only cost for a personal, unverified app is a one-time
   "Google hasn't verified this app" interstitial cleared via *Advanced → Go to
   SmartLife*.

## Roadmap amendments (not this phase)

**There is no email phase in the roadmap.** The user's mail and class schedule run
through Microsoft/Outlook, and they have asked for email support. Phase 7 covers
Notes/Files/Goals/Search and nothing addresses mail or a non-Google calendar. A
Microsoft/Outlook phase (mail + calendar, Microsoft Graph API, its own OAuth app)
should be added to `ROADMAP.md` when this phase closes. It is recorded here so it
is not lost, and explicitly excluded from Phase 4.

## Google API mechanics (verified against Google's docs, not assumed)

1. **The OOB / copy-paste redirect flow is no longer supported.** Installed apps use
   the loopback IP flow, and the documented client type for macOS desktop apps is
   **Desktop app**.
2. **PKCE is supported and used here.** The client secret Google issues for a
   Desktop client is explicitly not treated as confidential — installed apps cannot
   keep secrets — so PKCE plus a `state` check, not the secret, is what actually
   secures the exchange.
3. **Refresh tokens expire in 7 days under "Testing" publishing status** with
   External user type. See correction #2 above.
4. **There is a limit of 100 refresh tokens per Google account per client ID**;
   exceeding it silently invalidates the oldest. Not a practical concern for a
   single-user app, but it is why a revoked-token path must exist rather than being
   treated as impossible.
5. **Incremental sync via `syncToken` cannot be combined with `timeMin`/`timeMax`,
   and is incompatible with `singleEvents=true`.** A sync-token client therefore
   receives recurring events as master rules and must expand RRULEs itself. See the
   sync decision below.

## Architecture

### Sync strategy: windowed refetch, not incremental sync

Google offers two ways to keep a local mirror current, and they lead to very
different amounts of code.

**Incremental sync (`syncToken`)** returns only what changed since the last call —
efficient, but it forbids a time window and hands back recurring events as master
rules plus exceptions. Expanding those into displayable instances means an RRULE
engine: either a new runtime dependency (violating the project's two-dependency
constraint) or a hand-rolled recurrence expander with all of its edge cases
(exception dates, modified instances, infinite rules, DST boundaries).

**Windowed refetch (`singleEvents=true`)** asks Google to expand recurrences
server-side and return plain instances inside an explicit date range. The cost is
refetching the window rather than a delta: roughly 1–3 API calls per calendar per
sync, about 150 calls/day at a 30-minute cadence, against a default quota of
1,000,000 queries/day.

**Decision: windowed refetch.** It deletes an entire subsystem — recurrence
expansion — for a quota cost that rounds to zero.

**Window:** 60 days back, 180 days forward, recomputed on each run.

**Cadence:** on launch; on window focus, throttled to once per 5 minutes; a
30-minute background interval; and a manual refresh button. In-process only, per
ROADMAP correction #5. Identical to Phase 3's Canvas cadence.

### OAuth flow

1. The main process starts a throwaway `http.Server` bound to `127.0.0.1:0`, taking
   an OS-assigned port.
2. It generates a PKCE verifier/challenge pair and a random `state`, then opens the
   system browser via `shell.openExternal` to Google's consent URL.
3. The user approves in their own browser. No Google password ever passes through
   SmartLife.
4. Google redirects to the loopback server with an authorization code. The server
   verifies `state`, exchanges the code (sending the PKCE verifier), and shuts down
   immediately after handling exactly one request.
5. The `refresh_token` is persisted safeStorage-encrypted into the `settings` table,
   the same mechanism used for the Anthropic API key and the Canvas token. Access
   tokens are held in memory with their expiry and refreshed on demand — never
   written to disk.

Binding to `127.0.0.1` rather than `0.0.0.0`, checking `state`, and accepting a
single request are not ceremony: without them, another local process could reach
that port and inject an authorization code.

**Scope requested:** `https://www.googleapis.com/auth/calendar`. The read-only scope
cannot satisfy the CRUD requirement.

### Storage

**Migration `0004_calendar.sql`** — three tables:

| Table | Holds |
|---|---|
| `google_calendars` | `id` (Google calendar ID, PK), summary, time_zone, background_color, access_role, is_primary, `enabled`, synced_at |
| `google_events` | (`calendar_id`, `id`) composite PK, summary, description, location, start_at, end_at, `is_all_day`, status, html_link, organizer_email, `has_guests`, guest_count, recurring_event_id, etag, updated_at, synced_at |
| `calendar_sync_state` | key/value: last sync timestamp, token-invalid flag. Mirrors `canvas_sync_state` |

`google_events` cascades off `google_calendars`, relying on the
`PRAGMA foreign_keys = ON` already set in `openDb()`.

Three deliberate decisions:

- **No attendees table.** Exactly two facts about guests are needed: whether anyone
  else is on the event (which drives the CONSEQUENTIAL tier escalation) and how many
  (which the UI renders). `has_guests` and `guest_count` answer both. A join table
  would carry data nothing in this phase reads.
- **`enabled` is user state, never overwritten by sync.** Calendar metadata is
  upserted on every run, but the user's on/off toggle is preserved, so a resync
  cannot silently re-enable a calendar they turned off.
- **All-day events store Google's raw date string** (`2026-08-20`), not a timestamp,
  with `is_all_day` gating every formatting and layout path. Treating an all-day
  event as midnight UTC renders it on the wrong day for any user west of London —
  the most common calendar bug there is.

### Main-process modules

- **`src/main/calendar/oauth.ts`** — the loopback server, PKCE generation, `state`
  verification, and code exchange. The only module that opens a listening socket.
- **`src/main/calendar/token.ts`** — safeStorage get/set/clear for the refresh token,
  client ID, and client secret; in-memory access-token cache with expiry-aware
  refresh. Near-copy of `canvas/token.ts`'s pattern.
- **`src/main/calendar/client.ts`** — the only module that calls the Google API.
  Attaches the bearer token, refreshes it when stale, follows `pageToken`
  pagination, and maps failures to typed errors (`GoogleAuthError`,
  `GoogleRateLimitError`, `GoogleConflictError`, `GoogleNetworkError`) so no caller
  parses a status code.
- **`src/main/calendar/api.ts`** — thin typed endpoint wrappers: `listCalendars`,
  `listEvents`, `createEvent`, `updateEvent`, `deleteEvent`. No logic.
- **`src/main/calendar/sync.ts`** — `syncCalendarList()` and `syncEvents()`, both
  strictly serial. Never `Promise.all` over network calls.
- **`src/main/calendar/queries.ts`** — local SQLite reads for the renderer and the
  AI tools. Never touches the network.
- **`src/main/calendar/ipc.ts`** — renderer handlers, registered the same way as
  `canvas/ipc.ts`.

### Sync behavior

`syncCalendarList()` pulls `/users/me/calendarList` and upserts metadata, preserving
`enabled`.

`syncEvents()` iterates *enabled* calendars one at a time. For each, it fetches the
window with `singleEvents=true&orderBy=startTime&maxResults=250`, follows `pageToken`
to completion, then in a single transaction **deletes that calendar's rows inside
the window and reinserts** the fetched set. Rows outside the window are untouched.

Delete-and-reinsert rather than diffing is what keeps this small: an event deleted in
Google is simply absent from the response and therefore disappears locally, with no
tombstone tracking. The result is correct by construction instead of by bookkeeping.

**Disabling a calendar does not delete its rows.** Sync skips it and every query
filters on `enabled`, so a disabled calendar's events vanish from the UI immediately
and reappear instantly when re-enabled, without waiting for a refetch. Its rows go
stale in the meantime, which the next sync after re-enabling corrects.

### Shared scheduler extraction

Phase 3's `canvas/scheduler.ts` already solves self-rescheduling timers, the
focus throttle, and the in-flight exclusivity guard — a combination that required a
mid-implementation redesign and mutation testing to get right. Calendar needs the
same machine with different intervals.

The scheduler is therefore extracted to a shared
`createScheduler({ intervalMs, focusThrottleMs, run })`, consumed by both Canvas and
Calendar. The cost is modifying working, tested Phase 3 code; the mitigation is that
every existing Canvas scheduler test is retained and must still pass unchanged. The
alternative — a second hand-written copy of a concurrency-guarded scheduler — is
precisely the kind of duplication that drifts apart and produces an unreproducible
bug.

### Writes

`createEvent`, `updateEvent`, and `deleteEvent` call the API directly and then
resync that one calendar. There is no optimistic local insert: a short delay is
better than an event appearing in the UI and then vanishing because the API rejected
it.

Updates send `If-Match` with the stored etag. Without it, an edit from SmartLife
silently overwrites a change made elsewhere moments earlier and the user never finds
out.

### Renderer

Components live under `src/renderer/src/calendar/`, following the `school/` layout,
using `var(--color-*)` tokens and the existing `calendar` section theme from
`sectionThemes.ts`, with Tailwind for layout only.

**`/calendar`** — a week grid of 7 day columns spanning 6am–11pm, scrollable, with a
current-time indicator. A separate **all-day strip** sits above the grid, since
all-day events have no time slot. Overlapping events split the column width. Clicking
an empty slot opens the create dialog prefilled with that time; clicking an event
opens the edit dialog. A right-hand **agenda panel** lists upcoming events in order.

**Canvas overlay** — assignment deadlines read from the local `canvas_assignments`
table populated in Phase 3, requiring no new network calls. They render in School's
blue with a dashed edge so they are unmistakably not real calendar events, are not
editable, and navigate to the assignment in School when clicked. A single toggle
hides them. If Canvas is not connected the table is simply empty and no overlay
renders — the two integrations have no runtime dependency on each other, and
Calendar must work fully with Canvas disconnected.

**Empty state** — with no connection configured, `/calendar` renders a "Connect
Google Calendar in Settings" state, matching the pattern Phase 2 settled on and
Phase 3 reused.

**Settings** gains a Calendar block: Client ID and Client Secret fields, Connect and
Disconnect buttons, the connected account's email once authorized, and the calendar
list with per-calendar enable/disable toggles.

Google issues a client secret even for Desktop clients and the token exchange
requires it. It is explicitly not confidential for installed apps, but it is stored
safeStorage-encrypted regardless — there is no reason to leave it in plaintext.

### AI tools

Four tools appended to Phase 2's `TOOLS` registry. Because each tool calls `gate()`
itself rather than having a tier fixed at registration, a tool can resolve its
effective tier at call time.

| Tool | Tier |
|---|---|
| `calendar_list_events(start, end)` | READ |
| `calendar_create_event(...)` | SAFE_WRITE, escalating to CONSEQUENTIAL when guests are specified |
| `calendar_update_event(id, ...)` | SAFE_WRITE, escalating to CONSEQUENTIAL when the event has guests |
| `calendar_delete_event(id)` | CONSEQUENTIAL always |

The escalation exists because creating, moving, or deleting an event with attendees
sends email to real people. That is outward-facing and cannot be unsent, which puts
it in a different category from adding a solo study block. In **ask** mode every
write confirms regardless; the tiering determines behavior in **assist** mode.

No `find_free_time` tool. The model can read the event list and compute gaps itself;
a dedicated tool would reimplement arithmetic Claude already performs correctly.

Confirmation prompts must render the actual consequence, not the tool name — for
example: *"Delete 'Group project sync' — Thu Aug 27, 2:00–3:00 PM. 3 guests will be
notified."* A confirmation that does not state what will happen is a rubber stamp,
and this is the first phase where a rubber stamp costs something real.

## Error handling

| Condition | Behavior |
|---|---|
| `invalid_grant` / revoked token | Set the token-invalid flag, show a reconnect banner in Calendar and Settings, and **keep displaying mirrored events** |
| 403 rate limit | Back off and skip the cycle rather than retry-hammering |
| Write attempted while offline | Fail fast: "You're offline — this change wasn't saved" |
| 412 precondition failed on update | The event changed elsewhere first: resync and report "this event changed elsewhere — refreshed, try again" |
| 404 on a write | The event was deleted elsewhere: resync and report it plainly |
| Network error during sync | No error spam; the status line reports the last successful sync time |
| One calendar fails | Record, skip, and continue with the rest |

A dead credential means stale data, never a blank screen — the same principle Phase 3
established for the Canvas token.

## Testing

Follows the discipline of Phases 2 and 3. **No test performs a live Google call.**

- **`oauth.ts`** — fake loopback request and token exchange: assert a mismatched
  `state` is rejected, that the PKCE verifier is actually sent in the exchange, and
  that the server stops after one request.
- **`client.ts`** — fake `fetch`: `pageToken` pagination, expiry-triggered token
  refresh, and each error mapping (401/`invalid_grant` → `GoogleAuthError`, 403 →
  `GoogleRateLimitError`, 412 → `GoogleConflictError`, network failure →
  `GoogleNetworkError`).
- **`sync.ts`** — fake API responses against a real in-memory SQLite DB: events that
  vanish from Google disappear locally, a second sync is idempotent, all-day dates
  are not timezone-shifted, `enabled` survives a resync, and one calendar's failure
  does not abort the run.
- **`token.ts`** — mocked `safeStorage`, mirroring `apiKey.test.ts` and
  `canvas/token.test.ts`.
- **Scheduler** — every existing Canvas scheduler test must pass unchanged after the
  extraction, plus Calendar's own interval and throttle tests.
- **Tier escalation** — an explicit test that an event with guests gates as
  CONSEQUENTIAL in **assist** mode. This is the phase's central safety claim and
  must fail loudly if the escalation breaks.
- **Renderer** — render tests against a mocked `window.smartlife`: the no-connection
  empty state, week-grid event placement, the all-day strip, the Canvas overlay, and
  the expired-token banner.

Live end-to-end verification against the user's real Google account is a manual step
they perform after implementation, exactly as with the Anthropic key and the Canvas
token.

## External setup (user-performed)

Roughly five minutes, free, and performed entirely by the user — credentials are
never entered by the assistant:

1. Create or reuse a Google Cloud project.
2. Enable the Google Calendar API.
3. Configure the OAuth consent screen and **publish it to "In production"**.
4. Create an OAuth client of type **Desktop app**.
5. Paste the Client ID and Client Secret into SmartLife Settings.

## Success criteria

1. The connect flow completes in the system browser; Settings shows the connected
   account's email and its calendar list.
2. The week grid populates within seconds of connecting; subsequent launches are
   instant and work with the network off.
3. Creating, moving, and deleting events round-trips to Google and survives a
   resync.
4. Canvas due dates appear alongside real events and navigate to School when
   clicked.
5. "Schedule a 2-hour study block Thursday afternoon" creates the event after one
   confirmation in ask mode.
6. Asking the assistant to move an event that has guests confirms first even in
   assist mode.
7. Revoking access in Google account settings produces a reconnect banner with
   previously synced events still visible — not a crash or a blank screen.
