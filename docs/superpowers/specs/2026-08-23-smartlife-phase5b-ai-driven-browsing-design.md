# Phase 5b: AI-Driven Browsing — Design

**Date:** 2026-08-23
**Depends on:** Phase 5 (embedded browser, shipped)
**Status:** approved, not yet planned

## Goal

Let the AI click, type into, and select from elements on a page the user is looking at, with the user's explicit approval before every single action. The concrete case: a Canvas `external_tool` assignment (Connect, MyLab, Cengage) whose UI `HandoffPanel` today can only open for a human to finish by hand. This phase lets the AI operate that UI directly, one confirmed step at a time, while the user stays present and can decline any step.

## Why this stayed out of Phase 5

Phase 5 shipped a deliberately read-only browser. Its own reasoning: "once the AI can both read pages and act on them, every page becomes a potential instruction source, and there is no reliable way to separate content the user asked about from text telling the model what to do." Phase 5's structural defense against that was simple — it shipped no tool that could act on a page at all, so the worst a hostile page could do was talk the model into misusing a tool it already held, all of which were `READ`-tier.

Phase 5b removes that structural defense on purpose, so it has to replace it with a real one: **every action requires the user to see a plain description of exactly what is about to happen and explicitly approve it, before it happens.** That is the actual backstop this whole phase rests on — not a filter, not a detector, a human in the loop on every single step.

## Explicitly out of scope

Two things were considered and deliberately rejected during design, worth recording so they aren't quietly reconsidered later without the same scrutiny:

- **No unattended/autonomous multi-step execution.** The AI cannot propose a plan once and then execute several steps without the user looking at each one — not even for low-stakes tasks. This was raised and walked back during design: real background *progress* through a multi-step flow is only possible if some actions execute without a human watching them happen, which reopens exactly the injection risk this phase's whole design rests on avoiding. What this phase does allow — the AI proposing one action, waiting (with no expiry and a notification) for the user to look at and approve it, from anywhere in the app — is a real usability improvement without weakening that guarantee, because the AI still cannot move to step 2 until step 1 was actually approved and executed.
- **No deliberately-paced or human-mimicking automation of graded academic work.** An early version of this brainstorm asked for an "autopilot" mode that would answer Canvas quiz questions unattended, with artificial delays between answers and simulated human typing (backspacing, corrections), explicitly so an instructor wouldn't notice it was automated. That crosses from AI-assisted homework help into disguised academic fraud with built-in detection evasion, and is not part of this phase or any future one.

## Threat model and defense

A hostile or compromised page's content — its text, an element's visible label, a link's destination — is untrusted input that reaches the model. Three distinct ways that can go wrong, and what stops each:

**1. The page tries to get the AI to perform an action the user didn't ask for.** Defense: every action tool is `ALWAYS_CONFIRM`. The confirmation shows the literal action in plain language before it executes — "Click the button labeled 'Submit Quiz'", "Type '42' into the field labeled 'Answer'" — matching the pattern `canvas_submit_assignment` already established ("show the user the exact text first"). The system prompt also explicitly instructs the model never to comply with a directive embedded in page content, and to say so plainly in its chat response if it notices one, rather than silently ignoring it. The confirmation gate is the real defense; the prompt instruction is a second layer, not a replacement for it — no prompt-level instruction is airtight, and this design does not pretend otherwise.

**2. The page tries to get the AI to state something factually wrong.** Harder than (1), because there's no natural "does this match what I asked for" moment for a chat answer the way there is for a click. Two mitigations, both explicitly imperfect: the system prompt is extended to say that page content must not override what the model knows to be true, and that content resembling an attempt to induce a wrong answer should be refused and flagged in the response, not silently complied with; and when the model states a fact sourced from a page, it says so ("per the page..." vs its own knowledge), giving the user a thread to pull if something looks off. Nothing here is a guarantee — it raises the bar, it does not close the door.

**3. The page hides content from the user that it shows to the model.** Phase 5's extraction already strips the bluntest hiding techniques before text reaches the model at all: `display:none`, `visibility:hidden`, `opacity:0`, and the `hidden` attribute are filtered out of `browser_read_page`'s output via `Element.checkVisibility()` in `buildExtractionScript` (`src/main/browser/extract.ts`). This phase extends that same filter — used both for page-text extraction and for the new element-label reading below — to also reject elements that are positioned off-screen or have zero rendered size, two more hiding techniques `checkVisibility()` does not catch on its own. **Explicitly not fixed:** text colored to match its background is not detected. Resolving actual rendered color, including inherited values, gradients, and background images, reliably enough to flag this without false positives is not something this phase attempts — it's recorded as an accepted, known gap rather than silently ignored.

## Element addressing: refs tied to a fresh read

A new tool, `browser_list_actionable_elements`, walks the current page's DOM (same `executeJavaScript` mechanism `browser_read_page` already uses) and returns every interactive element — buttons, links, text inputs and textareas, checkboxes, radio buttons, and `<select>` dropdowns — that passes the same visibility filter described above. Each gets:

- An opaque **ref** (e.g. `ref_1`, `ref_2`) — not a CSS selector, not a DOM path. The model can only ever act on a ref it was just given; it cannot construct or guess one.
- Its **role** (button, link, checkbox, text input, select, ...).
- Its **visible label**, run through the same `neutralizeMarkerText` treatment `browser_read_page` already applies to page text and tab titles — an element's label is exactly as untrusted as the rest of the page's content.
- Its **current state** where relevant — a checkbox's checked state, a select's currently chosen option, a text field's current value.

Refs are scoped to `(tabId, generation)`. A per-tab generation counter, held main-side, increments whenever: a new `browser_list_actionable_elements` call is made for that tab, an action tool successfully executes against that tab, or the tab navigates or reloads for any reason — AI-initiated or not. Any ref from an older generation is stale and any action tool attempting to use one is refused with a message telling the model to read the page again. This makes the "the AI must re-read before every single action" rule an enforced invariant, not a convention the model is trusted to follow.

## The three action tools

`browser_click`, `browser_type`, `browser_select` — all `ALWAYS_CONFIRM`, matching `canvas_submit_assignment`'s tier (the one tier `auto` mode does not skip). Each takes a ref (and, for type/select, the text or chosen value) and nothing else — no selector, no coordinates, no arbitrary JavaScript.

The confirmation description shown to the user names the element's role and label plainly, and for `browser_type`, the exact literal text that will be typed — never summarized or truncated, same as `canvas_submit_assignment`'s existing rule for submission text.

**Re-verification at approval time, not just proposal time.** Because a confirmation for these tools does not expire (see below), meaningful time can pass between a step being proposed and being approved. Immediately before executing, the tool re-resolves the ref against the live page and checks its role and label still match what was shown in the confirmation. If the page changed in the meantime — reloaded, the element moved, its label changed — the action is refused with a clear message rather than executed against a page state the user never actually saw and approved.

## Confirmations that wait for you, not a 2-minute clock

Today every confirmation in the app — Settings changes, calendar writes, Canvas submissions, and now these — shares one `CONFIRMATION_TIMEOUT_MS = 120_000` constant in `src/main/ai/confirmations.ts`, after which an unanswered confirmation is treated as declined. That timeout stays exactly as-is for every existing tool. It does not fit this phase's action tools: the whole point is that you can step away and come back.

`requestConfirmation` and the `gate()` helper both gain an optional timeout override; `browser_click`/`browser_type`/`browser_select`/`browser_open_tab` pass a 24-hour value instead of the default two minutes. Not literally infinite — a genuinely abandoned confirmation (the user closes the tab it referred to and never comes back) should eventually stop holding a promise open in memory — but long enough that "I'll get to it after this test" is never actually a race against a clock.

**Notification.** A small badge appears on the sidebar's "Ask AI" toggle (`src/renderer/src/nav/Sidebar.tsx`) whenever a pending confirmation exists and the AI dock is not open, plus a native OS notification (Electron's `Notification` API) fires the moment a new confirmation arrives while the app window isn't focused. Neither of these is new risk surface — the AI dock is already mounted at the app-shell level (`src/renderer/src/App.tsx`), independent of route, so a pending confirmation card is already visible from Calendar, Home, wherever, once the dock is open; the badge and notification exist purely so the user knows to open it.

**Why "the AI works while you're on another tab" needs no new plumbing.** A `WebContentsView` that stops being the visually active route does not stop running — `setRouteActive(false)` only calls `view.setVisible(false)` in `src/main/browser/view.ts`; the underlying `webContents` stays alive and fully controllable via IPC regardless of which route is on screen. Leaving `/browser` for `/calendar` while an action is proposed does not suspend anything.

## Opening a new tab to gather information

`browser_read_page` already accepts an optional `tabIndex` and can read any tab the user has open, not only the active one — summarizing an already-open second tab into the one you're working on required no change.

What was missing: a way for the AI to open a tab itself, rather than only reading ones the user already opened. `browser_open_tab` fills that gap. It takes a URL the model chooses. Tier: `SAFE_WRITE`, matching `canvas_open_assignment`'s existing tier for the same shape of risk (opens a tab, visibly changes what's on screen, but nothing is submitted and nothing acts on a third-party site) — confirmed in `ask`/`assist`, auto-run in `auto` mode. Unlike `canvas_open_assignment`, which switches the user's active view to `/browser` because the user explicitly asked to see that assignment, `browser_open_tab` opens **in the background** — it does not activate the new tab or change what the user is currently looking at, since the point is gathering information to help with the page already in front of them, not interrupting them with a tab they didn't ask to see.

## Testing

- `browser_list_actionable_elements`: element discovery across each role, ref opacity (an AI-supplied ref that was never issued is rejected), label neutralization, the extended visibility filter (off-screen and zero-size exclusion, alongside the existing display/opacity/hidden cases).
- Ref staleness: a ref used after a new read of the same tab is rejected; a ref used after any navigation (AI- or user-initiated) is rejected; a ref used after a prior action executed against the same tab is rejected.
- `browser_click` / `browser_type` / `browser_select`: confirmation description content matches the actual action; re-verification at approval time catches a page that changed between proposal and approval; each tier-gates correctly across `ask`/`assist`/`auto`.
- `browser_open_tab`: opens without activating the new tab; tier behavior matches `canvas_open_assignment`'s existing test pattern.
- Confirmation timeout override: the four new tools get the long timeout; every existing tool's confirmation still expires at the current 120 seconds, unchanged.
- Notification: badge state reflects pending-confirmation-exists AND dock-closed; clears once the dock opens or the confirmation resolves.
- Prompt instructions: a hostile page's embedded directive does not appear as an executed action without a matching real user request in the conversation; a page's attempt to influence a factual answer is refused in the model's response (behavioral, not a hard technical test — same caveat as the rest of Phase 5's prompt-level tests).

## Manual smoke checklist

Deferred to the packaged app, same as every prior phase:

- A real `external_tool` assignment (Connect/MyLab) walked through end-to-end with the AI proposing and the user approving each click/type/select.
- Stepping away from the AI dock and app window mid-flow, confirming the badge/notification appears, and that approving a step from a fresh notification still works correctly against the live page.
- A confirmation left pending for longer than the old 2-minute window, to confirm it is still there and still executes correctly against the current page state (or is correctly refused if the page changed).
- `browser_open_tab` opening a background tab while the user continues working in the foreground tab, and the AI then reading that background tab's content.
