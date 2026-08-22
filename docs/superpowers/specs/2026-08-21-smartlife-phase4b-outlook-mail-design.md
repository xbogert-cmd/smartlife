# Phase 4b: Microsoft / Outlook Mail — Design

**Date:** 2026-08-21
**Status:** Approved
**Depends on:** Phase 1 (Foundation), Phase 2 (AI Core), Phase 4 (Google Calendar)
**Blocks:** Phase 6 (Planner) reads extracted events; nothing else

## Goal

Bring the user's real mail — which lives entirely in a university Microsoft
account — into SmartLife as a triage surface the AI assistant can act on, and
let deadlines and events mentioned in email land on the Google Calendar that
Phase 4 already built.

## How this differs from the roadmap entry

ROADMAP.md scoped Phase 4b as "Outlook mail *and* Outlook calendar merged into
the Phase 4 calendar views." Two things changed during brainstorming:

1. **Outlook calendar is dropped.** The user does not use it and confirmed it
   holds nothing worth reading — no class times, nothing. Dropping it removes
   the entire multi-provider problem: `google_calendars` / `google_events` stay
   Google-only, with no `provider` column, no merged week grid, no provider
   badges, and no second calendar sync engine.
2. **"Email → calendar" replaces "calendar merge"** as the integration point.
   The user's actual want was never two calendars in one grid; it was that an
   email saying "class is cancelled Thursday" should reach their calendar.

The roadmap's dependency ordering still holds, by a different route: Phase 6's
Planner wants class times, and those now arrive as extracted events on the
Google calendar rather than as synced Outlook events.

ROADMAP.md must be updated to reflect this scope change.

## Scope

### In

- Microsoft Entra OAuth (authorization code + PKCE, loopback redirect)
- A shared loopback OAuth helper extracted from Phase 4's `calendar/oauth.ts`
- Microsoft Graph client with token refresh, throttling, and typed errors
- Mail sync: Inbox and Sent Items, rolling 90 days, via Graph delta query
- A Mail nav section: message list, conversation grouping, search, reading pane
- Compose and reply, behind an un-bypassable confirmation
- A new permission tier that AUTO mode cannot bypass
- Three AI tools: `mail_search`, `mail_read`, `mail_send`
- Email → calendar event extraction with manual triggers, writing through
  Phase 4's existing `createCalendarEvent`

### Out (deliberate)

- **Outlook calendar sync** — see above
- **Folders beyond Inbox and Sent** — no folder tree, no archive, no custom
  folders
- **Attachments** — presence is shown (`has_attachments`); content is not
  fetched, downloaded, or sent
- **HTML rendering** — bodies are plain text only (see Auth & Storage below)
- **Drafts, flags, categories, move, delete**
- **Writing read-state back to Outlook** — reading a message in SmartLife does
  not mark it read in Outlook. This is deliberate: a triage surface should not
  mutate the mailbox as a side effect of looking at it.
- **Forwarding**
- **Background auto-scanning for events** — deferred, but the extraction seam
  is built to accept it without rework (see Deferred Work)

## Global Constraints

Inherited from the project and binding on every task:

- **Exactly two runtime dependencies:** `@anthropic-ai/sdk` and
  `better-sqlite3`. No new runtime dependency may be added by this phase. No
  MSAL, no mail parser, no HTML sanitizer, no FTS extension package.
- **Local-first:** anything already synced must remain readable with no network.
- Electron `safeStorage` (Keychain-backed) for all secrets; never a `.env` file.
- Access tokens are never persisted — in-memory cache only, matching
  `calendar/token.ts`.
- Migrations are additive and numbered; this phase adds `0007_mail.sql`. (Was
  `0005`; renumbered on 2026-08-21 because Phase 5 took `0005_browser.sql`, and
  again on 2026-08-22 because Phase 3b took `0006_submissions.sql`, while this
  phase sat blocked.)
- Main-process-only network access. The renderer reaches Graph only via IPC.
- No raw `shell` or Node API exposed to the renderer through the preload bridge.
- TDD with real assertions; no test may assert only that a function was called.

## External Setup (user-performed)

Azure app registration, free. The user performs every step; no credential is
ever entered by the assistant, pasted into a chat message, or written to a file
or fixture. The Client ID goes into the Settings field, where `safeStorage`
encrypts it into the Keychain.

**Verified against Microsoft's documentation on 2026-08-21:**

- **There is no client secret.** Per Microsoft: *"Public clients, which include
  native applications and single page apps, must not use secrets or
  certificates when redeeming an authorization code."* Desktop apps authenticate
  with PKCE alone. The user supplies **only a Client ID**.
- **Redirect URI must be `http://localhost`, not `http://127.0.0.1`.**
  Microsoft's docs recommend `127.0.0.1` in principle but then state that the
  Azure portal's Redirect URIs text box *rejects* `http` loopback URIs using the
  IP literal — adding one requires hand-editing the application manifest's
  `replyUrlsWithType` attribute. `http://localhost` is accepted normally.
- **The port is ignored when matching a localhost redirect URI:** *"Due to
  ephemeral port ranges often required by native applications, the port
  component ... is ignored for the purposes of matching a localhost redirect
  URI."* Phase 4's OS-assigned-port loopback server therefore works unchanged
  against a single registered `http://localhost`.
  - *Edge case:* Entra does not support the IPv6 loopback (`[::1]`) as a
    redirect URI. The loopback server must be reachable at whatever `localhost`
    resolves to on the machine. Bind so that an IPv4 resolution succeeds; if a
    dual-stack resolution order ever breaks this in practice, the documented
    fallback is registering `http://127.0.0.1` via the manifest editor.
- **Platform: "Mobile and desktop applications."** Microsoft's own guidance
  names this platform for *"macOS apps using cross-plat tech we don't support
  (Electron)"* — literally this app.
- **Supported account types:** accounts in any organizational directory **and**
  personal Microsoft accounts. Register the app under the user's *personal*
  Microsoft account directory so the university tenant's "users can register
  applications" policy is never involved.
- **Public client flow must be enabled** on the registration.
- **Delegated scopes:** `offline_access`, `User.Read`, `Mail.Read`, `Mail.Send`.
  All are user-consentable in principle; none are admin-restricted.
- **Refresh token lifetime:** native-app refresh tokens have no specified
  lifetime and are long-lived. There is no equivalent of Google's 7-day
  testing-mode expiry, so no "publish to production" step exists or is needed.

### The consent risk

The account is a university-controlled Entra tenant. If the tenant's user
consent policy is set to disallow user consent for third-party apps, sign-in
returns an admin-approval error and **a student cannot resolve it**. There is no
workaround and no partial degradation: without consent this phase cannot
function at all.

This cannot be determined from outside the tenant. **The app registration and a
single sign-in attempt must be completed before implementation begins.** If
consent is blocked, this phase does not proceed and the roadmap needs rework.

## Architecture

### File structure

```
src/main/oauth/loopback.ts          Shared PKCE + loopback-server helper
src/main/oauth/loopback.test.ts

src/main/mail/errors.ts             Typed Graph errors
src/main/mail/token.ts              Client ID + refresh token storage, token cache
src/main/mail/oauth.ts              Microsoft-specific auth on the shared helper
src/main/mail/client.ts             Authenticated Graph request + pagination
src/main/mail/api.ts                Typed Graph calls (delta, message, sendMail)
src/main/mail/sync.ts               Delta sync engine, prune, upsert
src/main/mail/queries.ts            Local reads: list, search, get, conversations
src/main/mail/writes.ts             Send + reply
src/main/mail/extract.ts            Email -> EventCandidate[] (the reusable seam)
src/main/mail/scheduler.ts          Thin wrapper over the shared scheduler
src/main/mail/ipc.ts                IPC channels

src/main/db/migrations/0007_mail.sql

src/main/ai/tools/mailSearch.ts
src/main/ai/tools/mailRead.ts
src/main/ai/tools/mailSend.ts

src/renderer/src/mail/types.ts
src/renderer/src/mail/useMail.ts
src/renderer/src/mail/MessageList.tsx
src/renderer/src/mail/ReadingPane.tsx
src/renderer/src/mail/ComposeDialog.tsx
src/renderer/src/mail/SendConfirmDialog.tsx
src/renderer/src/mail/CandidateList.tsx
src/renderer/src/mail/formatters.ts
src/renderer/src/routes/Mail.tsx
```

Modified: `src/main/ai/permissions.ts`, `src/main/ai/tools/registry.ts`,
`src/main/calendar/oauth.ts` (to consume the extracted helper),
`src/main/index.ts`, `src/preload/index.ts`,
`src/renderer/src/nav/sections.ts`, `src/renderer/src/nav/sectionThemes.ts`
(and its existing `sectionThemes.test.ts`),
`src/renderer/src/routes/Settings.tsx`, `ROADMAP.md`.

### Shared loopback OAuth helper

Phase 4's `runOAuthFlow` contains a hardened one-request-then-shutdown loopback
server, including the fix for the Critical race its review caught (`settled`
flips synchronously the instant a valid request is committed to processing,
before the async token exchange begins). Rather than write a second one, extract
`src/main/oauth/loopback.ts` exactly as Phase 4 extracted the shared scheduler
from Canvas.

**`src/main/calendar/oauth.test.ts` is unmodifiable acceptance criteria for this
extraction.** It must pass byte-identical, verified by diffing against the
merge-base, exactly as `canvas/scheduler.test.ts` gated the Phase 4 scheduler
extraction.

The helper owns: PKCE pair generation (S256), `state` generation and
verification, the ephemeral loopback server with its settle-race protection,
the timeout, and returning the authorization code. Providers supply their own
authorize-URL construction, token endpoint, and token-response parsing.

### Storage

`src/main/db/migrations/0007_mail.sql`:

```sql
create table mail_messages (
  -- Plain primary key, not the composite Phase 4 needed: a Graph message
  -- lives in exactly one folder, and Graph reassigns the id when a message
  -- moves between folders.
  id text primary key,
  folder text not null,                       -- 'inbox' | 'sentitems'
  conversation_id text,
  subject text,
  from_name text,
  from_email text,
  to_recipients text not null default '[]',   -- JSON array of {name,email}
  cc_recipients text not null default '[]',
  received_at text not null,                  -- RFC3339
  preview text,                               -- Graph bodyPreview
  -- NULL until the body is fetched on first read. See "Bodies are lazy".
  body_text text,
  is_read integer not null default 0,
  has_attachments integer not null default 0,
  web_link text,
  synced_at text not null default (datetime('now'))
);

create index mail_messages_received_idx
  on mail_messages(received_at desc);
create index mail_messages_folder_received_idx
  on mail_messages(folder, received_at desc);
create index mail_messages_conversation_idx
  on mail_messages(conversation_id);

create table mail_sync_state (
  key text primary key,
  value text not null
);
```

`mail_sync_state` holds one delta link per folder (`delta:inbox`,
`delta:sentitems`), `lastSyncedAt`, and `mirrorPartial` (see the 5,000 cap).

The connected account's email address is stored in the existing `settings`
table, matching how Phase 4 stores the Google account address.

**Attendee-style omission:** no attachment metadata table. `has_attachments` is
a boolean for display; nothing in this phase reads attachment content, so
nothing stores it.

### Sync

Graph delta query, per folder. Verified constraints from Microsoft's delta-query
documentation, all of which the design depends on:

- The only supported `$filter` expressions are
  `$filter=receivedDateTime ge {value}` and `... gt {value}` — which is exactly
  the 90-day bound needed.
- The only supported `$orderby` is `receivedDateTime desc`.
- `$select` and `$top` are supported; `$search` is not.
- Deletions are reported as entries carrying `@removed`.
- **Applying `$filter` in a delta query returns only up to 5,000 messages.**

**Initial sync (per folder, when no delta link is stored):**
`GET /me/mailFolders/{inbox|sentitems}/messages/delta` with the 90-day
`receivedDateTime ge` filter, an explicit `$select` of only the columns above,
and `Prefer: odata.maxpagesize`. Page through `@odata.nextLink`, then store the
final `@odata.deltaLink`.

**Incremental sync:** fetch the stored delta link, apply creates/updates as
upserts and `@removed` entries as row deletions, store the returned delta link.

**Prune:** delete rows whose `received_at` precedes the 90-day boundary.

**The 5,000 cap is surfaced, never silent.** If an initial filtered sync reaches
5,000 messages, set `mirrorPartial` in `mail_sync_state` and display in the Mail
UI that older mail is not mirrored. A silent truncation would read to the user
as "there is no older mail," which is false.

**Pagination is serial.** Page N+1's continuation token cannot exist until page
N resolves, so this is structurally serial, matching Phase 3's Canvas client and
Phase 4's `googleFetchAll`. No `Promise.all` fan-out over pages.

**A safety page cap** bounds the loop in case a continuation link ever fails to
terminate, matching `MAX_PAGES` in `calendar/client.ts`.

#### Bodies are lazy

Delta sync stores metadata plus `bodyPreview` only. `body_text` stays NULL until
the message is first opened — by the reading pane or by the `mail_read` AI tool
— at which point the body is fetched and cached in the same row.

Fetching bodies requests plain text via the `Prefer:
outlook.body-content-type="text"` header, which makes Graph convert HTML
server-side. **No email HTML ever enters the application.** This is a security
decision, not a formatting one: it eliminates the injection surface entirely
rather than mitigating it, in a renderer that holds the trusted `window.smartlife`
IPC bridge. Phase 3's final review already found a navigation hole originating
in *sanitized* Canvas HTML; arbitrary-sender email HTML is strictly more
hostile, and the existing `school/sanitizeHtml.ts` is a denylist that was
designed for instructor-authored content.

The `Prefer` header must be sent on **every** request in a delta chain. Graph
encodes query options into the continuation links but does not encode headers.

**Accepted trade-off:** full-text search covers only messages whose bodies have
been fetched. Subject, sender, and preview are always searchable. A
"download all bodies" backfill is a small later addition if this proves
limiting.

#### Scheduler

Reuses `src/main/scheduler.ts` (`createScheduler`) unchanged, with mail's own
values: **5 minute background interval, 1 minute focus throttle** (calendar uses
30 / 5). Delta returns an empty page when nothing changed, so idle polling is
close to free.

Mail sync runs under the same `runExclusive` guard, so a manual refresh can
never overlap a background sync — the protection Phase 3's review had to
retrofit and Phase 4's had to extend.

#### Refresh token rotation

**Microsoft rotates the refresh token on every refresh.** Phase 4's client
comments that Google *usually omits* a rotated token, making persistence a
defensive measure there. Here it is mandatory: failing to persist the returned
refresh token strands the app on a dead credential at the second refresh. This
gets an explicit test asserting the newly returned token is written to storage.

### Permission tier

`src/main/ai/permissions.ts` gains a fourth tier, `ALWAYS_CONFIRM`, which pauses
in **every** mode including `auto`:

```ts
export type ToolTier = 'READ' | 'SAFE_WRITE' | 'CONSEQUENTIAL' | 'ALWAYS_CONFIRM';

const PAUSE_TIERS: Record<AiMode, ToolTier[]> = {
  ask: ['SAFE_WRITE', 'CONSEQUENTIAL', 'ALWAYS_CONFIRM'],
  assist: ['CONSEQUENTIAL', 'ALWAYS_CONFIRM'],
  auto: ['ALWAYS_CONFIRM'],
};
```

> **Superseded on 2026-08-22, while this phase was blocked.** Two things above
> are now out of date and must not be re-implemented from this text:
>
> 1. **The tier already exists.** Phase 3b
>    (`2026-08-22-smartlife-phase3b-canvas-submissions-design.md`) delivers
>    `ALWAYS_CONFIRM` for `canvas_submit_assignment`. When this phase unblocks,
>    `mail_send` joins the existing tier rather than introducing it.
> 2. **`assist` now also pauses `SAFE_WRITE`.** Phase 5's final review found the
>    original `assist` row let `SAFE_WRITE` calendar writes run unconfirmed,
>    contradicting that phase's own safety claim; the user chose to close the gap
>    rather than correct the prose. The live row is
>    `assist: ['SAFE_WRITE', 'CONSEQUENTIAL', 'ALWAYS_CONFIRM']`, matching `ask`.
>
> Read `src/main/ai/permissions.ts` as the source of truth, not this block.

The tier is for actions that are both **irreversible and outward-facing** —
where the consequence leaves the machine and reaches another person. `mail_send`
is its first member. Phase 3b's Canvas assignment submission is the intended
second.

A dedicated regression test asserts
`resolveExecutionMode('ALWAYS_CONFIRM', 'auto') === 'pause'`. That single
assertion is the entire guarantee and must fail loudly if `auto` is ever
"simplified" back toward an empty array.

The AI mode UI notes that some actions confirm even in AUTO, so the mode's
behavior is not misrepresented.

### UI

**Nav section:** `{ slug: 'mail', label: 'Mail', path: '/mail' }`, inserted into
`NAV_SECTIONS` immediately after `calendar` and before `school`. Section theme
`{ gradient: 'linear-gradient(135deg, #7F1D1D, #EF4444)', accent: '#EF4444' }` —
the clearly-unused hue in the existing registry (goals' `#F472B6` is a pastel
pink, distinct at a glance).

**Two panes.**

*Message list (left):* Inbox/Sent toggle, search input, and the list. Each row
shows sender name, subject, preview snippet, relative time, an unread dot, and
a paperclip when `has_attachments`. Consecutive messages sharing a
`conversation_id` collapse into one row showing the most recent message and a
count.

*Reading pane (right):* subject, from, to/cc, timestamp, body as wrapped plain
text, an "Open in Outlook" link routed through the existing external-link
handler, and two actions: **Reply** and **Find dates**.

**Disconnected and empty states** follow Phase 4's `ConnectBanner` pattern
rather than introducing a new one. As in Phase 4, "not yet loaded" and "not
connected" collapse into a single code path; there is no separate loading state.

**Compose dialog:** to, cc, subject, body. Reply prefills recipient and subject
and quotes the original.

**Send confirmation dialog:** shows every recipient address in full, the
subject, and the **complete** body — not a truncated preview. An approval the
user cannot fully read is not an approval. Declining must prevent the network
call, not merely close the dialog.

**Settings:** a Microsoft account block following the disambiguation pattern the
Canvas and Google Calendar blocks established (`role="region"` with a
distinguishing `aria-label`). One field: Client ID. Connect / Disconnect.

### AI tools

**`mail_search`** — tier `READ`. Inputs: `query` (optional), `folder`
(`inbox` | `sent` | `both`, default `both`), `since` (optional ISO date),
`limit` (default 20, max 50). Reads the **local database only** — no network, so
it is instant and free. Returns id, sender, subject, receivedAt, preview,
isRead, hasAttachments.

The tool's `sent` value maps to the `sentitems` value stored in
`mail_messages.folder`. The tool surface uses the human word; the database uses
Graph's well-known folder name. This mapping lives in one place in
`queries.ts` — it must not be duplicated across the tool, the IPC layer, and
the UI.

**`mail_read`** — tier `READ`. Input: `messageId`. Returns the full plain-text
body and all recipients, fetching from Graph and caching when `body_text` is
NULL.

Both tools prefix their response with today's local date and the connected
account's email address — the same fix Phase 4's final review added to
`calendar_list_events`, so the model can resolve relative dates and knows which
address is "me."

**`mail_send`** — tier `ALWAYS_CONFIRM`. Inputs: either `replyToMessageId` plus
`body`, or `to` plus `subject` plus `body`, with optional `cc`. Its confirmation
description names every recipient and the subject, so the confirmation prompt is
meaningful rather than generic.

Search is `LIKE` over subject, sender name, sender address, preview, and any
cached body — no FTS5, no new dependency. A few thousand rows of short text is a
sub-50ms scan. This carries a `ponytail:` comment naming the ceiling and FTS5 as
the upgrade path, so the limit is documented rather than discovered.

### Email → calendar extraction

The extraction entry point is a **main-process function, not an AI tool**:

```ts
export interface EventCandidate {
  summary: string;
  startAt: string;         // RFC3339, or YYYY-MM-DD when isAllDay
  endAt: string;
  isAllDay: boolean;
  location?: string;
  sourceMessageId: string;
  confidence: 'high' | 'low';
  rationale: string;       // the sentence the date was drawn from
}

export async function extractEventCandidates(
  db: Database.Database,
  messages: MailMessage[]
): Promise<EventCandidate[]>
```

It calls Claude directly through the existing provider layer with a structured
extraction prompt — not through the chat loop — and returns candidates.

**This shape is the whole point.** An IPC handler calls it today for the "Find
dates" button; the mail scheduler will call the same function unchanged when
background scanning is added. Burying this logic in a click handler would make
that later addition a rewrite.

`rationale` is required, not decorative: showing the sentence a date came from
is what makes a candidate judgeable at a glance instead of something the user
must go verify in the original message.

Candidates render in `CandidateList.tsx` as a checklist the user approves,
edits, or discards. Approval calls Phase 4's existing `createCalendarEvent`,
defaulting to the primary Google calendar with the others selectable.

**The conversational path needs no new code.** "Anything in my email I should
put on my calendar?" is already satisfiable: the assistant searches with
`mail_search`, reads with `mail_read`, and calls the existing
`calendar_create_event`, which gates at its existing tier. This is why the
manual-first sequencing costs nothing.

Extraction never writes to the calendar on its own. Every candidate requires an
explicit user approval, in every AI mode.

## Error handling

Each condition gets its own typed error and its own user-facing sentence.
Generic failures that send the user debugging the wrong thing are the failure
mode being designed against.

| Condition | Behavior |
|---|---|
| Consent blocked (`AADSTS65001`, `consent_required`, admin-approval required) | Distinct banner stating the university's tenant blocked third-party app consent, and what to ask IT for. Never surfaced as a generic sign-in failure. |
| Refresh token revoked or expired | Banner in the Canvas `TokenBanner` idiom; cached mail stays readable. |
| Graph throttling (HTTP 429) | Honor `Retry-After`. Typed rate-limit error mirroring `GoogleRateLimitError`. |
| Network failure / offline | Cached mail reads normally. Staleness shown in the status line. No modal. |
| Send failure | Surfaced prominently and never swallowed. A failed send rendered as success is the worst outcome in this phase. |
| Mirror hit the 5,000-message cap | Stated in the UI; `mirrorPartial` recorded in sync state. |
| Message body fetch fails | The row still lists and reads from `preview`; the pane shows that the body could not be loaded. |

## Testing

Standard project discipline — TDD, real assertions, no call-count-only tests —
plus these specific gates:

- **`resolveExecutionMode('ALWAYS_CONFIRM', 'auto') === 'pause'`** — the single
  assertion guaranteeing AUTO cannot send mail.
- **Refresh-token rotation persists** — refresh returns a new token; assert it
  is written to storage, then assert a second refresh uses the new one.
- **`calendar/oauth.test.ts` passes byte-identical** after the loopback
  extraction, verified by diff against merge-base.
- **Delta `@removed` deletes the local row.**
- **Declining the send confirmation prevents the network call** — asserted on
  the request layer, not on dialog visibility.
- **The 5,000-cap path sets `mirrorPartial`** rather than terminating silently.
- **Prune deletes only rows outside the window**, including a boundary case at
  exactly the 90-day edge. (Phase 4's equivalent boundary bug survived a full
  review round; this one is tested up front.)
- **`Prefer` header is sent on continuation requests**, not only the first.

## Deferred work

Committed follow-ups, recorded so they are not rediscovered as gaps:

1. **Background event scanning.** The user explicitly wants this — "could be the
   last thing we do but in some way or form." `extractEventCandidates` is built
   as the seam. Adding it requires a local pre-filter (does the message even
   mention a date?) to bound token cost, a suggestions table with dismissal
   state, and dedupe against already-created events. No rework of this phase.
2. **"Download all bodies" backfill**, if lazy bodies prove limiting for search.
3. **FTS5**, if `LIKE` search measurably falls short.
4. **HTML rendering in a sandboxed iframe** (`sandbox` without `allow-scripts`
   or `allow-same-origin`), if plain text proves inadequate for real mail.
5. **Attachments**, if needed.

## Open risk

**University consent policy is unresolved and is a hard gate.** The Azure app
registration and one sign-in attempt must be completed before implementation
begins. If the tenant disallows user consent for third-party applications, this
phase cannot proceed in any reduced form, and the roadmap requires rework —
Phase 6's Planner would then need class times from another source.
