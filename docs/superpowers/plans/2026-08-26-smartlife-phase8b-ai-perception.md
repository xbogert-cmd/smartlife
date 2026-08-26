# Phase 8b: AI Perception & Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give SmartLife's AI three new senses: hosted web search, screenshot vision (fixes the SharePoint cross-origin-iframe case), and file/image upload — each gated per-model by capability flags so no provider is ever offered something it can't do.

**Architecture:** Extend the canonical content-block shape with images (turn-scoped, never persisted). Screenshots feed the model via a `ctx.attachImage` side-channel that each provider adapter drains into whatever mechanism it natively supports (Anthropic: multi-block tool result; Gemini/Ollama: an extra multimodal part in the next round). Uploaded documents are parsed to plain text locally (no provider-specific document API), uploaded images and screenshots both become `CanonicalImageBlock`s. Conversation history keeps storing text-only placeholders.

**Tech Stack:** `@anthropic-ai/sdk` (already installed, `web_search_20260209` hosted tool, multi-block tool results), `@google/genai` (already installed, `googleSearch` grounding tool, `inlineData` parts), Electron `webContents.capturePage()`, `pdfjs-dist` (legacy Node build, no native deps) for PDF text, `mammoth` for `.docx` text.

## Global Constraints

- Tests run via `npm test` (sets `ELECTRON_RUN_AS_NODE=1`) — never `npx vitest run`.
- Every SDK shape below was verified against the actually-installed package in `node_modules` (not recalled from training or fetched docs) — re-verify against `node_modules/@anthropic-ai/sdk` / `node_modules/@google/genai` if a task's code stops matching what's installed.
- `ToolContext.pendingImages` and `ToolContext.attachImage` are **optional** fields, specifically so the ~11 existing test files that construct a raw `ToolContext` object literal (`fallback.test.ts`, `gemini.test.ts`, `ollama.test.ts`, `router.test.ts`, and 7 files under `tools/*.test.ts`) do not need touching. Provider adapters and tools must always access them defensively (`ctx.pendingImages ?? []`, `ctx.attachImage?.(...)`).
- Image mime types are restricted to the four Anthropic's `BetaBase64ImageSource.media_type` accepts: `image/png`, `image/jpeg`, `image/gif`, `image/webp`. Screenshots are always `image/png`. Uploaded images are restricted to `.png/.jpg/.jpeg/.gif/.webp` at the file picker.
- A `CanonicalImageBlock` only ever exists for the duration of one turn (an uploaded image or a screenshot). It is never written to `ai_messages`; conversation history stores a text placeholder instead (`[attached: name.pdf — 2,340 chars extracted]` / `[attached: name.png — image]`), appended into the persisted user text.
- Each provider adapter resets `ctx.pendingImages` to empty at the very start of its own `streamTurn` — `FallbackProvider` reuses the same `ctx` object across retries, so a stale image from a failed attempt must never leak into the next provider's turn.
- New dependencies: `pdfjs-dist` (already a transitive concept verified at `node_modules/pdfjs-dist` version `5.4.296` during planning; pin the exact current version at implementation time via `npm view pdfjs-dist version`) and `mammoth` (verified `1.12.1` during planning, same re-check rule). Do **not** add `pdf-parse` — its current major version pulls in `@napi-rs/canvas`, a native dependency this project has no reason to take on when only text extraction (`pdfjs-dist`'s `getTextContent()`, no canvas involved) is needed.
- `catalog.ts`'s existing pattern (static, hand-verified entries, re-checked against current docs before adjusting) extends with two new fields per entry, `supportsWebSearch` and `supportsVision` — see Task 1 for the verified starting values and their source.

---

### Task 1: Canonical image blocks, capability flags, active-capability lookup

**Files:**
- Modify: `src/main/ai/tools/types.ts`
- Modify: `src/main/ai/providers/types.ts`
- Modify: `src/main/ai/providers/catalog.ts`
- Modify: `src/main/ai/router.ts`
- Test: `src/main/ai/providers/catalog.test.ts`
- Test: `src/main/ai/router.test.ts`

**Interfaces:**
- Produces: `CanonicalImageBlock { type: 'image'; mimeType: string; data: string }` (base64), defined in `tools/types.ts`.
- Produces: `CanonicalContentBlock = CanonicalTextBlock | CanonicalImageBlock`, defined in `providers/types.ts`, re-exporting `CanonicalImageBlock`.
- Produces: `ToolContext.pendingImages?: CanonicalImageBlock[]` and `ToolContext.attachImage?: (block: CanonicalImageBlock) => void`.
- Produces: `CatalogEntry.supportsWebSearch: boolean`, `CatalogEntry.supportsVision: boolean`.
- Produces: `isKnownGoodForVision(ollamaModelName: string): boolean` in `catalog.ts`.
- Produces: `getActiveCapabilities(db): { supportsVision: boolean; supportsWebSearch: boolean }` in `router.ts`.
- Consumes: nothing new from earlier tasks (this is the foundation task).

- [ ] **Step 1: Write failing tests for the catalog's new flags**

Append to `src/main/ai/providers/catalog.test.ts`:

```ts
describe('capability flags', () => {
  it('every entry declares both capability flags as booleans', () => {
    for (const entry of CATALOG) {
      expect(typeof entry.supportsWebSearch).toBe('boolean');
      expect(typeof entry.supportsVision).toBe('boolean');
    }
  });

  it('Claude Haiku 4.5 does not support the hosted web-search tool (not in Anthropic’s current model list for it)', () => {
    expect(findCatalogEntry('anthropic', 'claude-haiku-4-5-20251001')?.supportsWebSearch).toBe(false);
  });

  it('Claude Sonnet 5 and Opus 5 support the hosted web-search tool', () => {
    expect(findCatalogEntry('anthropic', 'claude-sonnet-5')?.supportsWebSearch).toBe(true);
    expect(findCatalogEntry('anthropic', 'claude-opus-5')?.supportsWebSearch).toBe(true);
  });

  it('both Gemini entries support search grounding and vision', () => {
    expect(findCatalogEntry('gemini', 'gemini-2.5-flash')?.supportsWebSearch).toBe(true);
    expect(findCatalogEntry('gemini', 'gemini-2.5-pro')?.supportsWebSearch).toBe(true);
    expect(findCatalogEntry('gemini', 'gemini-2.5-flash')?.supportsVision).toBe(true);
    expect(findCatalogEntry('gemini', 'gemini-2.5-pro')?.supportsVision).toBe(true);
  });

  it('every Anthropic entry supports vision (the whole Claude 3+ lineup is multimodal)', () => {
    for (const entry of CATALOG.filter((e) => e.providerId === 'anthropic')) {
      expect(entry.supportsVision).toBe(true);
    }
  });
});

describe('isKnownGoodForVision', () => {
  it('matches known vision-capable local model prefixes case-insensitively', () => {
    expect(isKnownGoodForVision('llava:13b')).toBe(true);
    expect(isKnownGoodForVision('Qwen2.5vl')).toBe(true);
    expect(isKnownGoodForVision('llama3.2-vision')).toBe(true);
  });

  it('does not match a text-only model', () => {
    expect(isKnownGoodForVision('llama3.1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- catalog.test.ts`
Expected: FAIL — `supportsWebSearch`/`supportsVision`/`isKnownGoodForVision` do not exist yet.

- [ ] **Step 3: Extend the catalog**

Replace the top of `src/main/ai/providers/catalog.ts` (keep `import type { ProviderId } from './types';` as-is) with:

```ts
export interface CatalogEntry {
  providerId: 'anthropic' | 'gemini';
  model: string;
  displayName: string;
  costRank: number;
  /** Whether this entry's hosted web-search tool may be offered on a turn.
   *  Verified against docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool
   *  and ai.google.dev/gemini-api/docs/grounding at plan time (2026-08-26) --
   *  re-verify before adjusting, same rule as costRank below. */
  supportsWebSearch: boolean;
  /** Whether this entry accepts image input (uploaded images, screenshots). */
  supportsVision: boolean;
}

export const CATALOG: CatalogEntry[] = [
  {
    providerId: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5',
    costRank: 1,
    supportsWebSearch: false,
    supportsVision: true,
  },
  {
    providerId: 'gemini',
    model: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    costRank: 1,
    supportsWebSearch: true,
    supportsVision: true,
  },
  {
    providerId: 'anthropic',
    model: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    costRank: 3,
    supportsWebSearch: true,
    supportsVision: true,
  },
  {
    providerId: 'gemini',
    model: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    costRank: 3,
    supportsWebSearch: true,
    supportsVision: true,
  },
  {
    providerId: 'anthropic',
    model: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    costRank: 5,
    supportsWebSearch: true,
    supportsVision: true,
  },
];
```

Then add, right after `isKnownGoodForTools` and before `findCatalogEntry`:

```ts
/** Model-name prefixes known to handle image input well. Same advisory-only
 *  status as KNOWN_GOOD_FOR_TOOLS_PREFIXES -- browser_screenshot and image
 *  attachments are simply not offered to an Ollama model that doesn't match,
 *  never a hard block on selecting the model itself. */
const KNOWN_VISION_PREFIXES = ['llava', 'qwen2.5vl', 'qwen2-vl', 'llama3.2-vision', 'bakllava', 'moondream', 'minicpm-v'];

export function isKnownGoodForVision(ollamaModelName: string): boolean {
  const lower = ollamaModelName.toLowerCase();
  return KNOWN_VISION_PREFIXES.some((prefix) => lower.startsWith(prefix));
}
```

- [ ] **Step 4: Run the catalog tests again to verify they pass**

Run: `npm test -- catalog.test.ts`
Expected: PASS

- [ ] **Step 5: Write a failing test for the ToolContext extension compiling**

`ToolContext` is a pure type — there is no runtime test for adding an optional field. Skip straight to Step 6; type-correctness is verified by `npm run typecheck` (or `npx tsc --noEmit` if no such script exists — check `package.json` scripts first) in Step 8.

- [ ] **Step 6: Add `CanonicalImageBlock` and extend `ToolContext`**

In `src/main/ai/tools/types.ts`, add after the `ToolSchema` interface and before `ToolDefinition`:

```ts
/** A single image, always turn-scoped -- see providers/types.ts's
 *  CanonicalContentBlock and this phase's plan for why images never cross
 *  the persisted-history boundary the way CanonicalTextBlock does. */
export interface CanonicalImageBlock {
  type: 'image';
  mimeType: string;
  data: string; // base64
}
```

Then extend `ToolContext`:

```ts
export interface ToolContext {
  db: Database.Database;
  conversationId: string;
  mode: AiMode;
  requestConfirmation: (toolName: string, description: string, timeoutMs?: number) => Promise<boolean>;
  /** Tools that need to hand the model an image mid-turn (browser_screenshot)
   *  push it here instead of returning it directly -- ToolDefinition.run stays
   *  string-only so no other tool's signature changes. Each provider adapter
   *  drains pendingImages after running a tool/round and feeds the image back
   *  to the model using whatever mechanism that provider natively supports.
   *  Both fields are optional so the many existing test files that construct
   *  a bare ToolContext literal don't need updating -- real usage (chatController.ts)
   *  always provides both. */
  attachImage?: (block: CanonicalImageBlock) => void;
  pendingImages?: CanonicalImageBlock[];
}
```

- [ ] **Step 7: Extend `AIProvider.streamTurn` with `attachments`**

In `src/main/ai/providers/types.ts`, change the import line to:

```ts
import type { CanonicalImageBlock, ToolContext, ToolDefinition } from '../tools/types';
```

Add, right after the `CanonicalTextBlock` interface:

```ts
export type { CanonicalImageBlock };

/** Turn-scoped input content -- CanonicalTextBlock plus images. Only ever
 *  used for `attachments` below (uploaded files, screenshots); never what a
 *  provider returns, and never what crosses the history boundary. */
export type CanonicalContentBlock = CanonicalTextBlock | CanonicalImageBlock;
```

Then extend `AIProvider`:

```ts
export interface AIProvider {
  streamTurn(params: {
    system: string;
    history: TurnMessage[];
    userText: string;
    /** This turn's uploaded files/images, if any -- never persisted, see
     *  CanonicalContentBlock's doc comment. */
    attachments?: CanonicalContentBlock[];
    tools: ToolDefinition[];
    ctx: ToolContext;
    onEvent: (event: StreamEvent) => void;
  }): Promise<CanonicalTextBlock[]>;
}
```

- [ ] **Step 8: Typecheck**

Run: `cat package.json | grep -A1 '"typecheck"'` to find the exact script name (SmartLife's `package.json` may name it `typecheck` or `typecheck:node` — use whichever exists), then run it.
Expected: no new type errors. `fallback.test.ts`, `gemini.test.ts`, `ollama.test.ts`, `router.test.ts`, and the 7 `tools/*.test.ts` files that build a raw `ToolContext` literal all still compile unchanged, because both new fields are optional.

- [ ] **Step 9: Write failing tests for `getActiveCapabilities`**

Append to `src/main/ai/router.test.ts` (reuses this file's existing `makeDb()`/mocks — no changes needed to the top of the file):

```ts
describe('getActiveCapabilities', () => {
  it('reflects the starting (first-ranked) entry’s catalog flags', async () => {
    const { getActiveCapabilities } = await import('./router');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    setRanking(db, [{ providerId: 'anthropic', model: 'claude-haiku-4-5-20251001' }]);
    expect(getActiveCapabilities(db)).toEqual({ supportsVision: true, supportsWebSearch: false });
  });

  it('prefers the pinned entry over ranking[0] when a pin is set', async () => {
    const { getActiveCapabilities } = await import('./router');
    const { setPinnedEntry } = await import('./providerConfig');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    setRanking(db, [
      { providerId: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      { providerId: 'anthropic', model: 'claude-sonnet-5' },
    ]);
    setPinnedEntry(db, { providerId: 'anthropic', model: 'claude-sonnet-5' });
    expect(getActiveCapabilities(db).supportsWebSearch).toBe(true);
  });

  it('detects Ollama vision support by model-name prefix, and never offers web search', async () => {
    const { getActiveCapabilities } = await import('./router');
    const db = makeDb();
    setOllamaEndpoint(db, 'http://localhost:11434');
    setRanking(db, [{ providerId: 'ollama', model: 'llava:13b' }]);
    expect(getActiveCapabilities(db)).toEqual({ supportsVision: true, supportsWebSearch: false });
  });

  it('returns both false when nothing is ranked', async () => {
    const { getActiveCapabilities } = await import('./router');
    const db = makeDb();
    expect(getActiveCapabilities(db)).toEqual({ supportsVision: false, supportsWebSearch: false });
  });
});
```

- [ ] **Step 10: Run to verify failure**

Run: `npm test -- router.test.ts`
Expected: FAIL — `getActiveCapabilities` does not exist.

- [ ] **Step 11: Implement `getActiveCapabilities`**

In `src/main/ai/router.ts`, add to the import from `./providers/catalog`:

```ts
import { OLLAMA_COST_RANK, findCatalogEntry, isKnownGoodForVision } from './providers/catalog';
```

Then add, after `hasUsableProvider` and before `retryProviderEntry`:

```ts
/** What the turn that would start right now could actually do -- used to
 *  gate the file-attachment picker (disable/explain image files when the
 *  active entry can't see) before a turn even begins. Looks at the same
 *  "starting entry" a real FallbackProvider would use (pinned, else
 *  ranking[0]) without needing credentials to be valid -- this is a UI
 *  hint, not a security gate; the real gate is each provider adapter's own
 *  capability check when it actually builds the request. */
export function getActiveCapabilities(db: Database.Database): { supportsVision: boolean; supportsWebSearch: boolean } {
  const ranking = getRanking(db);
  const pinned = getPinnedEntry(db);
  const starting =
    (pinned && ranking.find((e) => e.providerId === pinned.providerId && e.model === pinned.model)) ?? ranking[0];
  if (!starting) return { supportsVision: false, supportsWebSearch: false };
  if (starting.providerId === 'ollama') {
    return { supportsVision: isKnownGoodForVision(starting.model), supportsWebSearch: false };
  }
  const entry = findCatalogEntry(starting.providerId, starting.model);
  return { supportsVision: entry?.supportsVision ?? false, supportsWebSearch: entry?.supportsWebSearch ?? false };
}
```

- [ ] **Step 12: Run to verify pass**

Run: `npm test -- router.test.ts`
Expected: PASS

- [ ] **Step 13: Full test run and commit**

Run: `npm test`
Expected: all tests pass (no regressions in unrelated files).

```bash
git add src/main/ai/tools/types.ts src/main/ai/providers/types.ts src/main/ai/providers/catalog.ts src/main/ai/providers/catalog.test.ts src/main/ai/router.ts src/main/ai/router.test.ts
git commit -m "Add canonical image blocks, capability flags, and getActiveCapabilities"
```

---

### Task 2: Screenshot capture (`BrowserHost`) and the `browser_screenshot` tool

**Files:**
- Modify: `src/main/browser/view.ts`
- Create: `src/main/ai/tools/browserScreenshot.ts`
- Modify: `src/main/ai/tools/registry.ts`
- Test: `src/main/browser/view.test.ts`
- Test: `src/main/ai/tools/browserScreenshot.test.ts` (new)

**Interfaces:**
- Consumes: `CanonicalImageBlock`, `ToolContext.attachImage` from Task 1.
- Produces: `BrowserHost.captureScreenshot(id?: string): Promise<{ mimeType: string; data: string } | null>`.
- Produces: `browserScreenshotTool: ToolDefinition` (name `browser_screenshot`), added to `TOOLS`.

- [ ] **Step 1: Write a failing test for `captureScreenshot` on the fake WebContents**

In `src/main/browser/view.test.ts`, add `capturePage` to `FakeWebContents` (find the class near the top of the file and add this method alongside the others, e.g. right after `executeJavaScript`):

```ts
  capturePage(): Promise<{ toPNG: () => Buffer }> {
    if (this.captureError) return Promise.reject(this.captureError);
    return Promise.resolve({ toPNG: () => Buffer.from('fake-png-bytes') });
  }
```

And add the backing field near the other mutable fields at the top of the class:

```ts
  captureError: Error | null = null;
```

Then add a new describe block, right after the existing `describe('readPage', ...)` block:

```ts
describe('captureScreenshot', () => {
  it('returns base64 PNG data for the active tab', async () => {
    const { host } = makeHost();
    const result = await host.captureScreenshot();
    expect(result).toEqual({ mimeType: 'image/png', data: Buffer.from('fake-png-bytes').toString('base64') });
  });

  it('returns null for an unknown tab id', async () => {
    const { host } = makeHost();
    const result = await host.captureScreenshot('does-not-exist');
    expect(result).toBeNull();
  });

  it('returns null instead of throwing when capturePage rejects', async () => {
    const { host, added } = makeHost();
    added[0].webContents.captureError = new Error('capture failed');
    const result = await host.captureScreenshot();
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- view.test.ts`
Expected: FAIL — `captureScreenshot` does not exist on the host.

- [ ] **Step 3: Add `captureScreenshot` to `BrowserHost`**

In `src/main/browser/view.ts`, add to the `BrowserHost` interface, after `readPage`:

```ts
  captureScreenshot(id?: string): Promise<{ mimeType: string; data: string } | null>;
```

Then add to the returned object, right after the `readPage` method:

```ts
    async captureScreenshot(id) {
      const targetId = id ?? state.activeTabId;
      const contents = views.get(targetId)?.webContents;
      if (!contents) return null;
      try {
        const image = await contents.capturePage();
        return { mimeType: 'image/png', data: image.toPNG().toString('base64') };
      } catch (error) {
        logError('browser:captureScreenshot', error);
        return null;
      }
    },
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- view.test.ts`
Expected: PASS

- [ ] **Step 5: Write a failing test for the `browser_screenshot` tool**

Create `src/main/ai/tools/browserScreenshot.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { setActiveBrowserHost } from '../../browser/hostRegistry';
import type { CanonicalImageBlock } from './types';

function fakeCtx() {
  const pendingImages: CanonicalImageBlock[] = [];
  return {
    db: {} as never,
    conversationId: 'c1',
    mode: 'ask' as const,
    requestConfirmation: vi.fn(),
    pendingImages,
    attachImage: (block: CanonicalImageBlock) => pendingImages.push(block),
  };
}

describe('browserScreenshotTool', () => {
  it('captures the active tab and attaches it as an image via ctx.attachImage', async () => {
    const { browserScreenshotTool } = await import('./browserScreenshot');
    const ctx = fakeCtx();
    setActiveBrowserHost({
      getState: () => ({ tabs: [{ id: 'tab-1', url: 'https://example.com', title: '', canGoBack: false, canGoForward: false, loading: false, error: null }], activeTabId: 'tab-1' }),
      captureScreenshot: vi.fn().mockResolvedValue({ mimeType: 'image/png', data: 'ZmFrZQ==' }),
    } as never);

    const result = await browserScreenshotTool.run({}, ctx);

    expect(result).toBe('Screenshot captured.');
    expect(ctx.pendingImages).toEqual([{ type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' }]);
    setActiveBrowserHost(null);
  });

  it('reports when the browser is unavailable', async () => {
    const { browserScreenshotTool } = await import('./browserScreenshot');
    setActiveBrowserHost(null);
    const result = await browserScreenshotTool.run({}, fakeCtx());
    expect(result).toContain('not available');
  });

  it('reports an unknown tab index without capturing', async () => {
    const { browserScreenshotTool } = await import('./browserScreenshot');
    const capture = vi.fn();
    setActiveBrowserHost({
      getState: () => ({ tabs: [], activeTabId: 'tab-1' }),
      captureScreenshot: capture,
    } as never);
    const result = await browserScreenshotTool.run({ tabIndex: 5 }, fakeCtx());
    expect(result).toContain('No tab 5');
    expect(capture).not.toHaveBeenCalled();
    setActiveBrowserHost(null);
  });

  it('reports a failed capture without attaching anything', async () => {
    const { browserScreenshotTool } = await import('./browserScreenshot');
    const ctx = fakeCtx();
    setActiveBrowserHost({
      getState: () => ({ tabs: [{ id: 'tab-1', url: 'https://example.com', title: '', canGoBack: false, canGoForward: false, loading: false, error: null }], activeTabId: 'tab-1' }),
      captureScreenshot: vi.fn().mockResolvedValue(null),
    } as never);
    const result = await browserScreenshotTool.run({}, ctx);
    expect(result).toContain("Couldn't capture");
    expect(ctx.pendingImages).toHaveLength(0);
    setActiveBrowserHost(null);
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npm test -- browserScreenshot.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 7: Implement the tool**

Create `src/main/ai/tools/browserScreenshot.ts`:

```ts
import { getActiveBrowserHost } from '../../browser/hostRegistry';
import type { ToolDefinition } from './types';

export const browserScreenshotTool: ToolDefinition = {
  name: 'browser_screenshot',
  tier: 'READ',
  label: 'Take a screenshot of the page',
  schema: {
    name: 'browser_screenshot',
    description:
      "Capture what a tab in SmartLife's built-in browser actually looks like, as an image -- unlike browser_read_page, this sees content DOM text-extraction can't reach (cross-origin iframes, canvas-rendered viewers, scanned documents). Defaults to the active tab. Reach for this after browser_read_page comes back empty or clearly insufficient.",
    input_schema: {
      type: 'object',
      properties: {
        tabIndex: {
          type: 'number',
          description: 'Optional 1-based tab number from browser_list_tabs. Omit to capture the active tab.',
        },
      },
      required: [],
    },
  },
  async run(input, ctx) {
    const host = getActiveBrowserHost();
    if (host === null) return 'The built-in browser is not available right now.';

    const state = host.getState();
    let tabId: string | undefined;
    if (input.tabIndex !== undefined) {
      const index = Number(input.tabIndex);
      const tab = state.tabs[index - 1];
      if (!tab) return `No tab ${index} is open. Use browser_list_tabs to see what is available.`;
      tabId = tab.id;
    }

    const capture = await host.captureScreenshot(tabId);
    if (capture === null) return "Couldn't capture a screenshot of that tab.";

    ctx.attachImage?.({ type: 'image', mimeType: capture.mimeType, data: capture.data });
    return 'Screenshot captured.';
  },
};
```

- [ ] **Step 8: Run to verify pass**

Run: `npm test -- browserScreenshot.test.ts`
Expected: PASS

- [ ] **Step 9: Register the tool**

In `src/main/ai/tools/registry.ts`, add the import:

```ts
import { browserScreenshotTool } from './browserScreenshot';
```

Add `browserScreenshotTool` to the `TOOLS` array (after `browserOpenTabTool`, grouped with the other browser tools).

- [ ] **Step 10: Full test run and commit**

Run: `npm test`
Expected: all pass.

```bash
git add src/main/browser/view.ts src/main/browser/view.test.ts src/main/ai/tools/browserScreenshot.ts src/main/ai/tools/browserScreenshot.test.ts src/main/ai/tools/registry.ts
git commit -m "Add screenshot capture and the browser_screenshot tool"
```

---

### Task 3: Claude provider — web search, vision, screenshot round-trip

**Files:**
- Modify: `src/main/ai/providers/claude.ts`
- Test: `src/main/ai/providers/claude.test.ts`

**Interfaces:**
- Consumes: `CanonicalContentBlock`, `findCatalogEntry` (Task 1); `browser_screenshot`'s tool name (Task 2, matched by string, no import needed).
- Produces: nothing new — internal behavior change only, `AIProvider` shape unchanged for callers.

**Verified SDK facts this task relies on** (from `node_modules/@anthropic-ai/sdk`, checked 2026-08-26 — re-check if these stop matching what's installed):
- `BetaToolRunnerParams.tools: (BetaToolUnion | BetaRunnableTool<any>)[]` — a raw server-tool object and a `betaTool(...)`-wrapped custom tool can sit in the same array.
- `BetaWebSearchTool20260209 { name: 'web_search'; type: 'web_search_20260209'; ... }` is in `BetaToolUnion`.
- `betaTool(...)` returns a `BetaRunnableTool` that exposes a directly-callable `.run(args, context?): Promisable<string | Array<BetaToolResultContentBlockParam>>` — a tool result can natively carry an image block, no "next round" indirection needed for Anthropic specifically. Tests below call this `.run(...)` directly rather than simulating the whole SDK loop.
- `BetaImageBlockParam { type: 'image'; source: BetaBase64ImageSource | ... }`, `BetaBase64ImageSource { type: 'base64'; media_type: 'image/jpeg'|'image/png'|'image/gif'|'image/webp'; data: string }`.

**Important — the current `claude.test.ts` does not yet mock `@anthropic-ai/sdk` at all** (it only imports the real `APIError` class for `describeError`'s tests, and has one trivial `createClaudeProvider` smoke test). This task adds that mock, following the same `vi.mock(..., async (importOriginal) => ({ ...actual, <replaced-export>: vi.fn() }))` shape `gemini.test.ts` already uses for `GoogleGenAI` — keep `APIError` real, replace only the default export (`Anthropic`).

- [ ] **Step 1: Write failing tests**

At the top of `src/main/ai/providers/claude.test.ts`, add the mock (after the existing imports, before the first `describe`):

```ts
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>();
  return { ...actual, default: vi.fn() };
});
```

Add these helpers, after the mock:

```ts
function fakeCtx() {
  return { db: {} as never, conversationId: 'c1', mode: 'ask' as const, requestConfirmation: vi.fn() };
}

/** An empty async-iterable runner -- the streamTurn `for await` loop body
 *  never executes, finalText stays '', and streamTurn resolves cleanly.
 *  Enough to inspect what was PASSED to toolRunner without simulating the
 *  SDK's real streaming/tool-call machinery. */
function emptyRunner() {
  return (async function* () {})();
}
```

Append these test blocks to the file:

```ts
describe('web search capability', () => {
  it('adds the hosted web_search tool for a model whose catalog entry supports it', async () => {
    const toolRunner = vi.fn().mockReturnValue(emptyRunner());
    vi.mocked(Anthropic).mockReturnValue({ beta: { messages: { toolRunner } } } as never);

    const provider = createClaudeProvider('sk-ant-test', 'claude-sonnet-5');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx: fakeCtx(), onEvent: vi.fn() });

    const passedTools = toolRunner.mock.calls[0][0].tools;
    expect(passedTools).toContainEqual({ type: 'web_search_20260209', name: 'web_search' });
  });

  it('omits web_search for a model whose catalog entry does not support it', async () => {
    const toolRunner = vi.fn().mockReturnValue(emptyRunner());
    vi.mocked(Anthropic).mockReturnValue({ beta: { messages: { toolRunner } } } as never);

    const provider = createClaudeProvider('sk-ant-test', 'claude-haiku-4-5-20251001');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx: fakeCtx(), onEvent: vi.fn() });

    const passedTools = toolRunner.mock.calls[0][0].tools as Array<{ type?: string }>;
    expect(passedTools.some((t) => typeof t.type === 'string' && t.type.startsWith('web_search_'))).toBe(false);
  });
});

describe('toBetaTools vision gating', () => {
  const tools: import('../tools/types').ToolDefinition[] = [
    { name: 'a', tier: 'READ', label: 'A', schema: { name: 'a', description: '', input_schema: { type: 'object', properties: {} } }, run: async () => 'x' },
    {
      name: 'browser_screenshot',
      tier: 'READ',
      label: 'Screenshot',
      schema: { name: 'browser_screenshot', description: '', input_schema: { type: 'object', properties: {} } },
      run: async () => 'x',
    },
  ];

  it('drops browser_screenshot when visionCapable is false', () => {
    const wrapped = toBetaTools(tools, fakeCtx(), false);
    expect(wrapped.map((t) => t.name)).toEqual(['a']);
  });

  it('keeps browser_screenshot when visionCapable is true', () => {
    const wrapped = toBetaTools(tools, fakeCtx(), true);
    expect(wrapped.map((t) => t.name)).toEqual(['a', 'browser_screenshot']);
  });
});

describe('screenshot tool results', () => {
  it("wraps a tool's plain string result as a multi-block array when it attached an image via ctx", async () => {
    const ctx = fakeCtx() as import('../tools/types').ToolContext;
    ctx.pendingImages = [];
    ctx.attachImage = (block) => ctx.pendingImages!.push(block);
    const screenshotTool: import('../tools/types').ToolDefinition = {
      name: 'browser_screenshot',
      tier: 'READ',
      label: 'Screenshot',
      schema: { name: 'browser_screenshot', description: '', input_schema: { type: 'object', properties: {} } },
      run: async (_input, toolCtx) => {
        toolCtx.attachImage?.({ type: 'image', mimeType: 'image/png', data: 'abc123' });
        return 'Screenshot captured.';
      },
    };

    const wrapped = toBetaTools([screenshotTool], ctx, true);
    const result = await wrapped[0].run({});

    expect(result).toEqual([
      { type: 'text', text: 'Screenshot captured.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
    ]);
  });

  it('returns a plain string when the tool attached no image', async () => {
    const ctx = fakeCtx() as import('../tools/types').ToolContext;
    ctx.pendingImages = [];
    const plainTool: import('../tools/types').ToolDefinition = {
      name: 'a',
      tier: 'READ',
      label: 'A',
      schema: { name: 'a', description: '', input_schema: { type: 'object', properties: {} } },
      run: async () => 'plain result',
    };

    const wrapped = toBetaTools([plainTool], ctx, true);
    const result = await wrapped[0].run({});

    expect(result).toBe('plain result');
  });

  it('resets ctx.pendingImages at the start of streamTurn so a stale image from a prior failed attempt never leaks in', async () => {
    const toolRunner = vi.fn().mockReturnValue(emptyRunner());
    vi.mocked(Anthropic).mockReturnValue({ beta: { messages: { toolRunner } } } as never);
    const ctx = fakeCtx() as import('../tools/types').ToolContext;
    ctx.pendingImages = [{ type: 'image', mimeType: 'image/png', data: 'stale' }];

    const provider = createClaudeProvider('sk-ant-test', 'claude-sonnet-5');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx, onEvent: vi.fn() });

    expect(ctx.pendingImages).toEqual([]);
  });
});

describe('attachments', () => {
  it('folds attachments into the first user message as content blocks', async () => {
    const toolRunner = vi.fn().mockReturnValue(emptyRunner());
    vi.mocked(Anthropic).mockReturnValue({ beta: { messages: { toolRunner } } } as never);

    const provider = createClaudeProvider('sk-ant-test', 'claude-sonnet-5');
    await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'summarize this',
      attachments: [
        { type: 'text', text: 'extracted pdf text' },
        { type: 'image', mimeType: 'image/png', data: 'abc123' },
      ],
      tools: [],
      ctx: fakeCtx(),
      onEvent: vi.fn(),
    });

    const messages = toolRunner.mock.calls[0][0].messages as Array<{ content: unknown }>;
    expect(messages[messages.length - 1].content).toEqual([
      { type: 'text', text: 'summarize this' },
      { type: 'text', text: 'extracted pdf text' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
    ]);
  });

  it('sends userText as a plain string when there are no attachments (unchanged behavior)', async () => {
    const toolRunner = vi.fn().mockReturnValue(emptyRunner());
    vi.mocked(Anthropic).mockReturnValue({ beta: { messages: { toolRunner } } } as never);

    const provider = createClaudeProvider('sk-ant-test', 'claude-sonnet-5');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx: fakeCtx(), onEvent: vi.fn() });

    const messages = toolRunner.mock.calls[0][0].messages as Array<{ content: unknown }>;
    expect(messages[messages.length - 1].content).toBe('hi');
  });
});
```

Also change this file's existing import line from `import { createClaudeProvider } from './claude';` to pull in the two new names it now needs:

```ts
import Anthropic, { APIError } from '@anthropic-ai/sdk';
import { createClaudeProvider, toBetaTools } from './claude';
```

(`APIError` was already imported at the top of the file for `describeError`'s tests — merge rather than duplicate the import line.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- claude.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement**

Replace `src/main/ai/providers/claude.ts`'s `toBetaTools` function and the top of `createClaudeProvider` as follows.

Add to the imports:

```ts
import { findCatalogEntry } from './catalog';
```

Replace `toBetaTools` (now exported so tests can call the wrapped tools' `.run()` directly instead of simulating the whole SDK loop):

```ts
export function toBetaTools(tools: ToolDefinition[], ctx: ToolContext, visionCapable: boolean) {
  return tools
    .filter((tool) => visionCapable || tool.schema.name !== 'browser_screenshot')
    .map((tool) =>
      betaTool({
        name: tool.schema.name,
        description: tool.schema.description,
        inputSchema: tool.schema.input_schema as { type: 'object'; [key: string]: unknown },
        run: async (input: Record<string, unknown>) => {
          const text = await tool.run(input, ctx);
          const pending = ctx.pendingImages ?? [];
          if (pending.length === 0) return text;
          const images = pending.splice(0, pending.length);
          return [
            { type: 'text' as const, text },
            ...images.map((image) => ({
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: image.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                data: image.data,
              },
            })),
          ];
        },
      })
    );
}

function toAnthropicContentBlocks(attachments: import('./types').CanonicalContentBlock[]) {
  return attachments.map((block) =>
    block.type === 'text'
      ? { type: 'text' as const, text: block.text }
      : {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: block.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
            data: block.data,
          },
        }
  );
}
```

Then in `createClaudeProvider`'s `streamTurn`, replace the body from `const toolLabels = ...` through the `toolRunner(...)` call with:

```ts
    async streamTurn({ system, history, userText, attachments, tools, ctx, onEvent }) {
      if (ctx.pendingImages) ctx.pendingImages.length = 0;

      const toolLabels = new Map(tools.map((tool) => [tool.schema.name, tool.label]));
      const visionCapable = findCatalogEntry('anthropic', model)?.supportsVision ?? false;
      const webSearchCapable = findCatalogEntry('anthropic', model)?.supportsWebSearch ?? false;

      const userContent =
        attachments && attachments.length > 0
          ? [{ type: 'text' as const, text: userText }, ...toAnthropicContentBlocks(attachments)]
          : userText;

      const messages = [...history, { role: 'user' as const, content: userContent }] as unknown as Anthropic.Beta.Messages.BetaMessageParam[];

      const runnerTools: Array<ReturnType<typeof betaTool> | { type: 'web_search_20260209'; name: 'web_search' }> = [
        ...toBetaTools(tools, ctx, visionCapable),
      ];
      if (webSearchCapable) runnerTools.push({ type: 'web_search_20260209', name: 'web_search' });

      const runner = client.beta.messages.toolRunner({
        model,
        max_tokens: 4096,
        system,
        tools: runnerTools,
        messages,
        stream: true,
      });
```

(The rest of `streamTurn` — the `for await` loop, error handling, return — is unchanged.)

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- claude.test.ts`
Expected: PASS

- [ ] **Step 5: Full test run and commit**

Run: `npm test`
Expected: all pass.

```bash
git add src/main/ai/providers/claude.ts src/main/ai/providers/claude.test.ts
git commit -m "Give the Claude provider web search, vision, and screenshot round-tripping"
```

---

### Task 4: Gemini provider — search grounding, vision, screenshot round-trip

**Files:**
- Modify: `src/main/ai/providers/gemini.ts`
- Test: `src/main/ai/providers/gemini.test.ts`

**Interfaces:**
- Consumes: `CanonicalContentBlock`, `findCatalogEntry` (Task 1).
- Produces: nothing new — internal behavior change only.

**Verified SDK facts** (from `node_modules/@google/genai`, checked 2026-08-26):
- `Tool { functionDeclarations?: FunctionDeclaration[]; googleSearch?: GoogleSearch; ... }` — both fields live on the same `Tool` object, so a request can combine custom function tools with search grounding.
- `Part { text?: string; inlineData?: Blob_2; functionResponse?: FunctionResponse; ... }`, `Blob_2 { data?: string; mimeType?: string }` — `data` is a base64 string, no data-URI prefix.

- [ ] **Step 1: Write failing tests**

Append to `src/main/ai/providers/gemini.test.ts`, reusing its existing `fakeStream`, `fakeCtx`, and `GoogleGenAI` mock (already present at the top of the file from Phase 8's Task 5 — do not redefine them):

```ts
describe('toFunctionDeclarations vision gating', () => {
  const tools: ToolDefinition[] = [
    { name: 'a', tier: 'READ', label: 'A', schema: { name: 'a', description: '', input_schema: { type: 'object', properties: {} } }, run: async () => 'x' },
    {
      name: 'browser_screenshot',
      tier: 'READ',
      label: 'Screenshot',
      schema: { name: 'browser_screenshot', description: '', input_schema: { type: 'object', properties: {} } },
      run: async () => 'x',
    },
  ];

  it('drops browser_screenshot when visionCapable is false', () => {
    expect(toFunctionDeclarations(tools, false).map((d) => d.name)).toEqual(['a']);
  });

  it('keeps browser_screenshot when visionCapable is true', () => {
    expect(toFunctionDeclarations(tools, true).map((d) => d.name)).toEqual(['a', 'browser_screenshot']);
  });
});

describe('search grounding', () => {
  it('adds googleSearch to the tools config when supportsWebSearch is true for the model', async () => {
    const sendMessageStream = vi.fn().mockResolvedValue(fakeStream([{ text: 'hi' }]));
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    vi.mocked(GoogleGenAI).mockReturnValue({ chats: { create } } as never);

    const provider = createGeminiProvider('test-key', 'gemini-2.5-flash'); // supportsWebSearch: true per catalog.ts
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx: fakeCtx(), onEvent: vi.fn() });

    const configTools = create.mock.calls[0][0].config.tools as Array<Record<string, unknown>>;
    expect(configTools.some((t) => 'googleSearch' in t)).toBe(true);
  });

  it('omits googleSearch and sends no tools config at all for a model not in the static catalog (findCatalogEntry returns undefined, defaulting supportsWebSearch to false)', async () => {
    const sendMessageStream = vi.fn().mockResolvedValue(fakeStream([{ text: 'hi' }]));
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    vi.mocked(GoogleGenAI).mockReturnValue({ chats: { create } } as never);

    const provider = createGeminiProvider('test-key', 'some-future-gemini-model');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx: fakeCtx(), onEvent: vi.fn() });

    expect(create.mock.calls[0][0].config.tools).toBeUndefined();
  });
});

describe('attachments', () => {
  it('folds text and image attachments into the first sendMessageStream call as extra Parts', async () => {
    const sendMessageStream = vi.fn().mockResolvedValue(fakeStream([{ text: 'ok' }]));
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    vi.mocked(GoogleGenAI).mockReturnValue({ chats: { create } } as never);

    const provider = createGeminiProvider('test-key', 'gemini-2.5-flash');
    await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'summarize this',
      attachments: [
        { type: 'text', text: 'pdf text' },
        { type: 'image', mimeType: 'image/png', data: 'abc' },
      ],
      tools: [],
      ctx: fakeCtx(),
      onEvent: vi.fn(),
    });

    expect(sendMessageStream.mock.calls[0][0].message).toEqual([
      { text: 'summarize this' },
      { text: 'pdf text' },
      { inlineData: { mimeType: 'image/png', data: 'abc' } },
    ]);
  });

  it('sends userText as a plain string when there are no attachments (unchanged behavior)', async () => {
    const sendMessageStream = vi.fn().mockResolvedValue(fakeStream([{ text: 'ok' }]));
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    vi.mocked(GoogleGenAI).mockReturnValue({ chats: { create } } as never);

    const provider = createGeminiProvider('test-key', 'gemini-2.5-flash');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx: fakeCtx(), onEvent: vi.fn() });

    expect(sendMessageStream.mock.calls[0][0].message).toBe('hi');
  });
});

describe('screenshot round-trip', () => {
  it('injects a pending screenshot image as an inlineData Part in the round AFTER the tool call that attached it', async () => {
    const screenshotTool: ToolDefinition = {
      name: 'browser_screenshot',
      tier: 'READ',
      label: 'Screenshot',
      schema: { name: 'browser_screenshot', description: '', input_schema: { type: 'object', properties: {} } },
      run: async (_input, toolCtx) => {
        toolCtx.attachImage?.({ type: 'image', mimeType: 'image/png', data: 'xyz' });
        return 'Screenshot captured.';
      },
    };
    const sendMessageStream = vi
      .fn()
      .mockResolvedValueOnce(fakeStream([{ functionCalls: [{ name: 'browser_screenshot', args: {} }] }]))
      .mockResolvedValueOnce(fakeStream([{ text: 'I can see the page now.' }]));
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    vi.mocked(GoogleGenAI).mockReturnValue({ chats: { create } } as never);

    const ctx = fakeCtx() as ToolContext;
    ctx.pendingImages = [];
    ctx.attachImage = (block) => ctx.pendingImages!.push(block);

    const provider = createGeminiProvider('test-key', 'gemini-2.5-flash');
    const result = await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'what do you see?',
      tools: [screenshotTool],
      ctx,
      onEvent: vi.fn(),
    });

    expect(result).toEqual([{ type: 'text', text: 'I can see the page now.' }]);
    expect(sendMessageStream.mock.calls[1][0].message).toEqual([
      { functionResponse: { name: 'browser_screenshot', response: { output: 'Screenshot captured.' } } },
      { inlineData: { mimeType: 'image/png', data: 'xyz' } },
    ]);
    expect(ctx.pendingImages).toEqual([]);
  });

  it('resets ctx.pendingImages at the start of streamTurn so a stale image from a prior failed attempt never leaks in', async () => {
    const sendMessageStream = vi.fn().mockResolvedValue(fakeStream([{ text: 'ok' }]));
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    vi.mocked(GoogleGenAI).mockReturnValue({ chats: { create } } as never);

    const ctx = fakeCtx() as ToolContext;
    ctx.pendingImages = [{ type: 'image', mimeType: 'image/png', data: 'stale' }];

    const provider = createGeminiProvider('test-key', 'gemini-2.5-flash');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx, onEvent: vi.fn() });

    expect(ctx.pendingImages).toEqual([]);
  });
});
```

Add `ToolContext` to this file's existing `import type { ToolDefinition } from '../tools/types';` line: `import type { ToolContext, ToolDefinition } from '../tools/types';`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- gemini.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to imports:

```ts
import { findCatalogEntry } from './catalog';
import type { CanonicalContentBlock } from './types';
```

Change `toFunctionDeclarations` to take a vision flag:

```ts
export function toFunctionDeclarations(tools: ToolDefinition[], visionCapable: boolean): FunctionDeclaration[] {
  return tools
    .filter((tool) => visionCapable || tool.schema.name !== 'browser_screenshot')
    .map((tool) => ({
      name: tool.schema.name,
      description: tool.schema.description,
      parametersJsonSchema: tool.schema.input_schema,
    }));
}
```

Add a helper to convert attachments to Parts:

```ts
function attachmentsToParts(attachments: CanonicalContentBlock[]): Part[] {
  return attachments.map((block) =>
    block.type === 'text' ? { text: block.text } : { inlineData: { mimeType: block.mimeType, data: block.data } }
  );
}
```

Replace the start of `createGeminiProvider`'s `streamTurn`:

```ts
    async streamTurn({ system, history, userText, attachments, tools, ctx, onEvent }) {
      if (ctx.pendingImages) ctx.pendingImages.length = 0;

      const toolLabels = new Map(tools.map((tool) => [tool.schema.name, tool.label]));
      const visionCapable = findCatalogEntry('gemini', model)?.supportsVision ?? false;
      const webSearchCapable = findCatalogEntry('gemini', model)?.supportsWebSearch ?? false;
      const functionDeclarations = toFunctionDeclarations(tools, visionCapable);

      const configTools = [
        ...(functionDeclarations.length > 0 ? [{ functionDeclarations }] : []),
        ...(webSearchCapable ? [{ googleSearch: {} }] : []),
      ];

      const chat = client.chats.create({
        model,
        history: toGeminiHistory(history),
        config: {
          systemInstruction: system,
          tools: configTools.length > 0 ? configTools : undefined,
        },
      });

      let finalText = '';
      let nextMessage: Part[] | string =
        attachments && attachments.length > 0 ? [{ text: userText }, ...attachmentsToParts(attachments)] : userText;
```

(`MAX_ROUNDS` and the loop's start are unchanged.) Inside the loop, after tool calls execute and `nextMessage` is built from `functionCalls.map(...)`, append any pending screenshot images from that round. Replace:

```ts
          nextMessage = await Promise.all(
            functionCalls.map(async (call) => ({
              functionResponse: {
                name: call.name,
                response: { output: await runOneTool(tools, ctx, call.name, call.args) },
              },
            }))
          );
```

with:

```ts
          const responseParts: Part[] = await Promise.all(
            functionCalls.map(async (call) => ({
              functionResponse: {
                name: call.name,
                response: { output: await runOneTool(tools, ctx, call.name, call.args) },
              },
            }))
          );
          const pending = ctx.pendingImages ?? [];
          if (pending.length > 0) {
            responseParts.push(...pending.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } })));
            pending.length = 0;
          }
          nextMessage = responseParts;
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- gemini.test.ts`
Expected: PASS

- [ ] **Step 5: Full test run and commit**

Run: `npm test`

```bash
git add src/main/ai/providers/gemini.ts src/main/ai/providers/gemini.test.ts
git commit -m "Give the Gemini provider search grounding, vision, and screenshot round-tripping"
```

---

### Task 5: Ollama provider — vision, screenshot round-trip (no web search)

**Files:**
- Modify: `src/main/ai/providers/ollama.ts`
- Test: `src/main/ai/providers/ollama.test.ts`

**Interfaces:**
- Consumes: `CanonicalContentBlock`, `isKnownGoodForVision` (Task 1).
- Produces: nothing new. Ollama gets no web-search capability at all, per this phase's design decision (no hosted equivalent exists).

- [ ] **Step 1: Write failing tests**

Append to `src/main/ai/providers/ollama.test.ts`, reusing its existing `ndjsonResponse` and `fakeCtx` helpers (already present at the top of the file from Phase 8's Task 6 — do not redefine them):

```ts
describe('toOllamaTools vision gating', () => {
  const tools: ToolDefinition[] = [
    { name: 'a', tier: 'READ', label: 'A', schema: { name: 'a', description: '', input_schema: { type: 'object', properties: {} } }, run: async () => 'x' },
    {
      name: 'browser_screenshot',
      tier: 'READ',
      label: 'Screenshot',
      schema: { name: 'browser_screenshot', description: '', input_schema: { type: 'object', properties: {} } },
      run: async () => 'x',
    },
  ];

  it('drops browser_screenshot when visionCapable is false', () => {
    expect(toOllamaTools(tools, false).map((t) => t.function.name)).toEqual(['a']);
  });

  it('keeps browser_screenshot when visionCapable is true', () => {
    expect(toOllamaTools(tools, true).map((t) => t.function.name)).toEqual(['a', 'browser_screenshot']);
  });
});

describe('vision via model-name detection', () => {
  const screenshotTool: ToolDefinition = {
    name: 'browser_screenshot',
    tier: 'READ',
    label: 'Screenshot',
    schema: { name: 'browser_screenshot', description: '', input_schema: { type: 'object', properties: {} } },
    run: async () => 'x',
  };

  it('offers browser_screenshot for a known vision model (e.g. llava)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([{ message: { role: 'assistant', content: 'ok' }, done: true }]));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOllamaProvider('http://localhost:11434', 'llava:13b');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [screenshotTool], ctx: fakeCtx(), onEvent: vi.fn() });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toContain('browser_screenshot');
  });

  it('does not offer browser_screenshot for a text-only model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([{ message: { role: 'assistant', content: 'ok' }, done: true }]));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOllamaProvider('http://localhost:11434', 'llama3.1');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [screenshotTool], ctx: fakeCtx(), onEvent: vi.fn() });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).not.toContain('browser_screenshot');
  });
});

describe('toOllamaMessages with attachments', () => {
  it('appends attachment text to the user message content and collects image data into the images field', () => {
    const messages = toOllamaMessages('sys', [], 'summarize this', [
      { type: 'text', text: 'pdf text' },
      { type: 'image', mimeType: 'image/png', data: 'abc' },
    ]);
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'summarize this\n\npdf text', images: ['abc'] });
  });

  it('leaves the user message unchanged when there are no attachments', () => {
    const messages = toOllamaMessages('sys', [], 'hi');
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'hi' });
  });
});

describe('screenshot round-trip', () => {
  it("injects a follow-up user message carrying the screenshot's base64 data after the tool call that attached it", async () => {
    const screenshotTool: ToolDefinition = {
      name: 'browser_screenshot',
      tier: 'READ',
      label: 'Screenshot',
      schema: { name: 'browser_screenshot', description: '', input_schema: { type: 'object', properties: {} } },
      run: async (_input, toolCtx) => {
        toolCtx.attachImage?.({ type: 'image', mimeType: 'image/png', data: 'xyz' });
        return 'Screenshot captured.';
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        ndjsonResponse([
          {
            message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'browser_screenshot', arguments: {} } }] },
            done: true,
          },
        ])
      )
      .mockResolvedValueOnce(ndjsonResponse([{ message: { role: 'assistant', content: 'I can see the page now.' }, done: true }]));
    vi.stubGlobal('fetch', fetchMock);

    const ctx = fakeCtx() as import('../tools/types').ToolContext;
    ctx.pendingImages = [];
    ctx.attachImage = (block) => ctx.pendingImages!.push(block);

    const provider = createOllamaProvider('http://localhost:11434', 'llava:13b');
    const result = await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'what do you see?',
      tools: [screenshotTool],
      ctx,
      onEvent: vi.fn(),
    });

    expect(result).toEqual([{ type: 'text', text: 'I can see the page now.' }]);
    const secondCallBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(secondCallBody.messages).toContainEqual({ role: 'user', content: '(image attached)', images: ['xyz'] });
    expect(ctx.pendingImages).toEqual([]);
  });

  it('resets ctx.pendingImages at the start of streamTurn so a stale image from a prior failed attempt never leaks in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse([{ message: { role: 'assistant', content: 'ok' }, done: true }])));
    const ctx = fakeCtx() as import('../tools/types').ToolContext;
    ctx.pendingImages = [{ type: 'image', mimeType: 'image/png', data: 'stale' }];

    const provider = createOllamaProvider('http://localhost:11434', 'llama3.1');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx, onEvent: vi.fn() });

    expect(ctx.pendingImages).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- ollama.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to imports:

```ts
import { isKnownGoodForVision } from './catalog';
import type { CanonicalContentBlock } from './types';
```

Add `images?: string[]` to `OllamaMessage`:

```ts
interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
  images?: string[];
}
```

Change `toOllamaTools` to take a vision flag:

```ts
export function toOllamaTools(tools: ToolDefinition[], visionCapable: boolean): OllamaTool[] {
  return tools
    .filter((tool) => visionCapable || tool.schema.name !== 'browser_screenshot')
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.schema.name,
        description: tool.schema.description,
        parameters: tool.schema.input_schema,
      },
    }));
}
```

Change `toOllamaMessages` to accept and fold in attachments:

```ts
export function toOllamaMessages(
  system: string,
  history: TurnMessage[],
  userText: string,
  attachments: CanonicalContentBlock[] = []
): OllamaMessage[] {
  const texts = attachments.filter((a): a is { type: 'text'; text: string } => a.type === 'text').map((a) => a.text);
  const images = attachments.filter((a): a is { type: 'image'; mimeType: string; data: string } => a.type === 'image').map((a) => a.data);
  const content = texts.length > 0 ? `${userText}\n\n${texts.join('\n\n')}` : userText;

  const userMessage: OllamaMessage = { role: 'user', content };
  if (images.length > 0) userMessage.images = images;

  return [{ role: 'system', content: system }, ...history.map((m) => ({ role: m.role, content: textOf(m.content) }) as OllamaMessage), userMessage];
}
```

Replace the start of `createOllamaProvider`'s `streamTurn`:

```ts
    async streamTurn({ system, history, userText, attachments, tools, ctx, onEvent }) {
      if (ctx.pendingImages) ctx.pendingImages.length = 0;

      const toolLabels = new Map(tools.map((tool) => [tool.schema.name, tool.label]));
      const visionCapable = isKnownGoodForVision(model);
      const ollamaTools = toOllamaTools(tools, visionCapable);
      const messages = toOllamaMessages(system, history, userText, attachments);
```

Inside the round loop, after tool calls run and their results are pushed, append a follow-up message for any pending screenshot images. Replace:

```ts
          for (const call of toolCalls) {
            const toolLabel = toolLabels.get(call.function.name) ?? call.function.name;
            onEvent({ type: 'tool-status', toolName: call.function.name, toolLabel } satisfies StreamEvent);
            const result = await runOneTool(tools, ctx, call.function.name, call.function.arguments);
            messages.push({ role: 'tool', content: result, tool_name: call.function.name });
          }
```

with:

```ts
          for (const call of toolCalls) {
            const toolLabel = toolLabels.get(call.function.name) ?? call.function.name;
            onEvent({ type: 'tool-status', toolName: call.function.name, toolLabel } satisfies StreamEvent);
            const result = await runOneTool(tools, ctx, call.function.name, call.function.arguments);
            messages.push({ role: 'tool', content: result, tool_name: call.function.name });
          }

          const pending = ctx.pendingImages ?? [];
          if (pending.length > 0) {
            messages.push({ role: 'user', content: '(image attached)', images: pending.map((image) => image.data) });
            pending.length = 0;
          }
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- ollama.test.ts`
Expected: PASS

- [ ] **Step 5: Full test run and commit**

Run: `npm test`

```bash
git add src/main/ai/providers/ollama.ts src/main/ai/providers/ollama.test.ts
git commit -m "Give the Ollama provider vision support and screenshot round-tripping"
```

---

### Task 6: Local text extraction (PDF, .docx)

**Files:**
- Create: `src/main/ai/attachments/extractText.ts`
- Test: `src/main/ai/attachments/extractText.test.ts`
- Test fixtures: `src/main/ai/attachments/fixtures/sample.pdf`, `src/main/ai/attachments/fixtures/sample.docx`
- Modify: `package.json`

**Interfaces:**
- Produces: `extractPdfText(buffer: Buffer): Promise<string>`, `extractDocxText(buffer: Buffer): Promise<string>`.
- Consumes: nothing from earlier tasks — this is a standalone, pure module.

- [ ] **Step 1: Install dependencies**

Run: `npm view pdfjs-dist version` and `npm view mammoth version` to confirm current versions (verified `5.4.296` and `1.12.1` at plan-writing time — use whatever is actually current now).

```bash
npm install pdfjs-dist mammoth
```

- [ ] **Step 2: Create fixture files**

Create a minimal real `.docx` fixture. The simplest reliable way: write a script that uses `mammoth`'s own test fixtures as a template, or generate one by hand with any Word-compatible tool and commit the binary. If no such tool is available in this environment, create the fixture programmatically with a tiny script using the `docx` file format's minimal OOXML structure — but since `mammoth` needs a syntactically valid `.docx` (a zip of OOXML parts), the most reliable path is: create it in Node using a zip library already available transitively (`jszip`, a transitive dependency of `mammoth`) to hand-assemble a minimal valid `.docx` containing one paragraph of text. Write this as a one-off script, run it once to produce `src/main/ai/attachments/fixtures/sample.docx`, and commit the resulting binary (do not commit the generator script unless useful for future regeneration — if kept, put it in the test file's `beforeAll` instead of a fixture at all, which is simpler: generate the `.docx` buffer in-memory in the test using `jszip` directly, avoiding a fixture file entirely).

For the PDF fixture, use the same in-test-generation approach: a valid minimal PDF with one text string can be written as a short hardcoded PDF byte string (PDF's text format for a single page with one line of text is compact enough to inline) rather than committing a binary fixture. Prefer generating both fixtures **inside the test file** (via `beforeAll`, writing valid minimal bytes) over committing binary fixture files, so the test suite has no external binary dependencies.

- [ ] **Step 3: Write failing tests**

Create `src/main/ai/attachments/extractText.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';

const MINIMAL_PDF_WITH_TEXT = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length 58>>stream
BT /F1 18 Tf 10 50 Td (Hello from a test PDF) Tj ET
endstream
endobj
xref
0 6
trailer<</Size 6/Root 1 0 R>>
startxref
0
%%EOF`,
  'utf8'
);

async function buildMinimalDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('extractPdfText', () => {
  it('extracts the visible text from a simple one-page PDF', async () => {
    const { extractPdfText } = await import('./extractText');
    const text = await extractPdfText(MINIMAL_PDF_WITH_TEXT);
    expect(text).toContain('Hello from a test PDF');
  });
});

describe('extractDocxText', () => {
  it('extracts the paragraph text from a minimal .docx', async () => {
    const { extractDocxText } = await import('./extractText');
    const buffer = await buildMinimalDocx('Hello from a test document');
    const text = await extractDocxText(buffer);
    expect(text).toContain('Hello from a test document');
  });
});
```

If the hand-written minimal PDF above does not parse cleanly with `pdfjs-dist` (PDF's xref table format is strict), fall back to generating the fixture with a tiny inline PDF-writing routine that follows a working minimal example from `pdfjs-dist`'s own test fixtures (`node_modules/pdfjs-dist` does not ship test PDFs, but `pdf.js`'s public repo does — a simpler fallback is acceptable: skip byte-perfect hand-authoring and instead accept any implementation detail that produces a valid single-page PDF with one text run, adjusting the xref offsts/table to be numerically correct, which `pdfjs-dist` requires unlike some lenient parsers). Verify by running the test — if it fails on PDF parsing (not on missing text), fix the byte-level PDF structure until `getDocument(...)` successfully loads it, rather than weakening the assertion.

- [ ] **Step 4: Run to verify failure**

Run: `npm test -- extractText.test.ts`
Expected: FAIL — module does not exist yet (and possibly further iteration needed on the inline PDF bytes per the note above — get that working before proceeding).

- [ ] **Step 5: Implement**

Create `src/main/ai/attachments/extractText.ts`:

```ts
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';

/** Reads the real text layer only -- a scanned/image-only PDF yields little
 *  or nothing. No OCR in this phase; see the design spec's Deferred section. */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(buffer) }).promise;
  try {
    const pages: string[] = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
      pages.push(pageText);
    }
    return pages.join('\n\n');
  } finally {
    await doc.destroy();
  }
}

export async function extractDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}
```

- [ ] **Step 6: Run to verify pass**

Run: `npm test -- extractText.test.ts`
Expected: PASS

- [ ] **Step 7: Full test run and commit**

Run: `npm test`

```bash
git add package.json package-lock.json src/main/ai/attachments/extractText.ts src/main/ai/attachments/extractText.test.ts
git commit -m "Add local PDF and .docx text extraction"
```

---

### Task 7: File-picker IPC, pending-attachment store, `handleSendMessage` wiring

**Files:**
- Create: `src/main/ai/attachments/pickAttachment.ts`
- Test: `src/main/ai/attachments/pickAttachment.test.ts`
- Modify: `src/main/ai/chatController.ts`
- Modify: `src/main/ai/chatController.test.ts`
- Modify: `src/main/ai/ipc.ts`
- Test: `src/main/ai/ipc.test.ts`

**Interfaces:**
- Consumes: `extractPdfText`/`extractDocxText` (Task 6), `CanonicalContentBlock` (Task 1), `getActiveCapabilities` (Task 1).
- Produces: `pickAttachment(window, supportsVision): Promise<PickAttachmentResult | null>`, `takeAttachments(ids: string[]): { blocks: CanonicalContentBlock[]; placeholders: string[] }`.
- Produces: IPC `ai:pick-attachment` → `PickAttachmentResult | null`; `ai:send-message` gains a 4th arg `attachmentIds: string[]`.
- Changes: `handleSendMessage`'s trailing params become an options object — see Step 5.

- [ ] **Step 1: Write failing tests for `pickAttachment`/`takeAttachments`**

Create `src/main/ai/attachments/pickAttachment.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const showOpenDialog = vi.fn();
vi.mock('electron', () => ({ dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) } }));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: vi.fn() };
});

describe('pickAttachment', () => {
  beforeEach(() => {
    showOpenDialog.mockReset();
  });

  it('returns null when the dialog is cancelled', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const { pickAttachment } = await import('./pickAttachment');
    expect(await pickAttachment(null, true)).toBeNull();
  });

  it('extracts .txt content directly and returns an ok result with a text block pending', async () => {
    const { readFile } = await import('node:fs/promises');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/notes.txt'] });
    vi.mocked(readFile).mockResolvedValue('some notes' as never);
    const { pickAttachment, takeAttachments } = await import('./pickAttachment');
    const result = await pickAttachment(null, true);
    expect(result).toMatchObject({ ok: true, name: 'notes.txt', kind: 'text' });
    if (result?.ok !== true) throw new Error('expected ok');
    const { blocks, placeholders } = takeAttachments([result.id]);
    expect(blocks).toEqual([{ type: 'text', text: 'some notes' }]);
    expect(placeholders[0]).toContain('notes.txt');
  });

  it('rejects an image file when supportsVision is false, without opening the file', async () => {
    const { readFile } = await import('node:fs/promises');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/photo.png'] });
    const { pickAttachment } = await import('./pickAttachment');
    const result = await pickAttachment(null, false);
    expect(result).toMatchObject({ ok: false });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('reads an image file into a base64 image block when supportsVision is true', async () => {
    const { readFile } = await import('node:fs/promises');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/photo.png'] });
    vi.mocked(readFile).mockResolvedValue(Buffer.from('fake-bytes') as never);
    const { pickAttachment, takeAttachments } = await import('./pickAttachment');
    const result = await pickAttachment(null, true);
    expect(result).toMatchObject({ ok: true, kind: 'image' });
    if (result?.ok !== true) throw new Error('expected ok');
    const { blocks } = takeAttachments([result.id]);
    expect(blocks).toEqual([{ type: 'image', mimeType: 'image/png', data: Buffer.from('fake-bytes').toString('base64') }]);
  });

  it('rejects an unsupported extension', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/archive.zip'] });
    const { pickAttachment } = await import('./pickAttachment');
    const result = await pickAttachment(null, true);
    expect(result).toMatchObject({ ok: false });
  });

  it('takeAttachments only redeems an id once, and ignores an unknown id', async () => {
    const { readFile } = await import('node:fs/promises');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/notes.txt'] });
    vi.mocked(readFile).mockResolvedValue('x' as never);
    const { pickAttachment, takeAttachments } = await import('./pickAttachment');
    const result = await pickAttachment(null, true);
    if (result?.ok !== true) throw new Error('expected ok');
    expect(takeAttachments([result.id]).blocks).toHaveLength(1);
    expect(takeAttachments([result.id]).blocks).toHaveLength(0);
    expect(takeAttachments(['not-a-real-id']).blocks).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- pickAttachment.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/main/ai/attachments/pickAttachment.ts`:

```ts
import { dialog, type BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { CanonicalContentBlock } from '../providers/types';
import { extractDocxText, extractPdfText } from './extractText';

interface PendingAttachment {
  placeholder: string;
  block: CanonicalContentBlock;
}

export type PickAttachmentResult =
  | { ok: true; id: string; name: string; kind: 'text' | 'image' }
  | { ok: false; reason: string };

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// Same allow-list-by-id pattern as canvas/ipc.ts's pickedFilePaths -- an id
// only exists here if this module's own picker issued it.
const pending = new Map<string, PendingAttachment>();
let counter = 0;

export async function pickAttachment(
  window: BrowserWindow | null,
  supportsVision: boolean
): Promise<PickAttachmentResult | null> {
  const dialogOptions = {
    properties: ['openFile'] as const,
    filters: [{ name: 'Documents & Images', extensions: ['pdf', 'docx', 'txt', 'png', 'jpg', 'jpeg', 'gif', 'webp'] }],
  };
  const result = window ? await dialog.showOpenDialog(window, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];
  const name = basename(filePath);
  const ext = extname(filePath).toLowerCase();

  try {
    if (ext in IMAGE_MIME) {
      if (!supportsVision) {
        return {
          ok: false,
          reason: "The current AI model can't see images — switch to a vision-capable model in Settings to attach images.",
        };
      }
      const buffer = await readFile(filePath);
      const id = `attach-${++counter}`;
      pending.set(id, {
        placeholder: `[attached: ${name} — image]`,
        block: { type: 'image', mimeType: IMAGE_MIME[ext], data: buffer.toString('base64') },
      });
      return { ok: true, id, name, kind: 'image' };
    }

    let text: string;
    if (ext === '.pdf') text = await extractPdfText(await readFile(filePath));
    else if (ext === '.docx') text = await extractDocxText(await readFile(filePath));
    else if (ext === '.txt') text = (await readFile(filePath, 'utf8')) as string;
    else return { ok: false, reason: `Unsupported file type: ${ext || 'unknown'}.` };

    const trimmed = text.trim();
    if (trimmed.length === 0) return { ok: false, reason: `Couldn't find any readable text in ${name}.` };

    const id = `attach-${++counter}`;
    pending.set(id, {
      placeholder: `[attached: ${name} — ${trimmed.length.toLocaleString()} chars extracted]`,
      block: { type: 'text', text: trimmed },
    });
    return { ok: true, id, name, kind: 'text' };
  } catch {
    return { ok: false, reason: `Couldn't read ${name}.` };
  }
}

/** Redeems each id at most once -- an unknown or already-redeemed id is
 *  silently skipped rather than erroring, since a send that races a stale
 *  attachment chip in the renderer should still succeed with what's left. */
export function takeAttachments(ids: string[]): { blocks: CanonicalContentBlock[]; placeholders: string[] } {
  const blocks: CanonicalContentBlock[] = [];
  const placeholders: string[] = [];
  for (const id of ids) {
    const attachment = pending.get(id);
    if (!attachment) continue;
    blocks.push(attachment.block);
    placeholders.push(attachment.placeholder);
    pending.delete(id);
  }
  return { blocks, placeholders };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- pickAttachment.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing tests for `handleSendMessage`'s new options param**

`chatController.test.ts` currently calls `handleSendMessage(db, getWindowFn, text, view, provider)` positionally in ~7 places, and once with a raw `{ streamTurn }` object as the 5th arg. Update **every** existing call site in this file to wrap the trailing provider (and, where relevant, attachment ids) into an options object:

- `handleSendMessage(db, () => window as never, 'hello', null)` → **unchanged** (no options needed, defaults apply).
- `handleSendMessage(db, () => window as never, 'hello', null, provider)` → `handleSendMessage(db, () => window as never, 'hello', null, { provider })`
- Every other call passing a `provider` as the 5th positional arg gets the same `{ provider }` wrap.
- `handleSendMessage(db, () => fakeWindow() as never, 'hi', null, { streamTurn })` (in the `system prompt` describe block) → `handleSendMessage(db, () => fakeWindow() as never, 'hi', null, { provider: { streamTurn } })`

Then add new tests, appended to the file:

```ts
describe('attachments', () => {
  it('persists a text placeholder instead of the full extracted content, and passes the real content to the provider', async () => {
    const { handleSendMessage } = await import('./chatController');
    const { takeAttachments } = await import('./attachments/pickAttachment');
    vi.spyOn(await import('./attachments/pickAttachment'), 'takeAttachments').mockReturnValue({
      blocks: [{ type: 'text', text: 'the full pdf text' }],
      placeholders: ['[attached: syllabus.pdf — 17 chars extracted]'],
    });
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const window = fakeWindow();
    const streamTurn = vi.fn().mockResolvedValue([{ type: 'text', text: 'ok' }]);
    await handleSendMessage(db, () => window as never, 'summarize this', null, {
      attachmentIds: ['attach-1'],
      provider: { streamTurn },
    });

    expect(streamTurn.mock.calls[0][0].attachments).toEqual([{ type: 'text', text: 'the full pdf text' }]);

    const rows = db.prepare('select content from ai_messages where role = ?').all('user') as Array<{ content: string }>;
    const persisted = JSON.parse(rows[0].content)[0].text as string;
    expect(persisted).toContain('summarize this');
    expect(persisted).toContain('[attached: syllabus.pdf — 17 chars extracted]');
    expect(persisted).not.toContain('the full pdf text');
  });

  it('omits attachments entirely from the provider call when none were sent', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const streamTurn = vi.fn().mockResolvedValue([{ type: 'text', text: 'ok' }]);
    await handleSendMessage(db, () => fakeWindow() as never, 'hi', null, { provider: { streamTurn } });
    expect(streamTurn.mock.calls[0][0].attachments).toBeUndefined();
  });
});
```

(Adjust the mock of `takeAttachments` to whatever mocking style the rest of this test file already uses — it currently imports `./chatController` fresh per test via dynamic `import()`, so mock `./attachments/pickAttachment` with `vi.mock` at the top of the file, matching the existing `vi.mock('electron', ...)` pattern, rather than `vi.spyOn` after the fact.)

- [ ] **Step 6: Run to verify failure**

Run: `npm test -- chatController.test.ts`
Expected: FAIL — `handleSendMessage`'s signature doesn't accept an options object yet, and `attachments/pickAttachment` doesn't exist as an importable mock target from this file's perspective until Step 3 lands (it already will have, since Task 6/7 run in order) — the failures here should be specifically about the new options shape and the new test assertions.

- [ ] **Step 7: Implement `handleSendMessage`'s new signature**

In `src/main/ai/chatController.ts`, add the import:

```ts
import { takeAttachments } from './attachments/pickAttachment';
import type { CanonicalImageBlock } from './providers/types';
```

Change the function signature:

```ts
export async function handleSendMessage(
  db: Database.Database,
  getWindow: () => BrowserWindow | null,
  userText: string,
  view: ViewContext | null,
  options: { attachmentIds?: string[]; provider?: AIProvider } = {}
): Promise<void> {
  const { attachmentIds = [], provider = getProvider(db) } = options;
  const send = (event: StreamEvent): void => getWindow()?.webContents.send('ai:stream-event', event);
```

Inside the function body, after `const ctx: ToolContext = { ... };` (extend `ctx`'s construction — see next step), and before the `try { const finalContent = ... }` block, add:

```ts
    const { blocks: attachments, placeholders } = takeAttachments(attachmentIds);
```

Change the `provider.streamTurn(...)` call to include `attachments`:

```ts
      const finalContent = await provider.streamTurn({
        system: buildSystemPrompt(db, view),
        history,
        userText,
        attachments: attachments.length > 0 ? attachments : undefined,
        tools: TOOLS,
        ctx,
        onEvent: send,
      });
      const persistedUserText = placeholders.length > 0 ? `${userText}\n\n${placeholders.join('\n')}` : userText;
      appendMessage(db, conversationId, 'user', [{ type: 'text', text: persistedUserText }]);
      appendMessage(db, conversationId, 'assistant', finalContent);
```

Extend the `ctx` object literal to include the image side-channel:

```ts
    const pendingImages: CanonicalImageBlock[] = [];
    const ctx: ToolContext = {
      db,
      conversationId,
      mode,
      pendingImages,
      attachImage: (block) => {
        pendingImages.push(block);
      },
      requestConfirmation: (toolName, description, timeoutMs) => {
        if (!getWindow()) return Promise.resolve(false);
        notifyIfUnfocused(getWindow(), 'SmartLife needs your approval', description);
        return requestToolConfirmation(
          (payload) => getWindow()?.webContents.send('ai:confirm-request', payload),
          toolName,
          description,
          timeoutMs
        );
      },
    };
```

(Everything else in `handleSendMessage` — the `turnInFlight` guard, error handling — is unchanged.)

- [ ] **Step 8: Run to verify pass**

Run: `npm test -- chatController.test.ts`
Expected: PASS

- [ ] **Step 9: Wire the IPC handlers**

In `src/main/ai/ipc.ts`, add imports:

```ts
import { pickAttachment } from './attachments/pickAttachment';
import { getActiveCapabilities } from './router';
```

(`router` is already imported in this file for `hasUsableProvider`/`resetProviderCache`/`retryProviderEntry` — add `getActiveCapabilities` to that existing import line rather than a new one.)

Change the `ai:send-message` handler:

```ts
  ipcMain.handle('ai:send-message', (_event, text: string, view: ViewContext | null, attachmentIds: string[] = []) =>
    handleSendMessage(db, getWindow, text, view ?? null, { attachmentIds })
  );
```

Add a new handler, near the other capability-adjacent handlers (after `ai:has-usable-provider`):

```ts
  ipcMain.handle('ai:pick-attachment', () => pickAttachment(getWindow(), getActiveCapabilities(db).supportsVision));
```

- [ ] **Step 10: Write a failing test for the new IPC handler**

`ipc.test.ts` already mocks the whole `./router` module as `routerMocks` (`vi.mock('./router', () => routerMocks)`) and captures registered handlers via a `handlers` map (see `setup()`). Add `getActiveCapabilities` to the existing `routerMocks` object:

```ts
const routerMocks = {
  getProvider: vi.fn(),
  resetProviderCache: vi.fn(),
  retryProviderEntry: vi.fn(),
  hasUsableProvider: vi.fn(),
  getActiveCapabilities: vi.fn(),
};
```

Add a mock for the new attachments module, right after the existing `vi.mock('./router', () => routerMocks);` line:

```ts
const pickAttachmentMock = vi.fn();
vi.mock('./attachments/pickAttachment', () => ({ pickAttachment: pickAttachmentMock }));
```

Append a new describe block:

```ts
describe('ai:pick-attachment', () => {
  it('calls pickAttachment with the current window and the active vision capability', async () => {
    const { call } = await setup();
    routerMocks.getActiveCapabilities.mockReturnValue({ supportsVision: true, supportsWebSearch: false });
    pickAttachmentMock.mockResolvedValue({ ok: true, id: 'attach-1', name: 'notes.txt', kind: 'text' });

    const result = await call('ai:pick-attachment');

    // setup() registers handlers via registerAiIpcHandlers(db, () => null),
    // so the window argument pickAttachment receives is null.
    expect(pickAttachmentMock).toHaveBeenCalledWith(null, true);
    expect(result).toEqual({ ok: true, id: 'attach-1', name: 'notes.txt', kind: 'text' });
  });
});
```

- [ ] **Step 11: Run to verify pass**

Run: `npm test -- ipc.test.ts`
Expected: PASS (after implementing per Step 9, which is already done — this step is verifying the test itself against the real implementation).

- [ ] **Step 12: Full test run and commit**

Run: `npm test`
Expected: all pass.

```bash
git add src/main/ai/attachments/pickAttachment.ts src/main/ai/attachments/pickAttachment.test.ts src/main/ai/chatController.ts src/main/ai/chatController.test.ts src/main/ai/ipc.ts src/main/ai/ipc.test.ts
git commit -m "Wire file/image attachments through send-message and the picker IPC"
```

---

### Task 8: Renderer — attach button, attachment chips, preload bridge

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/ai/useConversation.ts`
- Modify: `src/renderer/src/ai/useConversation.test.ts`
- Modify: `src/renderer/src/ai/ChatPanel.tsx`
- Modify: `src/renderer/src/ai/ChatPanel.test.tsx` (or equivalent — check the exact filename in the repo)

**Interfaces:**
- Consumes: `ai:pick-attachment` IPC, `ai:send-message`'s new `attachmentIds` param (Task 7).
- Produces: `useConversation()` gains `attachments`, `attachError`, `addAttachment`, `removeAttachment` in its return value. `ChatPanel` gains matching props.

- [ ] **Step 1: Add the preload bridge method**

In `src/preload/index.ts`, add a local type near the file's other local `Ai*`/`Canvas*` type duplicates:

```ts
type PickAttachmentResult =
  | { ok: true; id: string; name: string; kind: 'text' | 'image' }
  | { ok: false; reason: string };
```

Change `sendMessage`'s signature to accept attachment ids:

```ts
    sendMessage: (text: string, view: unknown = null, attachmentIds: string[] = []): Promise<void> =>
      ipcRenderer.invoke('ai:send-message', text, view, attachmentIds),
```

Add a new method, after `hasUsableProvider`:

```ts
    pickAttachment: (): Promise<PickAttachmentResult | null> => ipcRenderer.invoke('ai:pick-attachment'),
```

- [ ] **Step 2: Write failing tests for `useConversation`'s attachment state**

The file's top-of-file shared `ai` mock object (`const ai = { hasUsableProvider: vi.fn(), getHistory: vi.fn(), ... }`, installed onto `window.smartlife` in `beforeEach` via `Object.defineProperty`) needs one new method added to it:

```ts
const ai = {
  hasUsableProvider: vi.fn(),
  getHistory: vi.fn(),
  sendMessage: vi.fn(),
  onStreamEvent: vi.fn((_cb: (event: unknown) => void) => () => {}),
  onConfirmRequest: vi.fn((_cb: (req: unknown) => void) => () => {}),
  respondToConfirm: vi.fn(),
  getPendingConfirmation: vi.fn(),
  onConfirmResolved: vi.fn((_cb: (id: string) => void) => () => {}),
  pickAttachment: vi.fn(),
};
```

And in the existing `beforeEach`, add a default resolution alongside the others (`ai.sendMessage.mockResolvedValue(undefined);` — check whether the file already sets this default; if not, add it, since the new `sendMessage` tests below need it to resolve):

```ts
  ai.sendMessage.mockResolvedValue(undefined);
```

Add `act` to this file's existing `import { renderHook, waitFor } from '@testing-library/react';` line: `import { act, renderHook, waitFor } from '@testing-library/react';`.

Append a new describe block:

```ts
describe('useConversation — attachments', () => {
  it('addAttachment appends a successful pick result to attachments', async () => {
    ai.pickAttachment.mockResolvedValue({ ok: true, id: 'attach-1', name: 'notes.txt', kind: 'text' });
    const { result } = renderHook(() => useConversation());

    await act(async () => {
      await result.current.addAttachment();
    });

    expect(result.current.attachments).toEqual([{ id: 'attach-1', name: 'notes.txt', kind: 'text' }]);
  });

  it('addAttachment sets attachError and adds nothing when the pick fails', async () => {
    ai.pickAttachment.mockResolvedValue({ ok: false, reason: "can't see images" });
    const { result } = renderHook(() => useConversation());

    await act(async () => {
      await result.current.addAttachment();
    });

    expect(result.current.attachments).toEqual([]);
    expect(result.current.attachError).toBe("can't see images");
  });

  it('addAttachment does nothing when the dialog is cancelled (null result)', async () => {
    ai.pickAttachment.mockResolvedValue(null);
    const { result } = renderHook(() => useConversation());

    await act(async () => {
      await result.current.addAttachment();
    });

    expect(result.current.attachments).toEqual([]);
  });

  it('removeAttachment removes one attachment by id', async () => {
    ai.pickAttachment.mockResolvedValue({ ok: true, id: 'attach-1', name: 'notes.txt', kind: 'text' });
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await result.current.addAttachment();
    });

    act(() => {
      result.current.removeAttachment('attach-1');
    });

    expect(result.current.attachments).toEqual([]);
  });

  it('sendMessage passes the current attachment ids and clears them afterward', async () => {
    ai.pickAttachment.mockResolvedValue({ ok: true, id: 'attach-1', name: 'notes.txt', kind: 'text' });
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await result.current.addAttachment();
    });

    act(() => {
      result.current.sendMessage('hi');
    });

    expect(ai.sendMessage).toHaveBeenCalledWith('hi', null, ['attach-1']);
    expect(result.current.attachments).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- useConversation.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `useConversation`'s attachment state**

In `src/renderer/src/ai/useConversation.ts`, add a type export near `PendingConfirm`:

```ts
export interface PendingAttachment {
  id: string;
  name: string;
  kind: 'text' | 'image';
}
```

Add state, after the existing `apiKeyConfigured` state line:

```ts
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
```

Add callbacks, right before `sendMessage`:

```ts
  const addAttachment = useCallback(async () => {
    const result = await window.smartlife.ai.pickAttachment().catch(() => null);
    if (!result) return;
    if (!result.ok) {
      setAttachError(result.reason);
      return;
    }
    setAttachError(null);
    setAttachments((prev) => [...prev, { id: result.id, name: result.name, kind: result.kind }]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);
```

Change `sendMessage` to include and then clear attachment ids:

```ts
  const sendMessage = useCallback(
    (text: string) => {
      const id = `user-${Date.now()}-${Math.random()}`;
      setMessages((prev) => [...prev, { id, role: 'user', text }]);
      setSending(true);
      streamingIdRef.current = null;
      const attachmentIds = attachments.map((a) => a.id);
      setAttachments([]);
      window.smartlife.ai.sendMessage(text, view, attachmentIds).catch(() => {
        setSending(false);
        setMessages((prev) => [
          ...prev,
          { id: `assistant-${Date.now()}-${Math.random()}`, role: 'assistant', text: 'Something went wrong — try again.' },
        ]);
      });
    },
    [view, attachments]
  );
```

Add the new fields to the hook's return value:

```ts
  return {
    messages,
    statusLabel,
    pendingConfirm,
    sending,
    apiKeyConfigured,
    attachments,
    attachError,
    addAttachment,
    removeAttachment,
    sendMessage,
    respondToConfirm,
  };
```

- [ ] **Step 5: Run to verify pass**

Run: `npm test -- useConversation.test.ts`
Expected: PASS

- [ ] **Step 6: Write failing tests for `ChatPanel`'s attach UI, and update its existing `panel()` helper**

`ChatPanel.test.tsx`'s existing `panel(count)` helper builds a `<ChatPanel>` with a fixed prop set (no `attachments`/`attachError`/`onAddAttachment`/`onRemoveAttachment` — these props don't exist yet). Since this task makes them required props, `panel()` must be updated to pass them, or every existing test using `panel()` fails to typecheck. Update `panel()`:

```tsx
function panel(count: number) {
  return (
    <MemoryRouter>
      <ChatPanel
        messages={messages(count)}
        statusLabel={null}
        pendingConfirm={null}
        sending={false}
        apiKeyConfigured={true}
        input=""
        onInputChange={() => {}}
        onSubmit={() => {}}
        onRespondToConfirm={() => {}}
        attachments={[]}
        attachError={null}
        onAddAttachment={() => {}}
        onRemoveAttachment={() => {}}
      />
    </MemoryRouter>
  );
}
```

Add `userEvent` to this file's imports: `import userEvent from '@testing-library/user-event';` (alongside the existing `import { render, screen } from '@testing-library/react';`).

Append a new describe block using explicit props (not `panel()`, since these tests need to vary `attachments`/`attachError`/the two callbacks per-case):

```tsx
describe('ChatPanel attachments', () => {
  const baseProps = {
    messages: [],
    statusLabel: null,
    pendingConfirm: null,
    sending: false,
    apiKeyConfigured: true,
    input: '',
    onInputChange: vi.fn(),
    onSubmit: vi.fn(),
    onRespondToConfirm: vi.fn(),
    attachments: [] as { id: string; name: string; kind: 'text' | 'image' }[],
    attachError: null as string | null,
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
  };

  it('renders an attach chip per pending attachment with a remove control', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} attachments={[{ id: 'a1', name: 'notes.txt', kind: 'text' }]} />
      </MemoryRouter>
    );
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
  });

  it('calls onRemoveAttachment with the chip’s id', async () => {
    const onRemoveAttachment = vi.fn();
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} attachments={[{ id: 'a1', name: 'notes.txt', kind: 'text' }]} onRemoveAttachment={onRemoveAttachment} />
      </MemoryRouter>
    );
    await userEvent.click(screen.getByRole('button', { name: /remove notes.txt/i }));
    expect(onRemoveAttachment).toHaveBeenCalledWith('a1');
  });

  it('calls onAddAttachment when the attach button is clicked', async () => {
    const onAddAttachment = vi.fn();
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} onAddAttachment={onAddAttachment} />
      </MemoryRouter>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Attach a file' }));
    expect(onAddAttachment).toHaveBeenCalled();
  });

  it('shows attachError when present', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} attachError="can't see images" />
      </MemoryRouter>
    );
    expect(screen.getByText("can't see images")).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Run to verify failure**

Run: `npm test -- ChatPanel` (adjust to the file's real name)
Expected: FAIL.

- [ ] **Step 8: Implement `ChatPanel`'s attach UI**

In `src/renderer/src/ai/ChatPanel.tsx`, extend `ChatPanelProps`:

```ts
export interface ChatPanelProps {
  messages: ChatMessage[];
  statusLabel: string | null;
  pendingConfirm: PendingConfirm | null;
  sending: boolean;
  apiKeyConfigured: boolean | null;
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onRespondToConfirm: (approved: boolean) => void;
  attachments: PendingAttachment[];
  attachError: string | null;
  onAddAttachment: () => void;
  onRemoveAttachment: (id: string) => void;
  /** Called before navigating to Settings from the empty state — lets AIDock close itself first. */
  onNavigateAway?: () => void;
}
```

Add the import:

```ts
import type { ChatMessage, PendingAttachment, PendingConfirm } from './useConversation';
```

Destructure the new props in the component signature, and render an attach row above the composer `<form>`. Replace the `<form onSubmit={onSubmit} ...>` block with:

```tsx
      {(attachments.length > 0 || attachError) && (
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
          {attachments.map((attachment) => (
            <span
              key={attachment.id}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs"
              style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            >
              {attachment.name}
              <button
                type="button"
                onClick={() => onRemoveAttachment(attachment.id)}
                aria-label={`Remove ${attachment.name}`}
                style={{ color: 'var(--color-text-muted)' }}
              >
                ×
              </button>
            </span>
          ))}
          {attachError && <span style={{ color: '#EF4444', fontSize: 12 }}>{attachError}</span>}
        </div>
      )}
      <form onSubmit={onSubmit} className="flex gap-2 p-4" style={{ borderTop: '1px solid var(--color-border)' }}>
        <button
          type="button"
          onClick={onAddAttachment}
          aria-label="Attach a file"
          className="rounded-md px-3 py-2 text-sm"
          style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
        >
          Attach
        </button>
        <input
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          placeholder="Ask SmartLife…"
          className="flex-1 rounded-md px-3 py-2 text-sm"
          style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="rounded-md px-4 py-2 text-sm"
          style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
        >
          Send
        </button>
      </form>
```

- [ ] **Step 9: Run to verify pass**

Run: `npm test -- ChatPanel`
Expected: PASS

- [ ] **Step 10: Wire the new props at both of ChatPanel's call sites**

`<ChatPanel>` is rendered in exactly two places: `src/renderer/src/ai/AIDock.tsx` and `src/renderer/src/routes/AI.tsx`. Both already call `useConversation()` and spread individual fields from its return value into `<ChatPanel>` — add the four new fields to both.

In `src/renderer/src/ai/AIDock.tsx`, extend the existing `<ChatPanel ... />` call (it currently ends with `onNavigateAway={onClose}` — add after that):

```tsx
        <ChatPanel
          messages={conversation.messages}
          statusLabel={conversation.statusLabel}
          pendingConfirm={conversation.pendingConfirm}
          sending={conversation.sending}
          apiKeyConfigured={conversation.apiKeyConfigured}
          input={input}
          onInputChange={setInput}
          onSubmit={handleSubmit}
          onRespondToConfirm={conversation.respondToConfirm}
          onNavigateAway={onClose}
          attachments={conversation.attachments}
          attachError={conversation.attachError}
          onAddAttachment={conversation.addAttachment}
          onRemoveAttachment={conversation.removeAttachment}
        />
```

In `src/renderer/src/routes/AI.tsx`:

```tsx
    <ChatPanel
      messages={conversation.messages}
      statusLabel={conversation.statusLabel}
      pendingConfirm={conversation.pendingConfirm}
      sending={conversation.sending}
      apiKeyConfigured={conversation.apiKeyConfigured}
      input={input}
      onInputChange={setInput}
      onSubmit={handleSubmit}
      onRespondToConfirm={conversation.respondToConfirm}
      attachments={conversation.attachments}
      attachError={conversation.attachError}
      onAddAttachment={conversation.addAttachment}
      onRemoveAttachment={conversation.removeAttachment}
    />
```

Both files already destructure nothing extra from `conversation` beyond what's used inline, so no other change is needed in either file.

Find these call sites' own test files with `grep -rl "AIDock\|routes/AI" src/renderer/src --include='*.test.tsx'` (likely `AIDock.test.tsx` and `AI.test.tsx`). Each already mocks a `window.smartlife.ai` object (per Phase 8's Task 9/13 mock-extension pattern) — add `pickAttachment: vi.fn()` to that mock object in each file, matching whatever default-resolution convention the rest of that file's `ai` mock already follows (e.g. `pickAttachment: vi.fn().mockResolvedValue(null)` if the file sets defaults in a `beforeEach`), so mounting the component doesn't crash on a missing method and no test needs to actually exercise attaching a file at this call-site level (that behavior is already fully covered by Task 8's `useConversation.test.ts` and `ChatPanel.test.tsx` tests above).

- [ ] **Step 11: Full test run and commit**

Run: `npm test`
Expected: all pass.

```bash
git add src/preload/index.ts src/renderer/src/ai/useConversation.ts src/renderer/src/ai/useConversation.test.ts src/renderer/src/ai/ChatPanel.tsx
git commit -m "Add the attach-file UI: preload bridge, composer chips, attach button"
```

- [ ] **Step 12: Manual verification in the packaged app**

Run: `npm run package`, launch the built app, and manually verify:
1. Attach a `.txt` file, send a message referencing it — the AI's answer should reflect the file's content, and the chat history bubble should show only the placeholder, not the full text.
2. Attach a `.png` image (with a vision-capable model active) — same check.
3. With an Ollama-only, non-vision-model ranking active, attempt to attach an image — confirm the picker returns the "can't see images" error and no file is read.
4. Ask a question that plausibly needs a screenshot (e.g. open a page with an embedded iframe-based document viewer) and confirm the AI can use `browser_screenshot` and describe what it captured.
5. Ask something requiring current information (e.g. "what's today's top tech news") on an Anthropic or Gemini model with web search enabled, and confirm it comes back with a real, current answer rather than a knowledge-cutoff caveat.

---

## After all tasks: whole-branch review

Once all 8 tasks are complete and reviewed individually, dispatch the final whole-branch code review on the most capable available model, per superpowers:subagent-driven-development's process — this phase touches three provider adapters, the browser host, IPC, and the renderer, so cross-task integration (does a screenshot actually reach the model end-to-end on all three providers; does an Ollama-only ranking with a non-vision model correctly disable image attachment through the whole stack) is exactly the kind of thing no single task's review can see. Fix any findings, re-review, run `npm run package`, and write the ROADMAP.md completion entry matching the depth of every prior phase's entry — including Task 7's cost-rank-style call-out for this phase's own trickiest decision (the screenshot round-trip mechanism differing per provider) and any test-coverage gaps the reviewer surfaces, the same pattern Phase 8 followed throughout.
