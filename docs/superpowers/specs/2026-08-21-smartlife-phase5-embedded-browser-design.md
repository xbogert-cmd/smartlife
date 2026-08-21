# Phase 5: Embedded Browser — Design

**Date:** 2026-08-21
**Status:** Approved
**Depends on:** Phase 1 (Foundation), Phase 2 (AI Core)
**Blocks:** Phase 3b (Canvas submissions) — this phase is its sole remaining dependency

## Goal

Give SmartLife a real embedded browser: tabs, navigation, and a persistent
session, so the user can do the Canvas work its REST API cannot express, and so
the AI assistant can read what is on screen.

## How this differs from the roadmap entry

ROADMAP.md scoped Phase 5 as "Tabs, navigation, page-text extraction, AI browser
context/tools, Canvas-in-browser." During brainstorming the user confirmed all
four of the possible purposes — AI page reading, Canvas fallback, real browsing,
and letting the AI click and fill on their behalf.

**The fourth is split out into a new Phase 5b.** Two reasons:

1. **Prompt injection.** Once the AI can both read pages and act on them, every
   page becomes a potential instruction source, and there is no reliable way to
   separate "content the user asked about" from "text telling the model what to
   do." Read-only bounds the blast radius to a misleading *answer*, which the
   user sees and can judge. Read-plus-act extends it to an *action*, which they
   may not notice until afterward.
2. **Size and review attention.** Element addressing, an injected action
   protocol, execution, and a pre-action confirmation UI is 8-10 tasks that all
   presuppose a working browser. Bolting them onto the end of an already long
   phase puts the riskiest code in the app exactly where review attention is
   thinnest.

Phase 3b is unaffected: submitting a quiz or a discussion post in the embedded
browser requires the browser and a persistent Canvas session, not an agent.

ROADMAP.md must be updated to add Phase 5b and reflect this split.

## Scope

### In

- One `WebContentsView` per tab, with a shared persistent session partition
- Tabs, address bar (URL or search), back / forward / reload / stop
- Find-in-page
- Recent-history suggestions in the address bar, pruned to 90 days
- Download handling with an explicit per-download confirmation
- Full security policy: scheme allowlist, popup handling, permission denial
- Page-text extraction
- Two READ-tier AI tools: `browser_list_tabs`, `browser_read_page`
- A "Clear browsing data" control in Settings

### Out (deliberate)

- **Any AI action on a page** — no navigate, no click, no type, no form fill.
  This includes `browser_open_url`, which is deferred to 5b rather than
  included as a "small" exception: a hostile page persuading the model to
  navigate somewhere it then reads is a self-reinforcing chain, and the clean
  line is "the user drives, the AI reads."
- **Bookmarks and a browsable history page** — recent-history suggestions in
  the address bar only
- **Download manager UI** — downloads are confirmed and written, not tracked
- **Zoom controls, per-site permission UI, reader mode, extensions,
  ad blocking, private/incognito mode**
- **Restoring tabs across app restarts** — the session persists (cookies,
  logins), the open tab set does not

## Global Constraints

Inherited from the project and binding on every task:

- **Exactly two runtime dependencies:** `@anthropic-ai/sdk` and
  `better-sqlite3`. This phase adds none. No readability library, no HTML
  parser, no ad-block list.
- Main-process-only privileged operations. The renderer reaches the browser
  only through IPC.
- No raw `shell` or Node API exposed to the renderer through the preload bridge.
- Migrations are additive and numbered; this phase adds `0005_browser.sql`.
- TDD with real assertions; no test may assert only that a function was called.
- The existing main-window navigation guards must not be weakened.

## External setup

**None.** No account, no OAuth, no API key, no cost, nothing to wait on. This is
why Phase 5 was selected while Phase 4b sits blocked on university IT approval.

## Architecture

### Rendering primitive: `WebContentsView`

This is forced rather than chosen, for two independent reasons.

**The existing security guard forbids the alternative.** `src/main/index.ts:65`
prevents the main window from navigating anywhere but its own app content, and
its comment states why: Electron re-runs the preload script on same-`webContents`
navigation, which would hand the destination page the full `window.smartlife`
IPC bridge. That guard is correct and stays. Embedded web content therefore
cannot share the main window's `webContents` and must have its own.

**Electron's documentation rules out the other options.** The `<webview>` tag
now carries an explicit warning — it is *"based on Chromium's webview, which is
undergoing dramatic architectural changes. This impacts the stability of
webviews, including rendering, navigation, and event routing. We currently
recommend to not use the webview tag"* — and points to `iframe` or
`WebContentsView`. `iframe` cannot render arbitrary third-party sites, since
most (Canvas near-certainly included) send `X-Frame-Options` or
`frame-ancestors` directives forbidding embedding.

`BrowserView` is deprecated in favour of `WebContentsView` and is not
considered.

**The consequence that shapes the UI:** a `WebContentsView` is a native view
composited *above* the window's HTML content, not an element inside the React
tree. React can draw around it but never over it. Both problems this creates are
designed for below rather than discovered during implementation.

### File structure

```
src/main/browser/view.ts        WebContentsView lifecycle, bounds, visibility
src/main/browser/view.test.ts
src/main/browser/tabs.ts        Pure tab-state reducer
src/main/browser/tabs.test.ts
src/main/browser/security.ts    Pure policy predicates + thin session wiring
src/main/browser/security.test.ts
src/main/browser/address.ts     resolveAddressInput + filename sanitization
src/main/browser/address.test.ts
src/main/browser/extract.ts     buildExtractionScript + extraction entry point
src/main/browser/extract.test.ts
src/main/browser/downloads.ts   will-download handling
src/main/browser/downloads.test.ts
src/main/browser/history.ts     Visit recording, prefix lookup, pruning
src/main/browser/history.test.ts
src/main/browser/ipc.ts         IPC channels
src/main/browser/ipc.test.ts

src/main/db/migrations/0005_browser.sql

src/main/ai/tools/browserListTabs.ts
src/main/ai/tools/browserReadPage.ts
src/main/ai/tools/browserTools.test.ts

src/renderer/src/browser/types.ts
src/renderer/src/browser/useBrowser.ts
src/renderer/src/browser/TabStrip.tsx
src/renderer/src/browser/AddressBar.tsx
src/renderer/src/browser/FindBar.tsx
src/renderer/src/browser/ViewportSlot.tsx    Bounds-reporting placeholder
src/renderer/src/browser/DownloadPrompt.tsx
src/renderer/src/routes/Browser.tsx
```

Modified: `src/main/index.ts` (wire browser IPC and the view host),
`src/preload/index.ts` (add the `browser` bridge object),
`src/main/ai/tools/registry.ts`, `src/renderer/src/routes/Settings.tsx`,
`ROADMAP.md`, and the Phase 4b spec's migration number.

The `browser` nav slug and its teal theme (`#2DD4BF`) already exist in
`NAV_SECTIONS` and `sectionThemes.ts` as a `ComingSoon` placeholder. No nav
entry is added; the placeholder route is replaced.

### Bounds synchronisation

React owns layout; the native view is not in that layout. `ViewportSlot.tsx`
renders an empty positioned `<div>`, observes it with a `ResizeObserver`, and
reports its rectangle over IPC. The main process calls `setBounds()` with it.

It must fire on mount, on window resize, on sidebar collapse or expansion, and
on route change. **On navigating away from `/browser` the view is hidden**,
otherwise the page floats above the calendar and every other section.

The rectangle-to-bounds conversion (device pixel ratio, integer rounding, clamping
to non-negative dimensions) is a pure function tested directly.

### Overlay suspension

Cmd+J (AI overlay), Cmd+K (command palette), and any dialog are React and will
be painted *under* the native view. The view is therefore hidden while any
overlay is open.

**This must be a counter, not a boolean.** With a boolean, opening Cmd+K on top
of Cmd+J and then closing one restores the view while the other is still open —
the page reappears over a live overlay. The counter increments on open,
decrements on close, and the view is visible only at zero. It is a pure module
with its own tests, including the two-open-one-close case.

### Tab model

A pure reducer over:

```ts
interface Tab {
  id: string;              // app-generated, not a webContents id
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: { code: number; description: string } | null;
}
```

plus an `activeTabId`. Operations: open, close, activate, navigate, goBack,
goForward, reload, stop, and event-driven updates from the view layer
(`did-start-loading`, `did-stop-loading`, `page-title-updated`,
`did-navigate`, `did-fail-load`).

**Closing the last tab leaves one blank tab** rather than zero. There is never a
"no tabs" state to design around.

The reducer is tested directly; the `WebContentsView` layer follows its output
and holds no state of its own.

### Address bar

One pure function:

```ts
resolveAddressInput(input: string): string
```

- Input with a scheme is used as-is (subject to the navigation allowlist)
- Input that is host-shaped — contains a dot, contains no whitespace — gets
  `https://` prefixed
- Anything else becomes a search

**Default search engine: DuckDuckGo** (`https://duckduckgo.com/?q=`). Chosen
deliberately: no account, no tracking, and no configuration surface needed.
Recorded here as a decision rather than left as an accident of implementation.

Typing shows recent history entries whose URL or title matches the prefix.

### Find-in-page

Wraps `findInPage` / `stopFindInPage`, listening to `found-in-page` for the
match count and active ordinal. Escape closes the bar and clears the selection.

### History

```sql
create table browser_history (
  url text not null,
  title text,
  visited_at text not null default (datetime('now'))
);
create index browser_history_visited_idx on browser_history(visited_at desc);
create index browser_history_url_idx on browser_history(url);
```

Written on successful navigation. Pruned to the last 90 days on app start so it
cannot grow without bound.

## Security and session

This is the largest attack surface the application has ever had: arbitrary
third-party web content running inside an Electron app whose main renderer holds
a trusted IPC bridge.

### Session partition

All tabs share `persist:browser`. This is load-bearing twice over:

- **Function:** the Canvas login survives tab switches and app restarts, which
  is the entire premise of Canvas-in-browser and of Phase 3b.
- **Correctness:** the app's Content-Security-Policy is applied to
  `session.defaultSession` only (`src/main/index.ts:121`). Embedded pages must
  *not* inherit `default-src 'self'`, which would break every website. Using a
  non-default partition is what prevents that.

Third-party cookies and site data are therefore persisted on disk. The
"Clear browsing data" control in Settings exists because of this, not as
decoration.

### `webPreferences` on every `WebContentsView`

```ts
{ contextIsolation: true, nodeIntegration: false, sandbox: true }
```

**No `preload` key is ever set.** `window.smartlife` cannot exist in embedded
content because nothing ever puts it there. This is the single assumption the
whole security model rests on, and it gets a dedicated test asserting the
constructed options contain no preload.

`webSecurity` remains at its default (`true`) and is never disabled.

### Navigation policy — allowlist, not blocklist

Embedded contents may navigate to `http:`, `https:`, and `about:blank`.
Everything else is refused:

- `file:` — a page navigating to `file:///Users/…` has no legitimate purpose here
- `data:` and `blob:` for top-level navigation — standard page-spoofing vectors
- `javascript:` and all custom or application schemes

Implemented as a pure predicate in `security.ts`, tested directly without an
Electron window, and wired to `will-navigate` and `will-redirect` on each
embedded `webContents`.

A blocked navigation surfaces *why* it was blocked. Silently doing nothing reads
as a bug.

### Popups open as tabs, never as windows

`setWindowOpenHandler` on embedded contents **always returns
`{ action: 'deny' }`**, and the handler then creates a tab itself when the URL
passes the allowlist.

Returning `allow` would delegate window creation to Electron with
`webPreferences` we did not specify. Deny-then-create-our-own guarantees every
rendering surface in the application was configured deliberately. A test asserts
`deny` is returned for every input, including URLs that pass the allowlist.

### Permissions: deny all, and record it

Both `setPermissionRequestHandler` **and** `setPermissionCheckHandler` are
installed on the partition. The synchronous check handler is easy to omit, and
omitting it means some permission checks silently succeed.

Every permission type is denied: camera, microphone, geolocation, notifications,
MIDI and MIDI SysEx, pointer lock, fullscreen, display capture, clipboard read,
idle detection, HID, serial, USB, Bluetooth, and `openExternal`.

Rather than guess at an allowlist, denials are recorded via the existing logger.
If something genuinely needed breaks, that produces evidence instead of a
theory, and the allowlist can be revisited with a real case behind it.

### Downloads

`will-download` pauses the item and surfaces a confirmation naming the filename,
the byte size, and the source URL. On approval the file is written to the user's
`~/Downloads`; on decline the item is cancelled.

The save path is set synchronously in the handler before the download proceeds,
otherwise Electron presents its own dialog.

**The filename is attacker-controlled** and is sanitized: path separators
stripped, `..` sequences removed, leading dots and absolute paths rejected,
falling back to a safe default when nothing usable remains. This is a pure
function with its own tests, including traversal attempts.

Nothing is ever executed — only written.

### Certificate errors

**No `certificate-error` handler is registered.** Electron's default behaviour
is to reject invalid certificates. The classic mistake is adding a handler that
calls `callback(true)` to silence a warning during development; this design
states explicitly that none exists, so its later addition is a visible change
rather than an oversight.

### Untrusted content fencing

Extracted page text reaching the AI is wrapped in explicit delimiters with a
preamble stating that the enclosed content is untrusted third-party material,
that it is data rather than instructions, and that directives appearing inside
it must never be followed.

**Stated honestly: fencing is mitigation, not a guarantee.** No prompt-level
defence is airtight. The structural protection is that **Phase 5 introduces no
new write tools at all.** The worst a hostile page can attempt is to talk the
model into using tools it already holds — and calendar writes are already
tier-gated, so under `ask` and `assist` the user would see a confirmation
prompt for an action they never requested.

**Residual risk, accepted and recorded:** under `auto` mode there is no such
confirmation, so a successful injection could reach an existing calendar write
tool without the user seeing a prompt. This is a known consequence of `auto`
mode's existing design, not something Phase 5 introduces, and it is one of the
motivations for the `ALWAYS_CONFIRM` tier that Phase 4b specified and Phase 5b
will need.

## Page-text extraction

`buildExtractionScript(maxChars)` is a pure function returning the JavaScript
string executed via `executeJavaScript` in the target tab. The script:

1. Selects `document.querySelector('main, article')`, falling back to
   `document.body`
2. Clones it, then removes `script, style, noscript, nav, footer, aside, iframe`
3. Reads `innerText`, collapses runs of whitespace
4. Truncates to `maxChars`, reporting whether truncation occurred

Returns `{ url, title, text, truncated }`. `maxChars` is **40,000** — roughly
10,000 tokens.

**PDFs are detected and refused honestly.** Canvas serves a great many PDFs, and
Chromium renders them in a built-in viewer whose `innerText` is empty or
meaningless. Extraction detects this case and reports that the tab is a PDF and
text extraction is unsupported, rather than returning an empty string — which
the model would read as "the page is blank." A wrong answer that looks right is
worse than an honest refusal.

Extraction attempted before a load completes returns an explicit "no content
yet" for the same reason.

## AI tools

Both are `READ` tier. Neither performs any action.

**`browser_list_tabs`** — no input. Returns each tab's index, title, URL, and
whether it is active, so the assistant can reason about what is open.

**`browser_read_page`** — optional `tabIndex`, defaulting to the active tab.
Returns the fenced extraction result. **The source URL is stated prominently**
so the model has the originating domain available when weighing what it is
reading.

## Settings

A Browser block following the disambiguation pattern established by the Canvas
and Google Calendar blocks (`role="region"` with a distinguishing `aria-label`),
containing a single **Clear browsing data** action that clears history, cookies,
and cache for the `persist:browser` partition, behind a confirmation.

## Error handling

| Condition | Behaviour |
|---|---|
| `did-fail-load` | Error code and description shown in the viewport with a retry control. Never a blank white rectangle. |
| `render-process-gone` | "This tab crashed" with a reload control. One bad page must never take down the application. |
| `unresponsive` | Surfaced, with an option to close the tab. |
| Blocked scheme | States which scheme was blocked and why. |
| Extraction before load | Explicit "no content yet", never an empty string. |
| Extraction on a PDF | Explicit "PDF, text extraction unsupported". |
| Download declined | No file written, no error state. |
| Download filename unusable after sanitization | Falls back to a safe generated name. |

## Testing

Standard project discipline, plus these gates specific to this phase:

- **The main window's `will-navigate` guard is byte-identical**, verified by
  diff against merge-base — the same technique used to gate Phase 4's scheduler
  extraction.
- **No `preload` is ever passed to a `WebContentsView`**, asserted on the
  constructed options object. The entire security model rests on this.
- **`setWindowOpenHandler` returns `deny` for every input**, including URLs that
  pass the navigation allowlist.
- **Navigation allowlist**, table-driven across `http`, `https`, `about:blank`,
  `file`, `data`, `blob`, `javascript`, and a custom scheme.
- **Every permission type is denied**, table-driven.
- **Filename sanitization** rejects `../`, absolute paths, and separator
  injection.
- **The suspend counter remains hidden after two opens and one close.**
- **`resolveAddressInput`** across scheme'd input, host-shaped input, and search
  text.
- **Bounds conversion** for fractional device pixel ratios and zero/negative
  dimensions.
- **History pruning** removes only entries outside the 90-day window, including
  a boundary case at exactly 90 days.

Because the suite runs under `ELECTRON_RUN_AS_NODE=1` with no real
`BrowserWindow`, all of the above are pure-function or fake-injected tests. The
Electron-touching layer is kept deliberately thin and logic-free so that this is
possible.

## Migration numbering

Phase 4b's spec claims `0005_mail.sql`. Phase 4b is blocked on university IT
approval and unbuilt, so Phase 5 takes `0005_browser.sql` and the Phase 4b spec
is amended to `0006_mail.sql`. Amending it now prevents a collision that would
otherwise surface only when 4b resumes.

## What Phase 3b will need from this

Pinned now so Phase 5 delivers the right seam rather than something 3b retrofits:

1. **A persistent Canvas session** — 3b's browser fallback is only usable if the
   user's Canvas login survives. `persist:browser` provides this.
2. **Programmatic tab opening from other parts of the app** — 3b needs to open a
   specific Canvas assignment URL in a tab and switch the user to the Browser
   section. The IPC surface exposes `openTab(url)` to the renderer for this,
   which is distinct from an AI tool: the app may open tabs, the AI may not.
3. **Navigation completion events** — 3b will want to know when a submission
   page has finished loading. The tab model's `loading` transitions cover this.

No further work is required in Phase 5 to satisfy these; they are properties of
the design above, recorded so they are not accidentally removed.

## Deferred to Phase 5b

- `browser_open_url` and all other AI navigation
- Element addressing and an injected query/action protocol
- AI clicking, typing, and form filling
- A pre-action confirmation UI showing exactly what is about to be interacted
  with, before it happens
- The `ALWAYS_CONFIRM` permission tier specified in Phase 4b's design, which 5b
  requires and which 4b will not deliver while it remains blocked

## Deferred indefinitely

- Bookmarks, a browsable history page, a download manager UI
- Zoom, reader mode, per-site permission management
- Tab restoration across restarts
- Extensions and content blocking
