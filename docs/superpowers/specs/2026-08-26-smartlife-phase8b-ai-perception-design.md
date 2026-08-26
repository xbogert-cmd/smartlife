# Phase 8b: AI Perception & Attachments — Design

**Status:** Approved, ready for planning.

## Motivation

Two real gaps surfaced after Phase 8 shipped:

1. The AI can only answer questions from what its tools can already read (Canvas DB, calendar DB, the active browser tab's DOM). It can't look anything up that isn't already on screen or in the local DB — e.g. "what's the going rate for X" has no path to an answer.
2. `browser_read_page` reads DOM text. A SharePoint-embedded Word doc renders inside a cross-origin iframe whose content the DOM extractor can't reach — the AI reported it couldn't see the document even though it was visibly open in the browser tab.

The user also wants to hand the AI a file directly (a PDF syllabus, a screenshot, a photo of handwritten notes) instead of routing everything through the browser.

This phase adds three capabilities: **web search**, **screenshot vision** (fixes the SharePoint case — pixel capture bypasses the cross-origin DOM wall entirely), and **file upload**.

## Global Constraints

- Tests run via `npm test` (sets `ELECTRON_RUN_AS_NODE=1`) — never `npx vitest run`.
- `providers/catalog.ts`'s existing pattern (static, hand-verified entries, re-checked against current docs) extends to two new per-entry flags: `supportsWebSearch: boolean`, `supportsVision: boolean`. Exact values must be verified against current Anthropic/Gemini docs at implementation time, not guessed.
- Any new provider-side wire format (Anthropic image blocks, Gemini `inlineData` parts, hosted web-search tool type strings) must be verified against real, current SDK docs/types before writing code — same rule Phase 8 already applied when it caught a hallucinated `@google/genai` shape by reading the installed package's real `.d.ts` files instead of trusting a doc fetch. Use the `claude-api` skill for Anthropic specifics.
- Conversation history remains placeholder-only for attachments: full extracted text / image bytes are used for the turn that included them and never persisted. This matches the existing pattern where history already stores only a turn's final text, never intermediate tool exchanges. (Full-content retention across turns is explicitly deferred — see Deferred below.)
- New dependencies for local document parsing (PDF, .docx) should be small, well-established, pure-JS/Node libraries with no native-module ABI surface — the project already had one Electron/better-sqlite3 native-ABI class of pain (`ELECTRON_RUN_AS_NODE=1`) and a second one isn't worth the risk. Verify current package names/versions at implementation time.
- All three new capabilities are gated by what the *active turn's* provider/model can actually do — never offered where they'd fail. Ollama's capability flags come from live detection (`supportsVision` inferred the same way `isKnownGoodForTools` already is: a known-model-family check against whatever `/api/tags` reports), since Ollama has no static catalog.

## Architecture

### 1. `CanonicalContentBlock`: images join the canonical shape

`providers/types.ts` currently defines `CanonicalTextBlock` as the *only* content shape any provider may read from or write to. This phase adds a sibling:

```
export interface CanonicalImageBlock {
  type: 'image';
  mimeType: string; // e.g. 'image/png'
  data: string;      // base64
}
export type CanonicalContentBlock = CanonicalTextBlock | CanonicalImageBlock;
```

`CanonicalTextBlock` keeps its existing role unchanged: it's still the *only* shape that ever reaches conversation history or an assistant's final reply. `CanonicalImageBlock` only ever appears as **input** for a single turn (an uploaded image, or a screenshot injected mid-turn) — never persisted, never returned by a provider as output.

`AIProvider.streamTurn` gains one new, optional input field:

```
streamTurn(params: {
  system: string;
  history: TurnMessage[];
  userText: string;
  attachments?: CanonicalContentBlock[]; // this turn only; never persisted
  tools: ToolDefinition[];
  ctx: ToolContext;
  onEvent: (event: StreamEvent) => void;
}): Promise<CanonicalTextBlock[]>  // return type unchanged -- assistant output is always text
```

Each provider adapter (`claude.ts`, `gemini.ts`, `ollama.ts`) is responsible for folding `attachments` into its own first-request wire format (Anthropic content blocks, Gemini `parts`, Ollama's `images` field) — this is the standard, well-documented "multimodal user message" shape for all three, not a novel mechanism.

### 2. Screenshot tool result → next-round image, not a tool-result image

Feeding an image back as a *tool result* is a murky, inconsistently-documented shape across providers (Gemini in particular doesn't have a clean standard for images inside a function response). Instead: `ToolContext` gains one new method:

```
attachImage(block: CanonicalImageBlock): void
```

`browser_screenshot`'s `run()` captures the tab, calls `ctx.attachImage(...)`, and returns a plain string tool result ("Screenshot captured.") — `ToolDefinition.run`'s existing `Promise<string>` signature is untouched, so no other tool's code changes. Each provider's own agentic tool-loop (already present in `gemini.ts` and `ollama.ts`; a comparable loop exists in `claude.ts`'s SDK-driven flow) checks after each round whether any images were attached during that round and, if so, includes them as extra image parts in the *next* request it sends back to the model — using the same standard multimodal-user-input mechanism as file uploads, not a tool-result image. This keeps the "how do I get an image in front of the model" logic in exactly one place per provider instead of two.

### 3. `BrowserHost` gains screenshot capture

`src/main/browser/view.ts`'s `BrowserHost` interface adds:

```
captureScreenshot(id?: string): Promise<{ mimeType: string; data: string }>
```

Implemented via each tab's `WebContentsView`'s `webContents.capturePage()` → `NativeImage.toPNG()` → base64. This is a **pixel capture of the rendered tab**, which is exactly why it solves the SharePoint case: `capturePage()` doesn't care that the Word-doc viewer is a cross-origin iframe the DOM extractor can't reach — it captures what's actually drawn on screen.

## Feature 1: Web search

New tool `web_search`, registered in `tools/registry.ts` like every other tool, but only included in the `tools` array handed to a turn when the active catalog entry's `supportsWebSearch` is true. Anthropic and Gemini both run it as a **hosted, server-side tool** — declare it in the request and the provider does the actual searching; SmartLife never touches a search API or result set directly. Ollama has no hosted equivalent, so the tool is simply absent from that turn — no error, no degraded fallback string, the AI just doesn't have it (same pattern as tool-tier gating already used elsewhere).

## Feature 2: Screenshot vision

New tool `browser_screenshot`, offered only when the active entry's `supportsVision` is true. Takes an optional `tabIndex` (same convention as `browser_read_page`), defaults to the active tab. Captures via `BrowserHost.captureScreenshot`, calls `ctx.attachImage(...)`, returns a short confirmation string. The AI decides when to reach for it — typically after `browser_read_page` comes back empty or clearly insufficient (an iframe, a canvas-rendered viewer, a scanned document).

Gated identically for Ollama: only offered when the active local model is flagged vision-capable.

## Feature 3: File upload

An attach control in the chat composer (`ChatPanel.tsx`). Flow:

1. User clicks attach → native file picker (`dialog.showOpenDialog`, run in main via IPC, matching the existing pattern for other file-touching flows like downloads).
2. Main process reads the file and classifies by extension:
   - **PDF / .docx / .txt** → extract to plain text locally (small pure-JS libraries — exact package TBD at implementation time, e.g. a PDF text-layer extractor and a `.docx`-to-text converter). This is uniform across all three providers, since it produces a plain `CanonicalTextBlock` — no provider-specific document API involved, and it works on Ollama too (unlike hosted document APIs, which only Anthropic/Gemini have).
   - **Images** (png/jpg/etc.) → read as bytes, base64-encode, becomes a `CanonicalImageBlock` — gated by the same `supportsVision` flag as screenshots. If the active provider/model can't see images, the attach control disables image files (or shows why) rather than silently failing after upload.
3. Extracted content becomes that turn's `attachments`, passed to `streamTurn`.
4. Conversation history stores a placeholder text entry — e.g. `[attached: syllabus.pdf — 2,340 chars extracted]` for documents, `[attached: photo.png — image]` for images — never the full text or image bytes.

PDF text extraction only reads a real text layer; a scanned/image-only PDF yields little or nothing (no OCR in this phase — see Deferred).

## Testing

- Catalog flag correctness: unit tests asserting which entries carry `supportsWebSearch`/`supportsVision`.
- `attachImage`/next-round-injection: the riskiest new logic (per Phase 8's own recurring lesson that agentic-loop behavior needs direct tests, not just pure-helper tests) — needs a real test exercising a tool call that attaches an image and confirming the *next* round's outgoing request actually carries it, for each provider's loop.
- `captureScreenshot`: covered at the `BrowserHost` level with a fake `WebContentsView`/`webContents`, consistent with how `view.test.ts` already fakes Electron primitives.
- File extraction: unit tests per file type (a small fixture PDF, a small fixture .docx) asserting extracted text.
- Placeholder persistence: an integration test confirming `ai_messages` never contains raw image base64 or full document text after a turn with attachments.

## Deferred (explicitly out of scope for this phase)

- **Multi-conversation system** (switchable conversations, labels, new-on-launch, compression) — its own future phase. Full-content history retention for attachments depends on this landing first; see the Global Constraints note above.
- Provider-native hosted document APIs (Anthropic/Gemini document understanding) — local text extraction was chosen instead for uniform cross-provider behavior.
- OCR for scanned/image-only PDFs.
- Full-screen (OS-level) screenshots — only the active browser tab is captured.
