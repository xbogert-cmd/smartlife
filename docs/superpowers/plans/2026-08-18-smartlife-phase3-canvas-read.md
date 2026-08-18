# SmartLife Phase 3: Canvas (read-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `school` nav section from a `ComingSoon` placeholder into a local mirror of the user's Canvas courses — what is due, current grades, and course materials — served from SQLite so it is instant and works offline.

**Architecture:** A tiered mirror. A serial-queue sync engine in the main process pulls tier-1 data (courses + grades + assignments + announcements) on a schedule and tier-2 data (modules, files, pages) on first course open, upserting into eight new SQLite tables. The renderer only ever reads local data over IPC; it never touches Canvas. Three READ-tier AI tools query the same local tables.

**Tech Stack:** Electron 33, better-sqlite3, React 19, react-router-dom 6, vitest, Node's built-in global `fetch`.

## Global Constraints

- **No new runtime dependencies.** Only `@anthropic-ai/sdk` and `better-sqlite3` are runtime deps. Use Node's built-in global `fetch` — do NOT add `axios`, `node-fetch`, `dompurify`, or any HTTP/sanitizer library.
- **Read-only.** Nothing in this phase writes to Canvas. No submissions, no comments, no edits. That is Phase 3b, after Phase 5.
- **Every Canvas list request must set `per_page=100`.** Canvas defaults to **10 items per page**; omitting this silently truncates data.
- **Pagination is via the `Link` header with `rel="next"`.** `next` URLs are opaque absolute URLs — follow them as-is, never reconstruct them.
- **The sync engine is a serial queue. Never `Promise.all` over Canvas requests.** Instructure explicitly advises no more than one simultaneous request; parallel requests incur a pre-flight quota penalty. Throttling returns **429**.
- **Never persist Canvas file download URLs.** They expire. Re-fetch `GET /api/v1/files/:id` at click time.
- **Token expiry is routine, not exceptional.** UNCW caps personal access tokens at 90 days. A 401 must flag the token, show a banner, and **keep displaying cached data** — never blank the screen or crash.
- Electron security posture is fixed: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. All renderer access goes through the `window.smartlife` `contextBridge` surface.
- Styling convention: `var(--color-*)` inline styles for all color; Tailwind classes for layout only.
- Test convention: vitest, jsdom environment. **No test may make a live network call.** Main-process tests use `new Database(':memory:')` with schema SQL inlined in the test file (vitest does not process `?raw` imports the way `electron-vite` does).
- Full check chain: `npm run lint && npm run typecheck && npm run test && npm run build`.

## File Structure

**Main process — new (`src/main/canvas/`):**

| File | Responsibility |
|---|---|
| `token.ts` | safeStorage-encrypted token, plaintext base URL, `token_saved_at`, age calculation |
| `errors.ts` | `CanvasAuthError`, `CanvasRateLimitError`, `CanvasNetworkError` |
| `client.ts` | The only module that touches the network. Auth header, `per_page=100`, serial `Link` pagination, HTTP→typed-error mapping |
| `api.ts` | Typed endpoint wrappers. No logic — URL and query-param construction only |
| `sync.ts` | Serial sync queue. `syncCore()` (tier 1), `syncCourseContent()` (tier 2) |
| `queries.ts` | All local reads. Shared by IPC handlers and AI tools |
| `files.ts` | Fresh-URL fetch, download to cache dir, `shell.openPath` |
| `scheduler.ts` | Launch / focus-throttled / interval triggers, with an overlap guard |
| `ipc.ts` | Renderer handlers |

**Main process — modified:** `db/index.ts` (register migration), `db/migrations/0003_canvas.sql` (new), `csp.ts` (allow Canvas images), `index.ts` (wire IPC + scheduler), `ai/tools/registry.ts` (append 3 tools), plus `ai/tools/canvasUpcoming.ts`, `ai/tools/canvasGrades.ts`, `ai/tools/canvasSearchMaterials.ts` (new).

**Preload — modified:** `src/preload/index.ts` (add `canvas` surface).

**Renderer — new (`src/renderer/src/school/`):** `useCanvas.ts` (hook), `sanitizeHtml.ts`, `SyncStatus.tsx`, `TokenBanner.tsx`, `DueSoon.tsx`, `GradeStrip.tsx`. **New routes:** `routes/School.tsx`, `routes/Course.tsx`. **Modified:** `routes/Settings.tsx`, `App.tsx`, `App.test.tsx`, `theme/ThemeProvider.test.tsx`.

---

### Task 1: Migration and Canvas token storage

**Files:**
- Create: `src/main/db/migrations/0003_canvas.sql`
- Modify: `src/main/db/index.ts`
- Create: `src/main/canvas/token.ts`
- Test: `src/main/canvas/token.test.ts`

**Interfaces:**
- Consumes: the existing `settings` table from `0001_init.sql`; `runMigrations(db, migrations)` from `src/main/db/migrate`.
- Produces, for every later task:
  - `hasCanvasToken(db: Database.Database): boolean`
  - `getCanvasToken(db: Database.Database): string | null`
  - `setCanvasToken(db: Database.Database, token: string, now?: Date): void`
  - `clearCanvasToken(db: Database.Database): void`
  - `getCanvasBaseUrl(db: Database.Database): string | null`
  - `setCanvasBaseUrl(db: Database.Database, rawUrl: string): void`
  - `normalizeBaseUrl(rawUrl: string): string`
  - `getTokenAgeDays(db: Database.Database, now?: Date): number | null`
  - `TOKEN_WARN_AFTER_DAYS: 83`
  - The eight tables listed in Step 1.

- [ ] **Step 1: Write the migration**

Create `src/main/db/migrations/0003_canvas.sql`:

```sql
create table canvas_courses (
  id integer primary key,
  name text not null,
  course_code text,
  term_name text,
  current_score real,
  current_grade text,
  synced_at text not null default (datetime('now'))
);

create table canvas_assignments (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  name text not null,
  description text,
  due_at text,
  points_possible real,
  html_url text,
  submission_types text,
  has_submitted integer not null default 0,
  submitted_at text,
  score real,
  grade text,
  workflow_state text,
  synced_at text not null default (datetime('now'))
);

create index canvas_assignments_course_idx on canvas_assignments(course_id);
create index canvas_assignments_due_idx on canvas_assignments(due_at);

create table canvas_announcements (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  title text,
  message text,
  posted_at text,
  html_url text,
  synced_at text not null default (datetime('now'))
);

create index canvas_announcements_posted_idx on canvas_announcements(posted_at);

create table canvas_modules (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  name text,
  position integer,
  synced_at text not null default (datetime('now'))
);

create index canvas_modules_course_idx on canvas_modules(course_id, position);

create table canvas_module_items (
  id integer primary key,
  module_id integer not null references canvas_modules(id) on delete cascade,
  course_id integer not null,
  title text,
  type text,
  content_id integer,
  page_url text,
  html_url text,
  external_url text,
  position integer
);

create index canvas_module_items_module_idx on canvas_module_items(module_id, position);

create table canvas_files (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  display_name text,
  filename text,
  content_type text,
  size integer,
  updated_at text,
  synced_at text not null default (datetime('now'))
);

create index canvas_files_course_idx on canvas_files(course_id);

create table canvas_pages (
  course_id integer not null references canvas_courses(id) on delete cascade,
  url text not null,
  title text,
  body text,
  updated_at text,
  synced_at text not null default (datetime('now')),
  primary key (course_id, url)
);

create table canvas_sync_state (
  key text primary key,
  value text not null
);
```

Note: `canvas_module_items.course_id` is intentionally denormalized (no FK) so material search can filter by course without a join through `canvas_modules`.

- [ ] **Step 2: Register the migration**

In `src/main/db/index.ts`, add the import alongside the existing two and add the entry to the `runMigrations` array. The complete file after editing:

```ts
import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate';
import migration0001 from './migrations/0001_init.sql?raw';
import migration0002 from './migrations/0002_ai_core.sql?raw';
import migration0003 from './migrations/0003_canvas.sql?raw';

export function openDb(): Database.Database {
  const dbPath = join(app.getPath('userData'), 'smartlife.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db, [
    { filename: '0001_init.sql', sql: migration0001 },
    { filename: '0002_ai_core.sql', sql: migration0002 },
    { filename: '0003_canvas.sql', sql: migration0003 },
  ]);
  return db;
}
```

- [ ] **Step 3: Write the failing test**

Create `src/main/canvas/token.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null)');
  return db;
}

describe('normalizeBaseUrl', () => {
  it('adds https and strips a trailing slash', async () => {
    const { normalizeBaseUrl } = await import('./token');
    expect(normalizeBaseUrl('uncw.instructure.com')).toBe('https://uncw.instructure.com');
    expect(normalizeBaseUrl('https://uncw.instructure.com/')).toBe('https://uncw.instructure.com');
    expect(normalizeBaseUrl('  https://uncw.instructure.com  ')).toBe('https://uncw.instructure.com');
  });

  it('strips a pasted path so only the origin survives', async () => {
    const { normalizeBaseUrl } = await import('./token');
    expect(normalizeBaseUrl('https://uncw.instructure.com/profile/settings')).toBe(
      'https://uncw.instructure.com'
    );
  });

  it('rejects a blank host', async () => {
    const { normalizeBaseUrl } = await import('./token');
    expect(() => normalizeBaseUrl('   ')).toThrow('Canvas URL is required');
  });
});

describe('Canvas token storage', () => {
  it('reports no token stored by default', async () => {
    const { hasCanvasToken, getCanvasToken, getCanvasBaseUrl } = await import('./token');
    const db = makeDb();
    expect(hasCanvasToken(db)).toBe(false);
    expect(getCanvasToken(db)).toBeNull();
    expect(getCanvasBaseUrl(db)).toBeNull();
  });

  it('round-trips a token through encryption', async () => {
    const { setCanvasToken, getCanvasToken, hasCanvasToken } = await import('./token');
    const db = makeDb();
    setCanvasToken(db, 'canvas-test-token');
    expect(hasCanvasToken(db)).toBe(true);
    expect(getCanvasToken(db)).toBe('canvas-test-token');
  });

  it('stores the base URL normalized', async () => {
    const { setCanvasBaseUrl, getCanvasBaseUrl } = await import('./token');
    const db = makeDb();
    setCanvasBaseUrl(db, 'uncw.instructure.com/');
    expect(getCanvasBaseUrl(db)).toBe('https://uncw.instructure.com');
  });

  it('clears the token and its saved-at stamp but keeps the base URL', async () => {
    const { setCanvasToken, setCanvasBaseUrl, clearCanvasToken, hasCanvasToken, getCanvasBaseUrl, getTokenAgeDays } =
      await import('./token');
    const db = makeDb();
    setCanvasBaseUrl(db, 'uncw.instructure.com');
    setCanvasToken(db, 'canvas-test-token');
    clearCanvasToken(db);
    expect(hasCanvasToken(db)).toBe(false);
    expect(getTokenAgeDays(db)).toBeNull();
    expect(getCanvasBaseUrl(db)).toBe('https://uncw.instructure.com');
  });

  it('computes token age in whole days from the saved-at stamp', async () => {
    const { setCanvasToken, getTokenAgeDays } = await import('./token');
    const db = makeDb();
    setCanvasToken(db, 'canvas-test-token', new Date('2026-08-18T00:00:00Z'));
    expect(getTokenAgeDays(db, new Date('2026-08-18T00:00:00Z'))).toBe(0);
    expect(getTokenAgeDays(db, new Date('2026-09-10T00:00:00Z'))).toBe(23);
  });

  it('returns null age when no token is stored', async () => {
    const { getTokenAgeDays } = await import('./token');
    expect(getTokenAgeDays(makeDb())).toBeNull();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm run test -- src/main/canvas/token.test.ts`
Expected: FAIL with `Failed to resolve import "./token"`.

- [ ] **Step 5: Implement `token.ts`**

Create `src/main/canvas/token.ts`:

```ts
import { safeStorage } from 'electron';
import type Database from 'better-sqlite3';

const TOKEN_KEY = 'canvas_token_encrypted';
const BASE_URL_KEY = 'canvas_base_url';
const SAVED_AT_KEY = 'canvas_token_saved_at';

/** UNCW caps personal access tokens at 90 days; warn a week ahead. */
export const TOKEN_WARN_AFTER_DAYS = 83;

const MS_PER_DAY = 86_400_000;

function readSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('select value from settings where key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

function writeSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    'insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
  ).run(key, value);
}

export function normalizeBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) throw new Error('Canvas URL is required.');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error('Canvas URL is not a valid address.');
  }
  if (!parsed.hostname) throw new Error('Canvas URL is required.');
  return parsed.origin;
}

export function hasCanvasToken(db: Database.Database): boolean {
  return readSetting(db, TOKEN_KEY) !== null;
}

export function getCanvasToken(db: Database.Database): string | null {
  const stored = readSetting(db, TOKEN_KEY);
  if (stored === null || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    return null;
  }
}

export function setCanvasToken(db: Database.Database, token: string, now: Date = new Date()): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system.');
  }
  const encrypted = safeStorage.encryptString(token).toString('base64');
  writeSetting(db, TOKEN_KEY, encrypted);
  writeSetting(db, SAVED_AT_KEY, now.toISOString());
}

export function clearCanvasToken(db: Database.Database): void {
  db.prepare('delete from settings where key in (?, ?)').run(TOKEN_KEY, SAVED_AT_KEY);
}

export function getCanvasBaseUrl(db: Database.Database): string | null {
  return readSetting(db, BASE_URL_KEY);
}

export function setCanvasBaseUrl(db: Database.Database, rawUrl: string): void {
  writeSetting(db, BASE_URL_KEY, normalizeBaseUrl(rawUrl));
}

export function getTokenAgeDays(db: Database.Database, now: Date = new Date()): number | null {
  const savedAt = readSetting(db, SAVED_AT_KEY);
  if (savedAt === null) return null;
  const saved = Date.parse(savedAt);
  if (Number.isNaN(saved)) return null;
  return Math.floor((now.getTime() - saved) / MS_PER_DAY);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test -- src/main/canvas/token.test.ts`
Expected: PASS, 9/9 tests.

- [ ] **Step 7: Run the full check chain**

Run: `npm run lint && npm run typecheck && npm run test && npm run build`
Expected: all four exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/main/db/migrations/0003_canvas.sql src/main/db/index.ts src/main/canvas/token.ts src/main/canvas/token.test.ts
git commit -m "Task 1: Canvas migration and token storage"
```

---

### Task 2: Canvas HTTP layer — typed errors, pagination, endpoint wrappers

**Files:**
- Create: `src/main/canvas/errors.ts`
- Create: `src/main/canvas/client.ts`
- Create: `src/main/canvas/api.ts`
- Test: `src/main/canvas/client.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 directly (credentials are passed in as a plain object).
- Produces:
  - `class CanvasAuthError extends Error`, `class CanvasRateLimitError extends Error`, `class CanvasNetworkError extends Error`
  - `interface CanvasCredentials { baseUrl: string; token: string }`
  - `type QueryParams = Record<string, string | number | string[]>`
  - `parseNextLink(linkHeader: string | null): string | null`
  - `canvasFetchAll<T>(creds: CanvasCredentials, path: string, params?: QueryParams): Promise<T[]>`
  - `canvasFetchOne<T>(creds: CanvasCredentials, path: string, params?: QueryParams): Promise<T>`
  - From `api.ts`: `getSelf`, `listCourses`, `listAssignments`, `listAnnouncements`, `listModules`, `listModuleItems`, `listFiles`, `getPage`, `getFile`, and the row interfaces `CanvasCourse`, `CanvasAssignment`, `CanvasAnnouncement`, `CanvasModule`, `CanvasModuleItem`, `CanvasFile`, `CanvasPage`, `CanvasUser`.

**Critical constraints for this task (do not re-derive — these are verified against Instructure's docs):**
- Canvas paginates with a `Link` header containing `rel="next"`, and **defaults to 10 items per page**. `canvasFetchAll` must send `per_page=100` and follow `next` links **serially**.
- `next` URLs are opaque absolute URLs. Follow them verbatim; do not rebuild them from parts.
- Rate limiting returns **429**. Canvas has also historically used **403 with a "Rate Limit Exceeded" body**, so both must map to `CanvasRateLimitError`.
- **401 must map to `CanvasAuthError`** — this is the routine token-expiry path, and callers branch on it.

- [ ] **Step 1: Write the failing test**

Create `src/main/canvas/client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canvasFetchAll, canvasFetchOne, parseNextLink } from './client';
import { CanvasAuthError, CanvasNetworkError, CanvasRateLimitError } from './errors';

const CREDS = { baseUrl: 'https://uncw.instructure.com', token: 'test-token' };

function jsonResponse(body: unknown, init: { status?: number; link?: string } = {}): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.link) headers.set('link', init.link);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseNextLink', () => {
  it('returns null when there is no header', () => {
    expect(parseNextLink(null)).toBeNull();
  });

  it('extracts the next URL from a multi-rel header', () => {
    const header =
      '<https://x/api/v1/courses?page=1>; rel="current",' +
      '<https://x/api/v1/courses?page=2>; rel="next",' +
      '<https://x/api/v1/courses?page=9>; rel="last"';
    expect(parseNextLink(header)).toBe('https://x/api/v1/courses?page=2');
  });

  it('returns null when only prev and current are present', () => {
    const header = '<https://x/a?page=1>; rel="current",<https://x/a?page=0>; rel="prev"';
    expect(parseNextLink(header)).toBeNull();
  });
});

describe('canvasFetchAll', () => {
  it('sends the bearer token and forces per_page=100', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ id: 1 }]));
    vi.stubGlobal('fetch', fetchMock);

    await canvasFetchAll(CREDS, '/api/v1/courses');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('https://uncw.instructure.com/api/v1/courses');
    expect(url).toContain('per_page=100');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });

  it('expands array params into repeated keys', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await canvasFetchAll(CREDS, '/api/v1/courses', { 'include[]': ['total_scores', 'term'] });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('include%5B%5D=total_scores');
    expect(url).toContain('include%5B%5D=term');
  });

  it('follows Link rel=next across pages and concatenates results', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ id: 1 }], { link: '<https://uncw.instructure.com/p2>; rel="next"' })
      )
      .mockResolvedValueOnce(
        jsonResponse([{ id: 2 }], { link: '<https://uncw.instructure.com/p3>; rel="next"' })
      )
      .mockResolvedValueOnce(jsonResponse([{ id: 3 }]));
    vi.stubGlobal('fetch', fetchMock);

    const rows = await canvasFetchAll<{ id: number }>(CREDS, '/api/v1/courses');

    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe('https://uncw.instructure.com/p2');
  });

  it('requests pages one at a time rather than in parallel', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return url.includes('p2')
        ? jsonResponse([{ id: 2 }])
        : jsonResponse([{ id: 1 }], { link: '<https://uncw.instructure.com/p2>; rel="next"' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await canvasFetchAll(CREDS, '/api/v1/courses');

    expect(maxInFlight).toBe(1);
  });

  it('stops after the page cap even if Canvas keeps advertising next', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ id: 1 }], { link: '<https://uncw.instructure.com/p>; rel="next"' }));
    vi.stubGlobal('fetch', fetchMock);

    await canvasFetchAll(CREDS, '/api/v1/courses');

    expect(fetchMock).toHaveBeenCalledTimes(50);
  });

  it('maps 401 to CanvasAuthError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ errors: [] }, { status: 401 })));
    await expect(canvasFetchAll(CREDS, '/api/v1/courses')).rejects.toBeInstanceOf(CanvasAuthError);
  });

  it('maps 429 to CanvasRateLimitError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { status: 429 })));
    await expect(canvasFetchAll(CREDS, '/api/v1/courses')).rejects.toBeInstanceOf(CanvasRateLimitError);
  });

  it('maps a 403 rate-limit body to CanvasRateLimitError, not an auth error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('403 Forbidden (Rate Limit Exceeded)', { status: 403 }))
    );
    await expect(canvasFetchAll(CREDS, '/api/v1/courses')).rejects.toBeInstanceOf(CanvasRateLimitError);
  });

  it('maps a plain 403 to CanvasNetworkError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 403 })));
    await expect(canvasFetchAll(CREDS, '/api/v1/courses')).rejects.toBeInstanceOf(CanvasNetworkError);
  });

  it('maps a thrown fetch (offline) to CanvasNetworkError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(canvasFetchAll(CREDS, '/api/v1/courses')).rejects.toBeInstanceOf(CanvasNetworkError);
  });
});

describe('canvasFetchOne', () => {
  it('returns the single object without pagination', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 7, name: 'Ada' }));
    vi.stubGlobal('fetch', fetchMock);

    const user = await canvasFetchOne<{ id: number; name: string }>(CREDS, '/api/v1/users/self');

    expect(user.name).toBe('Ada');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps 401 to CanvasAuthError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { status: 401 })));
    await expect(canvasFetchOne(CREDS, '/api/v1/users/self')).rejects.toBeInstanceOf(CanvasAuthError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/main/canvas/client.test.ts`
Expected: FAIL with `Failed to resolve import "./client"`.

- [ ] **Step 3: Implement `errors.ts`**

Create `src/main/canvas/errors.ts`:

```ts
/** The token is missing, revoked, or expired. Routine — UNCW caps tokens at 90 days. */
export class CanvasAuthError extends Error {
  constructor(message = 'Canvas rejected the access token.') {
    super(message);
    this.name = 'CanvasAuthError';
  }
}

/** Canvas throttled the request. Back off; do not retry immediately. */
export class CanvasRateLimitError extends Error {
  constructor(message = 'Canvas is rate limiting requests.') {
    super(message);
    this.name = 'CanvasRateLimitError';
  }
}

/** Offline, DNS failure, 5xx, or any other unexpected HTTP status. */
export class CanvasNetworkError extends Error {
  constructor(message = 'Could not reach Canvas.') {
    super(message);
    this.name = 'CanvasNetworkError';
  }
}
```

- [ ] **Step 4: Implement `client.ts`**

Create `src/main/canvas/client.ts`:

```ts
import { CanvasAuthError, CanvasNetworkError, CanvasRateLimitError } from './errors';

export interface CanvasCredentials {
  baseUrl: string;
  token: string;
}

export type QueryParams = Record<string, string | number | string[]>;

/**
 * Safety cap on pagination. Canvas pages at 100/request here, so 50 pages is
 * 5000 rows — far beyond any real course list, but bounded if a malformed
 * Link header ever points at itself.
 * ponytail: fixed cap; make it a parameter only if a real dataset exceeds it.
 */
const MAX_PAGES = 50;

export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
    if (match) return match[1];
  }
  return null;
}

function buildUrl(baseUrl: string, path: string, params: QueryParams): string {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.append(key, String(value));
    }
  }
  return url.toString();
}

async function requestPage(url: string, token: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  } catch (error) {
    throw new CanvasNetworkError(error instanceof Error ? error.message : 'Could not reach Canvas.');
  }

  if (response.ok) return response;

  if (response.status === 401) {
    throw new CanvasAuthError();
  }
  if (response.status === 429) {
    throw new CanvasRateLimitError();
  }
  // Canvas has historically signalled throttling as a 403 with this body.
  if (response.status === 403) {
    const body = await response.text().catch(() => '');
    if (/rate limit/i.test(body)) throw new CanvasRateLimitError();
    throw new CanvasNetworkError(`Canvas returned 403: ${body.slice(0, 200)}`);
  }
  throw new CanvasNetworkError(`Canvas returned ${response.status}.`);
}

/**
 * Fetch every page of a list endpoint, following Link rel="next" SERIALLY.
 * Instructure explicitly advises against concurrent requests, so this must
 * never be converted to a parallel fan-out.
 */
export async function canvasFetchAll<T>(
  creds: CanvasCredentials,
  path: string,
  params: QueryParams = {}
): Promise<T[]> {
  let url: string | null = buildUrl(creds.baseUrl, path, { per_page: 100, ...params });
  const results: T[] = [];

  for (let page = 0; page < MAX_PAGES && url !== null; page += 1) {
    const response = await requestPage(url, creds.token);
    const batch = (await response.json()) as T[];
    if (Array.isArray(batch)) results.push(...batch);
    url = parseNextLink(response.headers.get('link'));
  }

  return results;
}

export async function canvasFetchOne<T>(
  creds: CanvasCredentials,
  path: string,
  params: QueryParams = {}
): Promise<T> {
  const response = await requestPage(buildUrl(creds.baseUrl, path, params), creds.token);
  return (await response.json()) as T;
}
```

- [ ] **Step 5: Implement `api.ts`**

Create `src/main/canvas/api.ts`. Every list call goes through `canvasFetchAll`, which supplies `per_page=100`:

```ts
import { canvasFetchAll, canvasFetchOne, type CanvasCredentials } from './client';

export interface CanvasUser {
  id: number;
  name: string;
}

export interface CanvasEnrollment {
  type?: string;
  computed_current_score?: number | null;
  computed_current_grade?: string | null;
}

export interface CanvasCourse {
  id: number;
  name: string;
  course_code?: string;
  term?: { name?: string };
  enrollments?: CanvasEnrollment[];
}

export interface CanvasSubmission {
  submitted_at?: string | null;
  score?: number | null;
  grade?: string | null;
  workflow_state?: string;
}

export interface CanvasAssignment {
  id: number;
  name: string;
  description?: string | null;
  due_at?: string | null;
  points_possible?: number | null;
  html_url?: string;
  submission_types?: string[];
  submission?: CanvasSubmission | null;
}

export interface CanvasAnnouncement {
  id: number;
  title?: string;
  message?: string;
  posted_at?: string | null;
  html_url?: string;
  context_code?: string;
}

export interface CanvasModuleItem {
  id: number;
  title?: string;
  type?: string;
  content_id?: number | null;
  page_url?: string | null;
  html_url?: string | null;
  external_url?: string | null;
  position?: number;
}

export interface CanvasModule {
  id: number;
  name?: string;
  position?: number;
  items?: CanvasModuleItem[];
}

export interface CanvasFile {
  id: number;
  display_name?: string;
  filename?: string;
  'content-type'?: string;
  size?: number;
  updated_at?: string;
  url?: string;
}

export interface CanvasPage {
  url: string;
  title?: string;
  body?: string | null;
  updated_at?: string;
}

export function getSelf(creds: CanvasCredentials): Promise<CanvasUser> {
  return canvasFetchOne<CanvasUser>(creds, '/api/v1/users/self');
}

/**
 * One request returns every active course AND its current grade —
 * `include[]=total_scores` puts computed_current_score on the enrollment,
 * so the grade dashboard costs no extra calls.
 */
export function listCourses(creds: CanvasCredentials): Promise<CanvasCourse[]> {
  return canvasFetchAll<CanvasCourse>(creds, '/api/v1/courses', {
    'include[]': ['total_scores', 'term'],
    enrollment_state: 'active',
    'state[]': ['available'],
  });
}

export function listAssignments(creds: CanvasCredentials, courseId: number): Promise<CanvasAssignment[]> {
  return canvasFetchAll<CanvasAssignment>(creds, `/api/v1/courses/${courseId}/assignments`, {
    'include[]': ['submission'],
  });
}

/** One call covers every course, via repeated context_codes[] params. */
export function listAnnouncements(
  creds: CanvasCredentials,
  courseIds: number[]
): Promise<CanvasAnnouncement[]> {
  if (courseIds.length === 0) return Promise.resolve([]);
  return canvasFetchAll<CanvasAnnouncement>(creds, '/api/v1/announcements', {
    'context_codes[]': courseIds.map((id) => `course_${id}`),
  });
}

/** `include[]=items` inlines module items, avoiding a request per module. */
export function listModules(creds: CanvasCredentials, courseId: number): Promise<CanvasModule[]> {
  return canvasFetchAll<CanvasModule>(creds, `/api/v1/courses/${courseId}/modules`, {
    'include[]': ['items'],
  });
}

/** Fallback for modules whose item list Canvas omitted (very large modules). */
export function listModuleItems(
  creds: CanvasCredentials,
  courseId: number,
  moduleId: number
): Promise<CanvasModuleItem[]> {
  return canvasFetchAll<CanvasModuleItem>(
    creds,
    `/api/v1/courses/${courseId}/modules/${moduleId}/items`
  );
}

export function listFiles(creds: CanvasCredentials, courseId: number): Promise<CanvasFile[]> {
  return canvasFetchAll<CanvasFile>(creds, `/api/v1/courses/${courseId}/files`);
}

export function getPage(
  creds: CanvasCredentials,
  courseId: number,
  pageUrl: string
): Promise<CanvasPage> {
  return canvasFetchOne<CanvasPage>(
    creds,
    `/api/v1/courses/${courseId}/pages/${encodeURIComponent(pageUrl)}`
  );
}

/** Canvas file URLs expire, so this is called at click time — never cached. */
export function getFile(creds: CanvasCredentials, fileId: number): Promise<CanvasFile> {
  return canvasFetchOne<CanvasFile>(creds, `/api/v1/files/${fileId}`);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test -- src/main/canvas/client.test.ts`
Expected: PASS, 16/16 tests.

- [ ] **Step 7: Run the full check chain**

Run: `npm run lint && npm run typecheck && npm run test && npm run build`
Expected: all four exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/main/canvas/errors.ts src/main/canvas/client.ts src/main/canvas/api.ts src/main/canvas/client.test.ts
git commit -m "Task 2: Canvas HTTP client with serial pagination and typed errors"
```

---

### Task 3: Tier-1 sync engine and local read queries

**Files:**
- Create: `src/main/canvas/sync.ts`
- Create: `src/main/canvas/queries.ts`
- Test: `src/main/canvas/sync.test.ts`
- Test: `src/main/canvas/queries.test.ts`

**Interfaces:**
- Consumes: `CanvasCredentials` from `./client`; every function and interface from `./api`; `CanvasAuthError` from `./errors`; `hasCanvasToken`, `getCanvasBaseUrl`, `getTokenAgeDays`, `TOKEN_WARN_AFTER_DAYS` from `./token`; the tables from Task 1.
- Produces:
  - `getSyncState(db, key): string | null`, `setSyncState(db, key, value): void`
  - `SYNC_KEY_LAST_CORE = 'last_core_sync'`, `SYNC_KEY_TOKEN_INVALID = 'token_invalid'`, `courseContentKey(courseId): string`
  - `interface SyncResult { ok: boolean; coursesSynced: number; tokenInvalid: boolean; errors: string[] }`
  - `syncCore(db, creds, now?): Promise<SyncResult>`
  - From `queries.ts`: `getUpcomingAssignments(db, days, now?)`, `getCourseGrades(db)`, `getRecentAnnouncements(db, limit)`, `getSyncStatus(db, now?)`, and the interfaces `UpcomingAssignment`, `CourseGrade`, `AnnouncementRow`, `CanvasSyncStatus`.

**Constraints specific to this task:**
- **Courses are synced one at a time in a `for…of` loop with `await` inside.** Do not use `Promise.all`, `map(async …)`, or any parallel construct over Canvas calls.
- A `CanvasAuthError` anywhere aborts the run, sets the token-invalid flag, and returns — it never throws out of `syncCore`.
- A single course failing its assignment fetch is recorded and **skipped**; the remaining courses still sync.
- Rows for courses that disappeared from Canvas are deleted so the mirror stays true; the FK cascade removes their children.

- [ ] **Step 1: Write the failing sync test**

Create `src/main/canvas/sync.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('./api', () => ({
  listCourses: vi.fn(),
  listAssignments: vi.fn(),
  listAnnouncements: vi.fn(),
  listModules: vi.fn(),
  listModuleItems: vi.fn(),
  listFiles: vi.fn(),
  getPage: vi.fn(),
  getFile: vi.fn(),
  getSelf: vi.fn(),
}));

import * as api from './api';
import { CanvasAuthError, CanvasNetworkError } from './errors';
import { syncCore, getSyncState, SYNC_KEY_TOKEN_INVALID, SYNC_KEY_LAST_CORE } from './sync';

const CREDS = { baseUrl: 'https://uncw.instructure.com', token: 'test-token' };

const SCHEMA = `
create table canvas_courses (
  id integer primary key, name text not null, course_code text, term_name text,
  current_score real, current_grade text, synced_at text not null default (datetime('now'))
);
create table canvas_assignments (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  name text not null, description text, due_at text, points_possible real, html_url text,
  submission_types text, has_submitted integer not null default 0, submitted_at text,
  score real, grade text, workflow_state text,
  synced_at text not null default (datetime('now'))
);
create table canvas_announcements (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  title text, message text, posted_at text, html_url text,
  synced_at text not null default (datetime('now'))
);
create table canvas_sync_state (key text primary key, value text not null);
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

beforeEach(() => {
  vi.mocked(api.listCourses).mockReset();
  vi.mocked(api.listAssignments).mockReset();
  vi.mocked(api.listAnnouncements).mockReset();
  vi.mocked(api.listAnnouncements).mockResolvedValue([]);
});

describe('syncCore', () => {
  it('stores courses with the grade taken from the student enrollment', async () => {
    vi.mocked(api.listCourses).mockResolvedValue([
      {
        id: 101,
        name: 'Statistics',
        course_code: 'STT 215',
        term: { name: 'Fall 2026' },
        enrollments: [{ type: 'student', computed_current_score: 91.5, computed_current_grade: 'A-' }],
      },
    ]);
    vi.mocked(api.listAssignments).mockResolvedValue([]);
    const db = makeDb();

    const result = await syncCore(db, CREDS);

    expect(result.ok).toBe(true);
    expect(result.coursesSynced).toBe(1);
    const row = db.prepare('select * from canvas_courses where id = 101').get() as Record<string, unknown>;
    expect(row.name).toBe('Statistics');
    expect(row.term_name).toBe('Fall 2026');
    expect(row.current_score).toBe(91.5);
    expect(row.current_grade).toBe('A-');
  });

  it('flattens the submission into assignment columns', async () => {
    vi.mocked(api.listCourses).mockResolvedValue([{ id: 101, name: 'Statistics' }]);
    vi.mocked(api.listAssignments).mockResolvedValue([
      {
        id: 555,
        name: 'Problem Set 3',
        due_at: '2026-09-01T03:59:59Z',
        points_possible: 20,
        submission_types: ['online_upload'],
        submission: { submitted_at: '2026-08-30T12:00:00Z', score: 18, grade: '18', workflow_state: 'graded' },
      },
    ]);
    const db = makeDb();

    await syncCore(db, CREDS);

    const row = db.prepare('select * from canvas_assignments where id = 555').get() as Record<string, unknown>;
    expect(row.course_id).toBe(101);
    expect(row.has_submitted).toBe(1);
    expect(row.score).toBe(18);
    expect(row.workflow_state).toBe('graded');
    expect(JSON.parse(row.submission_types as string)).toEqual(['online_upload']);
  });

  it('marks an assignment unsubmitted when Canvas returns no submission', async () => {
    vi.mocked(api.listCourses).mockResolvedValue([{ id: 101, name: 'Statistics' }]);
    vi.mocked(api.listAssignments).mockResolvedValue([
      { id: 556, name: 'Essay', due_at: '2026-09-05T03:59:59Z', submission: null },
    ]);
    const db = makeDb();

    await syncCore(db, CREDS);

    const row = db.prepare('select has_submitted, submitted_at from canvas_assignments where id = 556').get() as {
      has_submitted: number;
      submitted_at: string | null;
    };
    expect(row.has_submitted).toBe(0);
    expect(row.submitted_at).toBeNull();
  });

  it('is idempotent — syncing twice leaves one row per record', async () => {
    vi.mocked(api.listCourses).mockResolvedValue([{ id: 101, name: 'Statistics' }]);
    vi.mocked(api.listAssignments).mockResolvedValue([{ id: 555, name: 'Problem Set 3' }]);
    const db = makeDb();

    await syncCore(db, CREDS);
    await syncCore(db, CREDS);

    const courses = db.prepare('select count(*) as c from canvas_courses').get() as { c: number };
    const assignments = db.prepare('select count(*) as c from canvas_assignments').get() as { c: number };
    expect(courses.c).toBe(1);
    expect(assignments.c).toBe(1);
  });

  it('updates a changed grade on re-sync rather than inserting a duplicate', async () => {
    vi.mocked(api.listAssignments).mockResolvedValue([]);
    const db = makeDb();

    vi.mocked(api.listCourses).mockResolvedValue([
      { id: 101, name: 'Statistics', enrollments: [{ type: 'student', computed_current_score: 80 }] },
    ]);
    await syncCore(db, CREDS);

    vi.mocked(api.listCourses).mockResolvedValue([
      { id: 101, name: 'Statistics', enrollments: [{ type: 'student', computed_current_score: 95 }] },
    ]);
    await syncCore(db, CREDS);

    const row = db.prepare('select current_score from canvas_courses where id = 101').get() as { current_score: number };
    expect(row.current_score).toBe(95);
  });

  it('deletes courses that disappeared from Canvas, cascading their assignments', async () => {
    vi.mocked(api.listAssignments).mockResolvedValue([{ id: 555, name: 'Problem Set 3' }]);
    const db = makeDb();

    vi.mocked(api.listCourses).mockResolvedValue([{ id: 101, name: 'Statistics' }]);
    await syncCore(db, CREDS);

    vi.mocked(api.listCourses).mockResolvedValue([{ id: 202, name: 'Chemistry' }]);
    await syncCore(db, CREDS);

    const courses = db.prepare('select id from canvas_courses').all() as { id: number }[];
    expect(courses.map((c) => c.id)).toEqual([202]);
    const orphans = db.prepare('select count(*) as c from canvas_assignments where course_id = 101').get() as { c: number };
    expect(orphans.c).toBe(0);
  });

  it('removes assignments deleted from a course that still exists', async () => {
    vi.mocked(api.listCourses).mockResolvedValue([{ id: 101, name: 'Statistics' }]);
    const db = makeDb();

    vi.mocked(api.listAssignments).mockResolvedValue([
      { id: 555, name: 'Problem Set 3' },
      { id: 556, name: 'Essay' },
    ]);
    await syncCore(db, CREDS);

    vi.mocked(api.listAssignments).mockResolvedValue([{ id: 555, name: 'Problem Set 3' }]);
    await syncCore(db, CREDS);

    const ids = (db.prepare('select id from canvas_assignments order by id').all() as { id: number }[]).map((r) => r.id);
    expect(ids).toEqual([555]);
  });

  it('stores announcements against the course parsed from context_code', async () => {
    vi.mocked(api.listCourses).mockResolvedValue([{ id: 101, name: 'Statistics' }]);
    vi.mocked(api.listAssignments).mockResolvedValue([]);
    vi.mocked(api.listAnnouncements).mockResolvedValue([
      { id: 900, title: 'Exam moved', message: '<p>Now Friday</p>', posted_at: '2026-08-17T10:00:00Z', context_code: 'course_101' },
    ]);
    const db = makeDb();

    await syncCore(db, CREDS);

    const row = db.prepare('select course_id, title from canvas_announcements where id = 900').get() as {
      course_id: number;
      title: string;
    };
    expect(row.course_id).toBe(101);
    expect(row.title).toBe('Exam moved');
  });

  it('drops an announcement whose context_code names an unknown course', async () => {
    vi.mocked(api.listCourses).mockResolvedValue([{ id: 101, name: 'Statistics' }]);
    vi.mocked(api.listAssignments).mockResolvedValue([]);
    vi.mocked(api.listAnnouncements).mockResolvedValue([
      { id: 901, title: 'Stale', context_code: 'course_999' },
    ]);
    const db = makeDb();

    const result = await syncCore(db, CREDS);

    expect(result.ok).toBe(true);
    const count = db.prepare('select count(*) as c from canvas_announcements').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('requests courses one at a time, never concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(api.listCourses).mockResolvedValue([
      { id: 101, name: 'Statistics' },
      { id: 202, name: 'Chemistry' },
      { id: 303, name: 'History' },
    ]);
    vi.mocked(api.listAssignments).mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return [];
    });
    const db = makeDb();

    await syncCore(db, CREDS);

    expect(maxInFlight).toBe(1);
  });

  it('records a failing course and still syncs the others', async () => {
    vi.mocked(api.listCourses).mockResolvedValue([
      { id: 101, name: 'Statistics' },
      { id: 202, name: 'Chemistry' },
    ]);
    vi.mocked(api.listAssignments).mockImplementation(async (_creds, courseId: number) => {
      if (courseId === 101) throw new CanvasNetworkError('boom');
      return [{ id: 777, name: 'Lab 1' }];
    });
    const db = makeDb();

    const result = await syncCore(db, CREDS);

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Statistics');
    const kept = db.prepare('select count(*) as c from canvas_assignments where course_id = 202').get() as { c: number };
    expect(kept.c).toBe(1);
  });

  it('sets the token-invalid flag on auth failure and does not throw', async () => {
    vi.mocked(api.listCourses).mockRejectedValue(new CanvasAuthError());
    const db = makeDb();

    const result = await syncCore(db, CREDS);

    expect(result.ok).toBe(false);
    expect(result.tokenInvalid).toBe(true);
    expect(getSyncState(db, SYNC_KEY_TOKEN_INVALID)).toBe('1');
  });

  it('clears a previously set token-invalid flag after a successful sync', async () => {
    const db = makeDb();
    vi.mocked(api.listCourses).mockRejectedValue(new CanvasAuthError());
    await syncCore(db, CREDS);
    expect(getSyncState(db, SYNC_KEY_TOKEN_INVALID)).toBe('1');

    vi.mocked(api.listCourses).mockResolvedValue([{ id: 101, name: 'Statistics' }]);
    vi.mocked(api.listAssignments).mockResolvedValue([]);
    await syncCore(db, CREDS);

    expect(getSyncState(db, SYNC_KEY_TOKEN_INVALID)).toBeNull();
  });

  it('keeps cached rows when the token goes invalid', async () => {
    const db = makeDb();
    vi.mocked(api.listCourses).mockResolvedValue([{ id: 101, name: 'Statistics' }]);
    vi.mocked(api.listAssignments).mockResolvedValue([{ id: 555, name: 'Problem Set 3' }]);
    await syncCore(db, CREDS);

    vi.mocked(api.listCourses).mockRejectedValue(new CanvasAuthError());
    await syncCore(db, CREDS);

    const count = db.prepare('select count(*) as c from canvas_assignments').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('records the sync timestamp on success', async () => {
    vi.mocked(api.listCourses).mockResolvedValue([]);
    const db = makeDb();

    await syncCore(db, CREDS, new Date('2026-08-18T12:00:00Z'));

    expect(getSyncState(db, SYNC_KEY_LAST_CORE)).toBe('2026-08-18T12:00:00.000Z');
  });

  it('does not record a sync timestamp when the run failed on auth', async () => {
    vi.mocked(api.listCourses).mockRejectedValue(new CanvasAuthError());
    const db = makeDb();

    await syncCore(db, CREDS, new Date('2026-08-18T12:00:00Z'));

    expect(getSyncState(db, SYNC_KEY_LAST_CORE)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/main/canvas/sync.test.ts`
Expected: FAIL with `Failed to resolve import "./sync"`.

- [ ] **Step 3: Implement `sync.ts`**

Create `src/main/canvas/sync.ts`:

```ts
import type Database from 'better-sqlite3';
import type { CanvasCredentials } from './client';
import { CanvasAuthError } from './errors';
import * as api from './api';
import type { CanvasAssignment, CanvasCourse } from './api';

export const SYNC_KEY_LAST_CORE = 'last_core_sync';
export const SYNC_KEY_TOKEN_INVALID = 'token_invalid';

export function courseContentKey(courseId: number): string {
  return `course:${courseId}:content_sync`;
}

export interface SyncResult {
  ok: boolean;
  coursesSynced: number;
  tokenInvalid: boolean;
  errors: string[];
}

export function getSyncState(db: Database.Database, key: string): string | null {
  const row = db.prepare('select value from canvas_sync_state where key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setSyncState(db: Database.Database, key: string, value: string): void {
  db.prepare(
    'insert into canvas_sync_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
  ).run(key, value);
}

export function clearSyncState(db: Database.Database, key: string): void {
  db.prepare('delete from canvas_sync_state where key = ?').run(key);
}

function courseGrade(course: CanvasCourse): { score: number | null; grade: string | null } {
  const enrollments = course.enrollments ?? [];
  const student = enrollments.find((e) => e.type === 'student') ?? enrollments[0];
  return {
    score: student?.computed_current_score ?? null,
    grade: student?.computed_current_grade ?? null,
  };
}

function upsertCourses(db: Database.Database, courses: CanvasCourse[], syncedAt: string): void {
  const upsert = db.prepare(
    `insert into canvas_courses (id, name, course_code, term_name, current_score, current_grade, synced_at)
     values (@id, @name, @course_code, @term_name, @current_score, @current_grade, @synced_at)
     on conflict(id) do update set
       name = excluded.name, course_code = excluded.course_code, term_name = excluded.term_name,
       current_score = excluded.current_score, current_grade = excluded.current_grade,
       synced_at = excluded.synced_at`
  );
  const run = db.transaction((rows: CanvasCourse[]) => {
    for (const course of rows) {
      const { score, grade } = courseGrade(course);
      upsert.run({
        id: course.id,
        name: course.name,
        course_code: course.course_code ?? null,
        term_name: course.term?.name ?? null,
        current_score: score,
        current_grade: grade,
        synced_at: syncedAt,
      });
    }
    // Drop courses no longer returned by Canvas; children cascade.
    const keep = rows.map((c) => c.id);
    const placeholders = keep.map(() => '?').join(',');
    if (keep.length === 0) {
      db.prepare('delete from canvas_courses').run();
    } else {
      db.prepare(`delete from canvas_courses where id not in (${placeholders})`).run(...keep);
    }
  });
  run(courses);
}

function upsertAssignments(
  db: Database.Database,
  courseId: number,
  assignments: CanvasAssignment[],
  syncedAt: string
): void {
  const upsert = db.prepare(
    `insert into canvas_assignments
       (id, course_id, name, description, due_at, points_possible, html_url, submission_types,
        has_submitted, submitted_at, score, grade, workflow_state, synced_at)
     values
       (@id, @course_id, @name, @description, @due_at, @points_possible, @html_url, @submission_types,
        @has_submitted, @submitted_at, @score, @grade, @workflow_state, @synced_at)
     on conflict(id) do update set
       name = excluded.name, description = excluded.description, due_at = excluded.due_at,
       points_possible = excluded.points_possible, html_url = excluded.html_url,
       submission_types = excluded.submission_types, has_submitted = excluded.has_submitted,
       submitted_at = excluded.submitted_at, score = excluded.score, grade = excluded.grade,
       workflow_state = excluded.workflow_state, synced_at = excluded.synced_at`
  );
  const run = db.transaction((rows: CanvasAssignment[]) => {
    for (const assignment of rows) {
      const submission = assignment.submission ?? null;
      upsert.run({
        id: assignment.id,
        course_id: courseId,
        name: assignment.name,
        description: assignment.description ?? null,
        due_at: assignment.due_at ?? null,
        points_possible: assignment.points_possible ?? null,
        html_url: assignment.html_url ?? null,
        submission_types: JSON.stringify(assignment.submission_types ?? []),
        has_submitted: submission?.submitted_at ? 1 : 0,
        submitted_at: submission?.submitted_at ?? null,
        score: submission?.score ?? null,
        grade: submission?.grade ?? null,
        workflow_state: submission?.workflow_state ?? null,
        synced_at: syncedAt,
      });
    }
    const keep = rows.map((a) => a.id);
    if (keep.length === 0) {
      db.prepare('delete from canvas_assignments where course_id = ?').run(courseId);
    } else {
      const placeholders = keep.map(() => '?').join(',');
      db.prepare(
        `delete from canvas_assignments where course_id = ? and id not in (${placeholders})`
      ).run(courseId, ...keep);
    }
  });
  run(assignments);
}

/**
 * Tier-1 sync: courses + grades, assignments per course, announcements.
 * Requests run STRICTLY SERIALLY — Instructure advises against concurrent
 * requests, and parallelising this would incur a pre-flight quota penalty.
 */
export async function syncCore(
  db: Database.Database,
  creds: CanvasCredentials,
  now: Date = new Date()
): Promise<SyncResult> {
  const syncedAt = now.toISOString();
  const errors: string[] = [];

  let courses: CanvasCourse[];
  try {
    courses = await api.listCourses(creds);
  } catch (error) {
    if (error instanceof CanvasAuthError) {
      setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');
      return { ok: false, coursesSynced: 0, tokenInvalid: true, errors: [error.message] };
    }
    return {
      ok: false,
      coursesSynced: 0,
      tokenInvalid: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  upsertCourses(db, courses, syncedAt);

  for (const course of courses) {
    try {
      const assignments = await api.listAssignments(creds, course.id);
      upsertAssignments(db, course.id, assignments, syncedAt);
    } catch (error) {
      if (error instanceof CanvasAuthError) {
        setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');
        return { ok: false, coursesSynced: 0, tokenInvalid: true, errors: [error.message] };
      }
      errors.push(`${course.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const known = new Set(courses.map((c) => c.id));
    const announcements = await api.listAnnouncements(creds, courses.map((c) => c.id));
    const upsert = db.prepare(
      `insert into canvas_announcements (id, course_id, title, message, posted_at, html_url, synced_at)
       values (@id, @course_id, @title, @message, @posted_at, @html_url, @synced_at)
       on conflict(id) do update set
         title = excluded.title, message = excluded.message, posted_at = excluded.posted_at,
         html_url = excluded.html_url, synced_at = excluded.synced_at`
    );
    db.transaction(() => {
      for (const announcement of announcements) {
        const courseId = Number.parseInt((announcement.context_code ?? '').replace('course_', ''), 10);
        // Canvas can return announcements for contexts outside the active set;
        // inserting those would violate the foreign key.
        if (!Number.isFinite(courseId) || !known.has(courseId)) continue;
        upsert.run({
          id: announcement.id,
          course_id: courseId,
          title: announcement.title ?? null,
          message: announcement.message ?? null,
          posted_at: announcement.posted_at ?? null,
          html_url: announcement.html_url ?? null,
          synced_at: syncedAt,
        });
      }
    })();
  } catch (error) {
    if (error instanceof CanvasAuthError) {
      setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');
      return { ok: false, coursesSynced: courses.length, tokenInvalid: true, errors: [error.message] };
    }
    errors.push(`Announcements: ${error instanceof Error ? error.message : String(error)}`);
  }

  clearSyncState(db, SYNC_KEY_TOKEN_INVALID);
  setSyncState(db, SYNC_KEY_LAST_CORE, syncedAt);
  return { ok: true, coursesSynced: courses.length, tokenInvalid: false, errors };
}
```

- [ ] **Step 4: Run the sync test to verify it passes**

Run: `npm run test -- src/main/canvas/sync.test.ts`
Expected: PASS, 16/16 tests.

- [ ] **Step 5: Write the failing queries test**

Create `src/main/canvas/queries.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

import { getUpcomingAssignments, getCourseGrades, getRecentAnnouncements, getSyncStatus } from './queries';

const SCHEMA = `
create table settings (key text primary key, value text not null);
create table canvas_courses (
  id integer primary key, name text not null, course_code text, term_name text,
  current_score real, current_grade text, synced_at text not null default (datetime('now'))
);
create table canvas_assignments (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  name text not null, description text, due_at text, points_possible real, html_url text,
  submission_types text, has_submitted integer not null default 0, submitted_at text,
  score real, grade text, workflow_state text,
  synced_at text not null default (datetime('now'))
);
create table canvas_announcements (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  title text, message text, posted_at text, html_url text,
  synced_at text not null default (datetime('now'))
);
create table canvas_sync_state (key text primary key, value text not null);
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare('insert into canvas_courses (id, name, course_code, current_score, current_grade) values (?,?,?,?,?)').run(
    101, 'Statistics', 'STT 215', 91.5, 'A-'
  );
  db.prepare('insert into canvas_courses (id, name, course_code, current_score, current_grade) values (?,?,?,?,?)').run(
    202, 'Chemistry', 'CHM 101', 78, 'C+'
  );
  return db;
}

function addAssignment(db: Database.Database, fields: Record<string, unknown>): void {
  db.prepare(
    `insert into canvas_assignments (id, course_id, name, due_at, points_possible, has_submitted)
     values (@id, @course_id, @name, @due_at, @points_possible, @has_submitted)`
  ).run({ points_possible: 10, has_submitted: 0, due_at: null, ...fields });
}

const NOW = new Date('2026-08-18T00:00:00Z');

describe('getUpcomingAssignments', () => {
  it('returns only assignments inside the window, in due order', () => {
    const db = makeDb();
    addAssignment(db, { id: 1, course_id: 101, name: 'Later', due_at: '2026-08-25T00:00:00Z' });
    addAssignment(db, { id: 2, course_id: 101, name: 'Sooner', due_at: '2026-08-20T00:00:00Z' });
    addAssignment(db, { id: 3, course_id: 101, name: 'Beyond window', due_at: '2026-10-01T00:00:00Z' });

    const rows = getUpcomingAssignments(db, 14, NOW);

    expect(rows.map((r) => r.name)).toEqual(['Sooner', 'Later']);
  });

  it('excludes assignments already past due', () => {
    const db = makeDb();
    addAssignment(db, { id: 1, course_id: 101, name: 'Yesterday', due_at: '2026-08-17T00:00:00Z' });

    expect(getUpcomingAssignments(db, 14, NOW)).toHaveLength(0);
  });

  it('excludes assignments with no due date', () => {
    const db = makeDb();
    addAssignment(db, { id: 1, course_id: 101, name: 'Undated', due_at: null });

    expect(getUpcomingAssignments(db, 14, NOW)).toHaveLength(0);
  });

  it('includes the course name and submitted flag', () => {
    const db = makeDb();
    addAssignment(db, { id: 1, course_id: 202, name: 'Lab 1', due_at: '2026-08-20T00:00:00Z', has_submitted: 1 });

    const [row] = getUpcomingAssignments(db, 14, NOW);

    expect(row.courseName).toBe('Chemistry');
    expect(row.hasSubmitted).toBe(true);
  });

  it('breaks same-instant ties deterministically by id', () => {
    const db = makeDb();
    addAssignment(db, { id: 9, course_id: 101, name: 'B', due_at: '2026-08-20T00:00:00Z' });
    addAssignment(db, { id: 4, course_id: 101, name: 'A', due_at: '2026-08-20T00:00:00Z' });

    expect(getUpcomingAssignments(db, 14, NOW).map((r) => r.id)).toEqual([4, 9]);
  });
});

describe('getCourseGrades', () => {
  it('returns every course ordered by name', () => {
    const rows = getCourseGrades(makeDb());
    expect(rows.map((r) => r.name)).toEqual(['Chemistry', 'Statistics']);
    expect(rows[1].currentScore).toBe(91.5);
    expect(rows[1].currentGrade).toBe('A-');
  });
});

describe('getRecentAnnouncements', () => {
  it('returns newest first and respects the limit', () => {
    const db = makeDb();
    const insert = db.prepare(
      'insert into canvas_announcements (id, course_id, title, posted_at) values (?,?,?,?)'
    );
    insert.run(1, 101, 'Oldest', '2026-08-01T00:00:00Z');
    insert.run(2, 101, 'Newest', '2026-08-17T00:00:00Z');
    insert.run(3, 202, 'Middle', '2026-08-10T00:00:00Z');

    const rows = getRecentAnnouncements(db, 2);

    expect(rows.map((r) => r.title)).toEqual(['Newest', 'Middle']);
    expect(rows[0].courseName).toBe('Statistics');
  });
});

describe('getSyncStatus', () => {
  it('reports unconfigured when nothing is stored', () => {
    const status = getSyncStatus(makeDb(), NOW);
    expect(status.tokenConfigured).toBe(false);
    expect(status.baseUrlConfigured).toBe(false);
    expect(status.lastSyncedAt).toBeNull();
    expect(status.tokenInvalid).toBe(false);
    expect(status.tokenExpiringSoon).toBe(false);
  });

  it('reports configured state, last sync, and the invalid flag', () => {
    const db = makeDb();
    db.prepare('insert into settings (key, value) values (?, ?)').run('canvas_base_url', 'https://uncw.instructure.com');
    db.prepare('insert into settings (key, value) values (?, ?)').run('canvas_token_encrypted', 'ZW5jOnQ=');
    db.prepare('insert into canvas_sync_state (key, value) values (?, ?)').run('last_core_sync', '2026-08-18T00:00:00.000Z');
    db.prepare('insert into canvas_sync_state (key, value) values (?, ?)').run('token_invalid', '1');

    const status = getSyncStatus(db, NOW);

    expect(status.tokenConfigured).toBe(true);
    expect(status.baseUrlConfigured).toBe(true);
    expect(status.lastSyncedAt).toBe('2026-08-18T00:00:00.000Z');
    expect(status.tokenInvalid).toBe(true);
  });

  it('flags a token past the warning threshold', () => {
    const db = makeDb();
    db.prepare('insert into settings (key, value) values (?, ?)').run('canvas_token_encrypted', 'ZW5jOnQ=');
    db.prepare('insert into settings (key, value) values (?, ?)').run('canvas_token_saved_at', '2026-05-01T00:00:00Z');

    const status = getSyncStatus(db, NOW);

    expect(status.tokenAgeDays).toBe(109);
    expect(status.tokenExpiringSoon).toBe(true);
  });

  it('does not flag a freshly saved token', () => {
    const db = makeDb();
    db.prepare('insert into settings (key, value) values (?, ?)').run('canvas_token_encrypted', 'ZW5jOnQ=');
    db.prepare('insert into settings (key, value) values (?, ?)').run('canvas_token_saved_at', '2026-08-17T00:00:00Z');

    expect(getSyncStatus(db, NOW).tokenExpiringSoon).toBe(false);
  });
});
```

- [ ] **Step 6: Run the queries test to verify it fails**

Run: `npm run test -- src/main/canvas/queries.test.ts`
Expected: FAIL with `Failed to resolve import "./queries"`.

- [ ] **Step 7: Implement `queries.ts`**

Create `src/main/canvas/queries.ts`:

```ts
import type Database from 'better-sqlite3';
import { getCanvasBaseUrl, getTokenAgeDays, hasCanvasToken, TOKEN_WARN_AFTER_DAYS } from './token';
import { getSyncState, SYNC_KEY_LAST_CORE, SYNC_KEY_TOKEN_INVALID } from './sync';

export interface UpcomingAssignment {
  id: number;
  courseId: number;
  courseName: string;
  name: string;
  dueAt: string;
  pointsPossible: number | null;
  hasSubmitted: boolean;
  htmlUrl: string | null;
}

export interface CourseGrade {
  id: number;
  name: string;
  courseCode: string | null;
  currentScore: number | null;
  currentGrade: string | null;
}

export interface AnnouncementRow {
  id: number;
  courseId: number;
  courseName: string;
  title: string | null;
  message: string | null;
  postedAt: string | null;
}

export interface CanvasSyncStatus {
  tokenConfigured: boolean;
  baseUrlConfigured: boolean;
  lastSyncedAt: string | null;
  tokenInvalid: boolean;
  tokenAgeDays: number | null;
  tokenExpiringSoon: boolean;
}

const MS_PER_DAY = 86_400_000;

export function getUpcomingAssignments(
  db: Database.Database,
  days: number,
  now: Date = new Date()
): UpcomingAssignment[] {
  const from = now.toISOString();
  const to = new Date(now.getTime() + days * MS_PER_DAY).toISOString();
  const rows = db
    .prepare(
      `select a.id, a.course_id, c.name as course_name, a.name, a.due_at,
              a.points_possible, a.has_submitted, a.html_url
       from canvas_assignments a
       join canvas_courses c on c.id = a.course_id
       where a.due_at is not null and a.due_at >= ? and a.due_at <= ?
       order by a.due_at, a.id`
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
  }>;

  return rows.map((row) => ({
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

export function getCourseGrades(db: Database.Database): CourseGrade[] {
  const rows = db
    .prepare(
      'select id, name, course_code, current_score, current_grade from canvas_courses order by name, id'
    )
    .all() as Array<{
    id: number;
    name: string;
    course_code: string | null;
    current_score: number | null;
    current_grade: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    courseCode: row.course_code,
    currentScore: row.current_score,
    currentGrade: row.current_grade,
  }));
}

export function getRecentAnnouncements(db: Database.Database, limit: number): AnnouncementRow[] {
  const rows = db
    .prepare(
      `select n.id, n.course_id, c.name as course_name, n.title, n.message, n.posted_at
       from canvas_announcements n
       join canvas_courses c on c.id = n.course_id
       order by n.posted_at desc, n.id desc
       limit ?`
    )
    .all(limit) as Array<{
    id: number;
    course_id: number;
    course_name: string;
    title: string | null;
    message: string | null;
    posted_at: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    courseId: row.course_id,
    courseName: row.course_name,
    title: row.title,
    message: row.message,
    postedAt: row.posted_at,
  }));
}

export function getSyncStatus(db: Database.Database, now: Date = new Date()): CanvasSyncStatus {
  const tokenAgeDays = getTokenAgeDays(db, now);
  return {
    tokenConfigured: hasCanvasToken(db),
    baseUrlConfigured: getCanvasBaseUrl(db) !== null,
    lastSyncedAt: getSyncState(db, SYNC_KEY_LAST_CORE),
    tokenInvalid: getSyncState(db, SYNC_KEY_TOKEN_INVALID) === '1',
    tokenAgeDays,
    tokenExpiringSoon: tokenAgeDays !== null && tokenAgeDays >= TOKEN_WARN_AFTER_DAYS,
  };
}
```

- [ ] **Step 8: Run the queries test to verify it passes**

Run: `npm run test -- src/main/canvas/queries.test.ts`
Expected: PASS, 12/12 tests.

- [ ] **Step 9: Run the full check chain**

Run: `npm run lint && npm run typecheck && npm run test && npm run build`
Expected: all four exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/main/canvas/sync.ts src/main/canvas/sync.test.ts src/main/canvas/queries.ts src/main/canvas/queries.test.ts
git commit -m "Task 3: tier-1 Canvas sync engine and local read queries"
```

---

### Task 4: Tier-2 course content sync, course detail queries, and file open

**Files:**
- Modify: `src/main/canvas/sync.ts` (append `syncCourseContent` and `fetchPageBody`)
- Modify: `src/main/canvas/queries.ts` (append `getCourseDetail`, `searchMaterials`, `getPageBody`)
- Create: `src/main/canvas/files.ts`
- Test: `src/main/canvas/syncContent.test.ts`
- Test: `src/main/canvas/files.test.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 1–3.
- Produces:
  - `syncCourseContent(db, creds, courseId, now?): Promise<{ ok: boolean; errors: string[]; tokenInvalid: boolean }>`
  - `fetchPageBody(db, creds, courseId, pageUrl): Promise<string | null>`
  - `getCourseDetail(db, courseId): CourseDetail | null` where
    `interface CourseDetail { course: CourseGrade; assignments: CourseAssignment[]; modules: ModuleWithItems[]; files: FileRow[]; announcements: AnnouncementRow[] }`
  - `searchMaterials(db, query, limit): MaterialHit[]`
  - `getPageBody(db, courseId, pageUrl): { title: string | null; body: string | null } | null`
  - `safeFileName(name: string): string`
  - `openCanvasFile(db, creds, fileId): Promise<void>`

**Constraints specific to this task:**
- **`safeFileName` is a security boundary, not a nicety.** `display_name` is attacker-influenced text from Canvas; writing it unsanitized into a path allows directory traversal. Strip path separators and leading dots, and never let the result be empty.
- Course files can be disabled by an instructor, which surfaces as a **403**. That must degrade to "no files" for that course, not fail the whole content sync.
- **Never store the URL returned by `getFile`.** Use it immediately and discard it.
- `canvas_pages` rows are created from module items of type `Page` with `body` left null; the body is fetched only when the user opens the page. There is no separate page-listing request.

- [ ] **Step 1: Write the failing content-sync test**

Create `src/main/canvas/syncContent.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('./api', () => ({
  listCourses: vi.fn(),
  listAssignments: vi.fn(),
  listAnnouncements: vi.fn(),
  listModules: vi.fn(),
  listModuleItems: vi.fn(),
  listFiles: vi.fn(),
  getPage: vi.fn(),
  getFile: vi.fn(),
  getSelf: vi.fn(),
}));

import * as api from './api';
import { CanvasAuthError, CanvasNetworkError } from './errors';
import { syncCourseContent, fetchPageBody, getSyncState, courseContentKey } from './sync';

const CREDS = { baseUrl: 'https://uncw.instructure.com', token: 'test-token' };

const SCHEMA = `
create table canvas_courses (
  id integer primary key, name text not null, course_code text, term_name text,
  current_score real, current_grade text, synced_at text not null default (datetime('now'))
);
create table canvas_modules (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  name text, position integer, synced_at text not null default (datetime('now'))
);
create table canvas_module_items (
  id integer primary key,
  module_id integer not null references canvas_modules(id) on delete cascade,
  course_id integer not null, title text, type text, content_id integer,
  page_url text, html_url text, external_url text, position integer
);
create table canvas_files (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  display_name text, filename text, content_type text, size integer,
  updated_at text, synced_at text not null default (datetime('now'))
);
create table canvas_pages (
  course_id integer not null references canvas_courses(id) on delete cascade,
  url text not null, title text, body text, updated_at text,
  synced_at text not null default (datetime('now')), primary key (course_id, url)
);
create table canvas_sync_state (key text primary key, value text not null);
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare('insert into canvas_courses (id, name) values (?, ?)').run(101, 'Statistics');
  return db;
}

beforeEach(() => {
  vi.mocked(api.listModules).mockReset();
  vi.mocked(api.listModuleItems).mockReset();
  vi.mocked(api.listFiles).mockReset();
  vi.mocked(api.getPage).mockReset();
  vi.mocked(api.listFiles).mockResolvedValue([]);
});

describe('syncCourseContent', () => {
  it('stores modules and their inlined items', async () => {
    vi.mocked(api.listModules).mockResolvedValue([
      {
        id: 10,
        name: 'Week 1',
        position: 1,
        items: [
          { id: 1000, title: 'Syllabus', type: 'Page', page_url: 'syllabus', position: 1 },
          { id: 1001, title: 'Slides', type: 'File', content_id: 7, position: 2 },
        ],
      },
    ]);
    const db = makeDb();

    const result = await syncCourseContent(db, CREDS, 101);

    expect(result.ok).toBe(true);
    const module = db.prepare('select * from canvas_modules where id = 10').get() as Record<string, unknown>;
    expect(module.name).toBe('Week 1');
    const items = db.prepare('select id, type from canvas_module_items order by position').all() as {
      id: number;
      type: string;
    }[];
    expect(items).toEqual([
      { id: 1000, type: 'Page' },
      { id: 1001, type: 'File' },
    ]);
  });

  it('falls back to a per-module item request when Canvas omits items', async () => {
    vi.mocked(api.listModules).mockResolvedValue([{ id: 10, name: 'Huge module', position: 1 }]);
    vi.mocked(api.listModuleItems).mockResolvedValue([
      { id: 2000, title: 'Reading', type: 'Page', page_url: 'reading', position: 1 },
    ]);
    const db = makeDb();

    await syncCourseContent(db, CREDS, 101);

    expect(api.listModuleItems).toHaveBeenCalledWith(CREDS, 101, 10);
    const count = db.prepare('select count(*) as c from canvas_module_items').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('creates a page stub with a null body for each Page item', async () => {
    vi.mocked(api.listModules).mockResolvedValue([
      { id: 10, name: 'Week 1', items: [{ id: 1000, title: 'Syllabus', type: 'Page', page_url: 'syllabus' }] },
    ]);
    const db = makeDb();

    await syncCourseContent(db, CREDS, 101);

    const page = db.prepare('select title, body from canvas_pages where course_id = 101 and url = ?').get('syllabus') as {
      title: string;
      body: string | null;
    };
    expect(page.title).toBe('Syllabus');
    expect(page.body).toBeNull();
    expect(api.getPage).not.toHaveBeenCalled();
  });

  it('stores the course file list', async () => {
    vi.mocked(api.listModules).mockResolvedValue([]);
    vi.mocked(api.listFiles).mockResolvedValue([
      { id: 7, display_name: 'Lecture 1.pdf', filename: 'lecture1.pdf', 'content-type': 'application/pdf', size: 1024 },
    ]);
    const db = makeDb();

    await syncCourseContent(db, CREDS, 101);

    const file = db.prepare('select * from canvas_files where id = 7').get() as Record<string, unknown>;
    expect(file.display_name).toBe('Lecture 1.pdf');
    expect(file.content_type).toBe('application/pdf');
    expect(file.size).toBe(1024);
  });

  it('degrades to no files when the instructor has disabled the files tab', async () => {
    vi.mocked(api.listModules).mockResolvedValue([]);
    vi.mocked(api.listFiles).mockRejectedValue(new CanvasNetworkError('Canvas returned 403: unauthorized'));
    const db = makeDb();

    const result = await syncCourseContent(db, CREDS, 101);

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(1);
    const count = db.prepare('select count(*) as c from canvas_files').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('is idempotent and prunes modules removed from Canvas', async () => {
    const db = makeDb();
    vi.mocked(api.listModules).mockResolvedValue([
      { id: 10, name: 'Week 1', items: [] },
      { id: 11, name: 'Week 2', items: [] },
    ]);
    await syncCourseContent(db, CREDS, 101);

    vi.mocked(api.listModules).mockResolvedValue([{ id: 10, name: 'Week 1', items: [] }]);
    await syncCourseContent(db, CREDS, 101);

    const ids = (db.prepare('select id from canvas_modules order by id').all() as { id: number }[]).map((r) => r.id);
    expect(ids).toEqual([10]);
  });

  it('records the per-course content sync timestamp', async () => {
    vi.mocked(api.listModules).mockResolvedValue([]);
    const db = makeDb();

    await syncCourseContent(db, CREDS, 101, new Date('2026-08-18T12:00:00Z'));

    expect(getSyncState(db, courseContentKey(101))).toBe('2026-08-18T12:00:00.000Z');
  });

  it('reports tokenInvalid without throwing on auth failure', async () => {
    vi.mocked(api.listModules).mockRejectedValue(new CanvasAuthError());
    const db = makeDb();

    const result = await syncCourseContent(db, CREDS, 101);

    expect(result.ok).toBe(false);
    expect(result.tokenInvalid).toBe(true);
    expect(getSyncState(db, 'token_invalid')).toBe('1');
  });
});

describe('fetchPageBody', () => {
  it('fetches the body once and caches it in canvas_pages', async () => {
    vi.mocked(api.listModules).mockResolvedValue([
      { id: 10, name: 'Week 1', items: [{ id: 1000, title: 'Syllabus', type: 'Page', page_url: 'syllabus' }] },
    ]);
    const db = makeDb();
    await syncCourseContent(db, CREDS, 101);

    vi.mocked(api.getPage).mockResolvedValue({ url: 'syllabus', title: 'Syllabus', body: '<p>Read this</p>' });
    const body = await fetchPageBody(db, CREDS, 101, 'syllabus');

    expect(body).toBe('<p>Read this</p>');
    const stored = db.prepare('select body from canvas_pages where course_id = 101 and url = ?').get('syllabus') as {
      body: string;
    };
    expect(stored.body).toBe('<p>Read this</p>');
  });

  it('inserts a page row even when the page was not part of any module', async () => {
    const db = makeDb();
    vi.mocked(api.getPage).mockResolvedValue({ url: 'orphan', title: 'Orphan', body: '<p>hi</p>' });

    await fetchPageBody(db, CREDS, 101, 'orphan');

    const stored = db.prepare('select title from canvas_pages where course_id = 101 and url = ?').get('orphan') as {
      title: string;
    };
    expect(stored.title).toBe('Orphan');
  });

  it('returns null and does not throw when Canvas rejects the page', async () => {
    const db = makeDb();
    vi.mocked(api.getPage).mockRejectedValue(new CanvasNetworkError('404'));

    await expect(fetchPageBody(db, CREDS, 101, 'missing')).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/main/canvas/syncContent.test.ts`
Expected: FAIL — `syncCourseContent` and `fetchPageBody` are not exported from `./sync`.

- [ ] **Step 3: Append `syncCourseContent` and `fetchPageBody` to `sync.ts`**

Add these imports to the existing import block at the top of `src/main/canvas/sync.ts`:

```ts
import type { CanvasFile, CanvasModule, CanvasModuleItem } from './api';
```

Then append to the end of the file:

```ts
export interface ContentSyncResult {
  ok: boolean;
  tokenInvalid: boolean;
  errors: string[];
}

function upsertModules(
  db: Database.Database,
  courseId: number,
  modules: Array<CanvasModule & { resolvedItems: CanvasModuleItem[] }>,
  syncedAt: string
): void {
  const upsertModule = db.prepare(
    `insert into canvas_modules (id, course_id, name, position, synced_at)
     values (@id, @course_id, @name, @position, @synced_at)
     on conflict(id) do update set
       name = excluded.name, position = excluded.position, synced_at = excluded.synced_at`
  );
  const upsertItem = db.prepare(
    `insert into canvas_module_items
       (id, module_id, course_id, title, type, content_id, page_url, html_url, external_url, position)
     values
       (@id, @module_id, @course_id, @title, @type, @content_id, @page_url, @html_url, @external_url, @position)
     on conflict(id) do update set
       module_id = excluded.module_id, title = excluded.title, type = excluded.type,
       content_id = excluded.content_id, page_url = excluded.page_url, html_url = excluded.html_url,
       external_url = excluded.external_url, position = excluded.position`
  );
  const upsertPageStub = db.prepare(
    `insert into canvas_pages (course_id, url, title, synced_at)
     values (?, ?, ?, ?)
     on conflict(course_id, url) do update set title = excluded.title`
  );

  db.transaction(() => {
    for (const module of modules) {
      upsertModule.run({
        id: module.id,
        course_id: courseId,
        name: module.name ?? null,
        position: module.position ?? null,
        synced_at: syncedAt,
      });
      for (const item of module.resolvedItems) {
        upsertItem.run({
          id: item.id,
          module_id: module.id,
          course_id: courseId,
          title: item.title ?? null,
          type: item.type ?? null,
          content_id: item.content_id ?? null,
          page_url: item.page_url ?? null,
          html_url: item.html_url ?? null,
          external_url: item.external_url ?? null,
          position: item.position ?? null,
        });
        // Page bodies are fetched lazily; this only records that the page exists.
        if (item.type === 'Page' && item.page_url) {
          upsertPageStub.run(courseId, item.page_url, item.title ?? null, syncedAt);
        }
      }
      const keepItems = module.resolvedItems.map((i) => i.id);
      if (keepItems.length === 0) {
        db.prepare('delete from canvas_module_items where module_id = ?').run(module.id);
      } else {
        const placeholders = keepItems.map(() => '?').join(',');
        db.prepare(
          `delete from canvas_module_items where module_id = ? and id not in (${placeholders})`
        ).run(module.id, ...keepItems);
      }
    }
    const keep = modules.map((m) => m.id);
    if (keep.length === 0) {
      db.prepare('delete from canvas_modules where course_id = ?').run(courseId);
    } else {
      const placeholders = keep.map(() => '?').join(',');
      db.prepare(`delete from canvas_modules where course_id = ? and id not in (${placeholders})`).run(
        courseId,
        ...keep
      );
    }
  })();
}

function upsertFiles(
  db: Database.Database,
  courseId: number,
  files: CanvasFile[],
  syncedAt: string
): void {
  const upsert = db.prepare(
    `insert into canvas_files (id, course_id, display_name, filename, content_type, size, updated_at, synced_at)
     values (@id, @course_id, @display_name, @filename, @content_type, @size, @updated_at, @synced_at)
     on conflict(id) do update set
       display_name = excluded.display_name, filename = excluded.filename,
       content_type = excluded.content_type, size = excluded.size,
       updated_at = excluded.updated_at, synced_at = excluded.synced_at`
  );
  db.transaction(() => {
    for (const file of files) {
      upsert.run({
        id: file.id,
        course_id: courseId,
        display_name: file.display_name ?? null,
        filename: file.filename ?? null,
        // Canvas spells this key with a hyphen on the file resource.
        content_type: file['content-type'] ?? null,
        size: file.size ?? null,
        updated_at: file.updated_at ?? null,
        synced_at: syncedAt,
      });
    }
    const keep = files.map((f) => f.id);
    if (keep.length === 0) {
      db.prepare('delete from canvas_files where course_id = ?').run(courseId);
    } else {
      const placeholders = keep.map(() => '?').join(',');
      db.prepare(`delete from canvas_files where course_id = ? and id not in (${placeholders})`).run(
        courseId,
        ...keep
      );
    }
  })();
}

/**
 * Tier-2 sync for a single course: modules + items + file list. Called the
 * first time a course is opened, then on explicit refresh. Serial, like syncCore.
 */
export async function syncCourseContent(
  db: Database.Database,
  creds: CanvasCredentials,
  courseId: number,
  now: Date = new Date()
): Promise<ContentSyncResult> {
  const syncedAt = now.toISOString();
  const errors: string[] = [];

  let modules: CanvasModule[];
  try {
    modules = await api.listModules(creds, courseId);
  } catch (error) {
    if (error instanceof CanvasAuthError) {
      setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');
      return { ok: false, tokenInvalid: true, errors: [error.message] };
    }
    return { ok: false, tokenInvalid: false, errors: [error instanceof Error ? error.message : String(error)] };
  }

  const resolved: Array<CanvasModule & { resolvedItems: CanvasModuleItem[] }> = [];
  for (const module of modules) {
    let items = module.items;
    // Canvas omits `items` for very large modules; fall back to the item endpoint.
    if (!items) {
      try {
        items = await api.listModuleItems(creds, courseId, module.id);
      } catch (error) {
        if (error instanceof CanvasAuthError) {
          setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');
          return { ok: false, tokenInvalid: true, errors: [error.message] };
        }
        errors.push(`Module ${module.name ?? module.id}: ${error instanceof Error ? error.message : String(error)}`);
        items = [];
      }
    }
    resolved.push({ ...module, resolvedItems: items });
  }
  upsertModules(db, courseId, resolved, syncedAt);

  try {
    const files = await api.listFiles(creds, courseId);
    upsertFiles(db, courseId, files, syncedAt);
  } catch (error) {
    if (error instanceof CanvasAuthError) {
      setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');
      return { ok: false, tokenInvalid: true, errors: [error.message] };
    }
    // An instructor can disable the Files tab, which surfaces as a 403.
    errors.push(`Files: ${error instanceof Error ? error.message : String(error)}`);
  }

  setSyncState(db, courseContentKey(courseId), syncedAt);
  return { ok: true, tokenInvalid: false, errors };
}

/** Fetch a page's HTML on demand and cache it. Returns null if Canvas refuses. */
export async function fetchPageBody(
  db: Database.Database,
  creds: CanvasCredentials,
  courseId: number,
  pageUrl: string
): Promise<string | null> {
  let page;
  try {
    page = await api.getPage(creds, courseId, pageUrl);
  } catch (error) {
    if (error instanceof CanvasAuthError) setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');
    return null;
  }
  const body = page.body ?? null;
  db.prepare(
    `insert into canvas_pages (course_id, url, title, body, updated_at, synced_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict(course_id, url) do update set
       title = excluded.title, body = excluded.body, updated_at = excluded.updated_at,
       synced_at = excluded.synced_at`
  ).run(courseId, pageUrl, page.title ?? null, body, page.updated_at ?? null, new Date().toISOString());
  return body;
}
```

- [ ] **Step 4: Run the content-sync test to verify it passes**

Run: `npm run test -- src/main/canvas/syncContent.test.ts`
Expected: PASS, 11/11 tests.

- [ ] **Step 5: Append the detail and search queries to `queries.ts`**

Add to the end of `src/main/canvas/queries.ts`:

```ts
export interface CourseAssignment {
  id: number;
  name: string;
  dueAt: string | null;
  pointsPossible: number | null;
  hasSubmitted: boolean;
  score: number | null;
  grade: string | null;
  htmlUrl: string | null;
}

export interface ModuleItemRow {
  id: number;
  title: string | null;
  type: string | null;
  contentId: number | null;
  pageUrl: string | null;
  externalUrl: string | null;
}

export interface ModuleWithItems {
  id: number;
  name: string | null;
  items: ModuleItemRow[];
}

export interface FileRow {
  id: number;
  displayName: string | null;
  contentType: string | null;
  size: number | null;
}

export interface CourseDetail {
  course: CourseGrade;
  assignments: CourseAssignment[];
  modules: ModuleWithItems[];
  files: FileRow[];
  announcements: AnnouncementRow[];
  contentSyncedAt: string | null;
}

export interface MaterialHit {
  kind: 'file' | 'page';
  courseId: number;
  courseName: string;
  title: string;
  fileId: number | null;
  pageUrl: string | null;
}

export function getCourseDetail(db: Database.Database, courseId: number): CourseDetail | null {
  const course = db
    .prepare('select id, name, course_code, current_score, current_grade from canvas_courses where id = ?')
    .get(courseId) as
    | { id: number; name: string; course_code: string | null; current_score: number | null; current_grade: string | null }
    | undefined;
  if (!course) return null;

  const assignments = (
    db
      .prepare(
        `select id, name, due_at, points_possible, has_submitted, score, grade, html_url
         from canvas_assignments where course_id = ?
         order by case when due_at is null then 1 else 0 end, due_at, id`
      )
      .all(courseId) as Array<{
      id: number;
      name: string;
      due_at: string | null;
      points_possible: number | null;
      has_submitted: number;
      score: number | null;
      grade: string | null;
      html_url: string | null;
    }>
  ).map((row) => ({
    id: row.id,
    name: row.name,
    dueAt: row.due_at,
    pointsPossible: row.points_possible,
    hasSubmitted: row.has_submitted === 1,
    score: row.score,
    grade: row.grade,
    htmlUrl: row.html_url,
  }));

  const moduleRows = db
    .prepare('select id, name from canvas_modules where course_id = ? order by position, id')
    .all(courseId) as { id: number; name: string | null }[];

  const itemStmt = db.prepare(
    `select id, title, type, content_id, page_url, external_url
     from canvas_module_items where module_id = ? order by position, id`
  );

  const modules: ModuleWithItems[] = moduleRows.map((module) => ({
    id: module.id,
    name: module.name,
    items: (
      itemStmt.all(module.id) as Array<{
        id: number;
        title: string | null;
        type: string | null;
        content_id: number | null;
        page_url: string | null;
        external_url: string | null;
      }>
    ).map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      contentId: item.content_id,
      pageUrl: item.page_url,
      externalUrl: item.external_url,
    })),
  }));

  const files = (
    db
      .prepare('select id, display_name, content_type, size from canvas_files where course_id = ? order by display_name, id')
      .all(courseId) as Array<{ id: number; display_name: string | null; content_type: string | null; size: number | null }>
  ).map((row) => ({ id: row.id, displayName: row.display_name, contentType: row.content_type, size: row.size }));

  const announcements = (
    db
      .prepare(
        `select n.id, n.course_id, c.name as course_name, n.title, n.message, n.posted_at
         from canvas_announcements n join canvas_courses c on c.id = n.course_id
         where n.course_id = ? order by n.posted_at desc, n.id desc`
      )
      .all(courseId) as Array<{
      id: number;
      course_id: number;
      course_name: string;
      title: string | null;
      message: string | null;
      posted_at: string | null;
    }>
  ).map((row) => ({
    id: row.id,
    courseId: row.course_id,
    courseName: row.course_name,
    title: row.title,
    message: row.message,
    postedAt: row.posted_at,
  }));

  return {
    course: {
      id: course.id,
      name: course.name,
      courseCode: course.course_code,
      currentScore: course.current_score,
      currentGrade: course.current_grade,
    },
    assignments,
    modules,
    files,
    announcements,
    contentSyncedAt: getSyncState(db, courseContentKey(courseId)),
  };
}

export function searchMaterials(db: Database.Database, query: string, limit = 25): MaterialHit[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const like = `%${trimmed.replace(/[%_]/g, (c) => `\\${c}`)}%`;

  const files = db
    .prepare(
      `select f.id, f.display_name, f.course_id, c.name as course_name
       from canvas_files f join canvas_courses c on c.id = f.course_id
       where f.display_name like ? escape '\\'
       order by f.display_name, f.id limit ?`
    )
    .all(like, limit) as Array<{ id: number; display_name: string | null; course_id: number; course_name: string }>;

  const pages = db
    .prepare(
      `select p.url, p.title, p.course_id, c.name as course_name
       from canvas_pages p join canvas_courses c on c.id = p.course_id
       where p.title like ? escape '\\'
       order by p.title, p.url limit ?`
    )
    .all(like, limit) as Array<{ url: string; title: string | null; course_id: number; course_name: string }>;

  const hits: MaterialHit[] = [
    ...files.map((f) => ({
      kind: 'file' as const,
      courseId: f.course_id,
      courseName: f.course_name,
      title: f.display_name ?? 'Untitled file',
      fileId: f.id,
      pageUrl: null,
    })),
    ...pages.map((p) => ({
      kind: 'page' as const,
      courseId: p.course_id,
      courseName: p.course_name,
      title: p.title ?? p.url,
      fileId: null,
      pageUrl: p.url,
    })),
  ];

  return hits.slice(0, limit);
}

export function getPageBody(
  db: Database.Database,
  courseId: number,
  pageUrl: string
): { title: string | null; body: string | null } | null {
  const row = db
    .prepare('select title, body from canvas_pages where course_id = ? and url = ?')
    .get(courseId, pageUrl) as { title: string | null; body: string | null } | undefined;
  return row ?? null;
}
```

Add `courseContentKey` to the existing `./sync` import at the top of `queries.ts`:

```ts
import { courseContentKey, getSyncState, SYNC_KEY_LAST_CORE, SYNC_KEY_TOKEN_INVALID } from './sync';
```

- [ ] **Step 6: Write the failing file test**

Create `src/main/canvas/files.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { safeFileName } from './files';

describe('safeFileName', () => {
  it('keeps an ordinary name intact', () => {
    expect(safeFileName('Lecture 1.pdf')).toBe('Lecture 1.pdf');
  });

  it('strips directory traversal segments', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('..\\..\\windows\\system32')).toBe('system32');
  });

  it('strips leading dots so nothing writes a hidden file', () => {
    expect(safeFileName('...hidden')).toBe('hidden');
  });

  it('falls back to a placeholder when nothing usable remains', () => {
    expect(safeFileName('../')).toBe('download');
    expect(safeFileName('   ')).toBe('download');
  });

  it('truncates absurdly long names', () => {
    expect(safeFileName(`${'a'.repeat(300)}.pdf`).length).toBeLessThanOrEqual(120);
  });
});
```

- [ ] **Step 7: Run the file test to verify it fails**

Run: `npm run test -- src/main/canvas/files.test.ts`
Expected: FAIL with `Failed to resolve import "./files"`.

- [ ] **Step 8: Implement `files.ts`**

Create `src/main/canvas/files.ts`:

```ts
import { app, shell } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CanvasCredentials } from './client';
import { CanvasAuthError, CanvasNetworkError } from './errors';
import { getFile } from './api';
import { setSyncState, SYNC_KEY_TOKEN_INVALID } from './sync';

const MAX_NAME_LENGTH = 120;

/**
 * Canvas display names are attacker-influenced text. Writing one straight into
 * a path would allow directory traversal, so reduce it to a bare filename.
 */
export function safeFileName(name: string): string {
  const lastSegment = basename(name.replace(/\\/g, '/')).trim();
  const cleaned = lastSegment.replace(/^\.+/, '').replace(/[/\0]/g, '');
  if (cleaned.length === 0) return 'download';
  return cleaned.slice(0, MAX_NAME_LENGTH);
}

/**
 * Download a course file and hand it to the user's default Mac app.
 * The download URL is fetched fresh here because Canvas file URLs expire —
 * it is deliberately never persisted.
 */
export async function openCanvasFile(
  db: Database.Database,
  creds: CanvasCredentials,
  fileId: number
): Promise<void> {
  let file;
  try {
    file = await getFile(creds, fileId);
  } catch (error) {
    if (error instanceof CanvasAuthError) setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');
    throw error;
  }

  if (!file.url) throw new CanvasNetworkError('Canvas did not return a download link for this file.');

  let response: Response;
  try {
    response = await fetch(file.url, { headers: { Authorization: `Bearer ${creds.token}` } });
  } catch (error) {
    throw new CanvasNetworkError(error instanceof Error ? error.message : 'Download failed.');
  }
  if (!response.ok) throw new CanvasNetworkError(`Download failed with status ${response.status}.`);

  const cacheDir = join(app.getPath('userData'), 'canvas-files');
  mkdirSync(cacheDir, { recursive: true });
  const name = safeFileName(file.display_name ?? file.filename ?? `file-${fileId}`);
  const target = join(cacheDir, `${fileId}-${name}`);
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));

  const failure = await shell.openPath(target);
  if (failure) throw new Error(`Could not open the file: ${failure}`);
}
```

- [ ] **Step 9: Run the file test to verify it passes**

Run: `npm run test -- src/main/canvas/files.test.ts`
Expected: PASS, 5/5 tests.

- [ ] **Step 10: Run the full check chain**

Run: `npm run lint && npm run typecheck && npm run test && npm run build`
Expected: all four exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/main/canvas/sync.ts src/main/canvas/syncContent.test.ts src/main/canvas/queries.ts src/main/canvas/files.ts src/main/canvas/files.test.ts
git commit -m "Task 4: tier-2 course content sync, detail queries, and file open"
```

---

### Task 5: Scheduler, IPC handlers, preload surface, and CSP

**Files:**
- Modify: `src/main/canvas/token.ts` (append `getCanvasCredentials`)
- Create: `src/main/canvas/scheduler.ts`
- Create: `src/main/canvas/ipc.ts`
- Modify: `src/main/csp.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/App.test.tsx`
- Modify: `src/renderer/src/theme/ThemeProvider.test.tsx`
- Test: `src/main/canvas/scheduler.test.ts`
- Test: `src/main/csp.test.ts` (this file already exists — add cases to it; if it does not exist, create it)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces:
  - `getCanvasCredentials(db): CanvasCredentials | null`
  - `interface CanvasScheduler { syncNow(): Promise<void>; stop(): void }`
  - `startCanvasScheduler(db, getWindow): CanvasScheduler`
  - `registerCanvasIpcHandlers(db, getWindow, scheduler): void`
  - `window.smartlife.canvas.*` — the full renderer surface consumed by Tasks 6 and 7.

**Constraints specific to this task:**
- **The scheduler must never run two syncs at once.** Guard with a module-scoped boolean checked and set *synchronously* before the first `await`. (Phase 2 shipped exactly this bug class in `chatController` and needed a fix round — do not repeat it.)
- **Window focus must be throttled to once per 5 minutes.** Without it, alt-tabbing repeatedly hammers Canvas and burns the rate-limit quota.
- **The production CSP is `default-src 'self'`,** which blocks Canvas-hosted images inside announcement and page HTML. `img-src` must be widened to allow `https://*.instructure.com` and `data:`.
- Do not widen `script-src`. Instructor-authored HTML is untrusted; Task 6 sanitizes it, and the CSP is the second layer.

- [ ] **Step 1: Append `getCanvasCredentials` to `token.ts`**

Add this import at the top of `src/main/canvas/token.ts`:

```ts
import type { CanvasCredentials } from './client';
```

And append to the end of the file:

```ts
/** Returns null unless BOTH a base URL and a decryptable token are present. */
export function getCanvasCredentials(db: Database.Database): CanvasCredentials | null {
  const baseUrl = getCanvasBaseUrl(db);
  const token = getCanvasToken(db);
  if (baseUrl === null || token === null) return null;
  return { baseUrl, token };
}
```

- [ ] **Step 2: Write the failing scheduler test**

Create `src/main/canvas/scheduler.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const listeners = new Map<string, () => void>();

vi.mock('electron', () => ({
  app: { on: (event: string, cb: () => void) => listeners.set(event, cb) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

vi.mock('./sync', async () => {
  const actual = await vi.importActual<typeof import('./sync')>('./sync');
  return { ...actual, syncCore: vi.fn() };
});

import { syncCore } from './sync';
import { startCanvasScheduler } from './scheduler';
import { setCanvasBaseUrl, setCanvasToken } from './token';

function makeDb(withCreds: boolean): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null)');
  db.exec('create table canvas_sync_state (key text primary key, value text not null)');
  if (withCreds) {
    setCanvasBaseUrl(db, 'uncw.instructure.com');
    setCanvasToken(db, 'test-token');
  }
  return db;
}

beforeEach(() => {
  listeners.clear();
  vi.mocked(syncCore).mockReset();
  vi.mocked(syncCore).mockResolvedValue({ ok: true, coursesSynced: 0, tokenInvalid: false, errors: [] });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startCanvasScheduler', () => {
  it('syncs once on start when credentials exist', async () => {
    const scheduler = startCanvasScheduler(makeDb(true), () => null);
    await vi.runOnlyPendingTimersAsync();
    expect(syncCore).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('does not sync when credentials are missing', async () => {
    const scheduler = startCanvasScheduler(makeDb(false), () => null);
    await vi.runOnlyPendingTimersAsync();
    expect(syncCore).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('never runs two syncs concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(syncCore).mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 50));
      inFlight -= 1;
      return { ok: true, coursesSynced: 0, tokenInvalid: false, errors: [] };
    });
    const scheduler = startCanvasScheduler(makeDb(true), () => null);

    const first = scheduler.syncNow();
    const second = scheduler.syncNow();
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([first, second]);

    expect(maxInFlight).toBe(1);
    scheduler.stop();
  });

  it('syncs again after the background interval elapses', async () => {
    const scheduler = startCanvasScheduler(makeDb(true), () => null);
    await vi.runOnlyPendingTimersAsync();
    expect(syncCore).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(syncCore).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('throttles focus-triggered syncs to once per five minutes', async () => {
    const scheduler = startCanvasScheduler(makeDb(true), () => null);
    await vi.runOnlyPendingTimersAsync();
    expect(syncCore).toHaveBeenCalledTimes(1);

    const onFocus = listeners.get('browser-window-focus');
    expect(onFocus).toBeDefined();

    onFocus?.();
    onFocus?.();
    await vi.runOnlyPendingTimersAsync();
    expect(syncCore).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
    onFocus?.();
    await vi.runOnlyPendingTimersAsync();
    expect(syncCore).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it('stops scheduling after stop() is called', async () => {
    const scheduler = startCanvasScheduler(makeDb(true), () => null);
    await vi.runOnlyPendingTimersAsync();
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(syncCore).toHaveBeenCalledTimes(1);
  });

  it('notifies the renderer after a sync completes', async () => {
    const send = vi.fn();
    const scheduler = startCanvasScheduler(makeDb(true), () => ({ webContents: { send } }) as never);
    await vi.runOnlyPendingTimersAsync();

    expect(send).toHaveBeenCalledWith('canvas:sync-changed');
    scheduler.stop();
  });

  it('survives a sync that throws without wedging the in-flight guard', async () => {
    vi.mocked(syncCore).mockRejectedValueOnce(new Error('boom'));
    const scheduler = startCanvasScheduler(makeDb(true), () => null);
    await vi.runOnlyPendingTimersAsync();

    vi.mocked(syncCore).mockResolvedValue({ ok: true, coursesSynced: 1, tokenInvalid: false, errors: [] });
    await scheduler.syncNow();

    expect(syncCore).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test -- src/main/canvas/scheduler.test.ts`
Expected: FAIL with `Failed to resolve import "./scheduler"`.

- [ ] **Step 4: Implement `scheduler.ts`**

Create `src/main/canvas/scheduler.ts`:

```ts
import { app, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { syncCore } from './sync';
import { getCanvasCredentials } from './token';

const BACKGROUND_INTERVAL_MS = 30 * 60 * 1000;
const FOCUS_THROTTLE_MS = 5 * 60 * 1000;

export interface CanvasScheduler {
  syncNow(): Promise<void>;
  stop(): void;
}

export function startCanvasScheduler(
  db: Database.Database,
  getWindow: () => BrowserWindow | null
): CanvasScheduler {
  // Single in-flight guard. Checked and set synchronously before the first
  // await so two callers can never interleave a sync.
  // ponytail: one boolean is enough — there is exactly one Canvas account.
  let syncing = false;
  // Seeded to "now" because the scheduler syncs immediately on start — the
  // first focus a moment later must not trigger a second sync.
  let lastFocusSync = Date.now();
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | null = null;

  async function run(): Promise<void> {
    if (syncing || stopped) return;
    const creds = getCanvasCredentials(db);
    if (creds === null) return;
    syncing = true;
    try {
      await syncCore(db, creds);
      getWindow()?.webContents.send('canvas:sync-changed');
    } catch {
      // syncCore already records failures in canvas_sync_state; a throw here
      // must still release the guard, which the finally block guarantees.
    } finally {
      syncing = false;
    }
  }

  function onFocus(): void {
    const now = Date.now();
    if (now - lastFocusSync < FOCUS_THROTTLE_MS) return;
    lastFocusSync = now;
    void run();
  }

  app.on('browser-window-focus', onFocus);
  interval = setInterval(() => void run(), BACKGROUND_INTERVAL_MS);
  void run();

  return {
    syncNow: run,
    stop(): void {
      stopped = true;
      if (interval !== null) clearInterval(interval);
      interval = null;
      app.removeListener?.('browser-window-focus', onFocus);
    },
  };
}
```

Note: the test's `electron` mock provides only `app.on`, so `removeListener` is called optionally.

- [ ] **Step 5: Run the scheduler test to verify it passes**

Run: `npm run test -- src/main/canvas/scheduler.test.ts`
Expected: PASS, 8/8 tests.

- [ ] **Step 6: Implement `ipc.ts`**

Create `src/main/canvas/ipc.ts`:

```ts
import { ipcMain, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import {
  clearCanvasToken,
  getCanvasCredentials,
  setCanvasBaseUrl,
  setCanvasToken,
} from './token';
import { getSelf } from './api';
import { fetchPageBody, syncCourseContent } from './sync';
import { openCanvasFile } from './files';
import {
  getCourseDetail,
  getCourseGrades,
  getPageBody,
  getRecentAnnouncements,
  getSyncStatus,
  getUpcomingAssignments,
  searchMaterials,
} from './queries';
import type { CanvasScheduler } from './scheduler';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerCanvasIpcHandlers(
  db: Database.Database,
  getWindow: () => BrowserWindow | null,
  scheduler: CanvasScheduler
): void {
  ipcMain.handle('canvas:get-status', () => getSyncStatus(db));

  ipcMain.handle('canvas:set-base-url', (_event, url: string) => {
    setCanvasBaseUrl(db, url);
  });

  ipcMain.handle('canvas:set-token', (_event, token: string) => {
    setCanvasToken(db, token);
  });

  ipcMain.handle('canvas:clear-token', () => {
    clearCanvasToken(db);
  });

  ipcMain.handle('canvas:test-connection', async () => {
    const creds = getCanvasCredentials(db);
    if (creds === null) {
      return { ok: false, error: 'Add both the Canvas URL and an access token first.' };
    }
    try {
      const user = await getSelf(creds);
      return { ok: true, name: user.name };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle('canvas:sync-now', async () => {
    await scheduler.syncNow();
    return getSyncStatus(db);
  });

  ipcMain.handle('canvas:get-upcoming', (_event, days: number) => getUpcomingAssignments(db, days));
  ipcMain.handle('canvas:get-grades', () => getCourseGrades(db));
  ipcMain.handle('canvas:get-announcements', (_event, limit: number) => getRecentAnnouncements(db, limit));
  ipcMain.handle('canvas:get-course', (_event, courseId: number) => getCourseDetail(db, courseId));
  ipcMain.handle('canvas:search-materials', (_event, query: string) => searchMaterials(db, query));

  ipcMain.handle('canvas:sync-course', async (_event, courseId: number) => {
    const creds = getCanvasCredentials(db);
    if (creds === null) return { ok: false, tokenInvalid: false, errors: ['Canvas is not connected.'] };
    const result = await syncCourseContent(db, creds, courseId);
    getWindow()?.webContents.send('canvas:sync-changed');
    return result;
  });

  ipcMain.handle('canvas:get-page', async (_event, courseId: number, pageUrl: string) => {
    const cached = getPageBody(db, courseId, pageUrl);
    if (cached && cached.body !== null) return cached;
    const creds = getCanvasCredentials(db);
    if (creds === null) return cached;
    await fetchPageBody(db, creds, courseId, pageUrl);
    return getPageBody(db, courseId, pageUrl);
  });

  ipcMain.handle('canvas:open-file', async (_event, fileId: number) => {
    const creds = getCanvasCredentials(db);
    if (creds === null) return { ok: false, error: 'Canvas is not connected.' };
    try {
      await openCanvasFile(db, creds, fileId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });
}
```

- [ ] **Step 7: Widen the CSP for Canvas images**

Replace the contents of `src/main/csp.ts`:

```ts
// Canvas serves announcement and page images from the institution's host.
// Without this, `default-src 'self'` silently blocks every embedded image.
const CANVAS_IMG = "img-src 'self' data: https://*.instructure.com";

export function buildCsp(isDev: boolean): string {
  if (isDev) {
    return (
      "default-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
      "style-src 'self' 'unsafe-inline'; " +
      `${CANVAS_IMG}; ` +
      "connect-src 'self' ws://localhost:*"
    );
  }
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ${CANVAS_IMG}`;
}
```

Add these cases to `src/main/csp.test.ts` (create the file with this content if it does not already exist):

```ts
import { describe, expect, it } from 'vitest';
import { buildCsp } from './csp';

describe('buildCsp', () => {
  it('allows Canvas-hosted images in production', () => {
    expect(buildCsp(false)).toContain("img-src 'self' data: https://*.instructure.com");
  });

  it('allows Canvas-hosted images in development', () => {
    expect(buildCsp(true)).toContain("img-src 'self' data: https://*.instructure.com");
  });

  it('never relaxes script-src in production', () => {
    expect(buildCsp(false)).toContain("script-src 'self'");
    expect(buildCsp(false)).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});
```

- [ ] **Step 8: Wire the scheduler and handlers into `src/main/index.ts`**

Add these imports alongside the existing ones:

```ts
import { registerCanvasIpcHandlers } from './canvas/ipc';
import { startCanvasScheduler, type CanvasScheduler } from './canvas/scheduler';
```

Add a module-scoped variable next to `let dbConnection`:

```ts
  let canvasScheduler: CanvasScheduler | null = null;
```

Inside `loadContent`, in the `if (!handlersRegistered)` block, add the two Canvas lines after `registerAiIpcHandlers(...)`:

```ts
        dbConnection = openDb();
        registerIpcHandlers(dbConnection, () => mainWindow);
        registerAiIpcHandlers(dbConnection, () => mainWindow);
        canvasScheduler = startCanvasScheduler(dbConnection, () => mainWindow);
        registerCanvasIpcHandlers(dbConnection, () => mainWindow, canvasScheduler);
        handlersRegistered = true;
```

And in the existing `before-quit` handler, stop the scheduler before closing the DB:

```ts
  app.on('before-quit', () => {
    canvasScheduler?.stop();
    dbConnection?.close();
  });
```

- [ ] **Step 9: Add the `canvas` surface to the preload bridge**

In `src/preload/index.ts`, add these interfaces above the `smartlife` object:

```ts
interface CanvasSyncStatus {
  tokenConfigured: boolean;
  baseUrlConfigured: boolean;
  lastSyncedAt: string | null;
  tokenInvalid: boolean;
  tokenAgeDays: number | null;
  tokenExpiringSoon: boolean;
}

interface CanvasActionResult {
  ok: boolean;
  error?: string;
  name?: string;
}
```

Then add this `canvas` block to the `smartlife` object, after the existing `ai` block:

```ts
  canvas: {
    getStatus: (): Promise<CanvasSyncStatus> => ipcRenderer.invoke('canvas:get-status'),
    setBaseUrl: (url: string): Promise<void> => ipcRenderer.invoke('canvas:set-base-url', url),
    setToken: (token: string): Promise<void> => ipcRenderer.invoke('canvas:set-token', token),
    clearToken: (): Promise<void> => ipcRenderer.invoke('canvas:clear-token'),
    testConnection: (): Promise<CanvasActionResult> => ipcRenderer.invoke('canvas:test-connection'),
    syncNow: (): Promise<CanvasSyncStatus> => ipcRenderer.invoke('canvas:sync-now'),
    getUpcoming: (days: number): Promise<unknown[]> => ipcRenderer.invoke('canvas:get-upcoming', days),
    getGrades: (): Promise<unknown[]> => ipcRenderer.invoke('canvas:get-grades'),
    getAnnouncements: (limit: number): Promise<unknown[]> =>
      ipcRenderer.invoke('canvas:get-announcements', limit),
    getCourse: (courseId: number): Promise<unknown> => ipcRenderer.invoke('canvas:get-course', courseId),
    syncCourse: (courseId: number): Promise<unknown> => ipcRenderer.invoke('canvas:sync-course', courseId),
    getPage: (courseId: number, pageUrl: string): Promise<unknown> =>
      ipcRenderer.invoke('canvas:get-page', courseId, pageUrl),
    openFile: (fileId: number): Promise<CanvasActionResult> => ipcRenderer.invoke('canvas:open-file', fileId),
    searchMaterials: (query: string): Promise<unknown[]> =>
      ipcRenderer.invoke('canvas:search-materials', query),
    onSyncChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      ipcRenderer.on('canvas:sync-changed', listener);
      return () => ipcRenderer.removeListener('canvas:sync-changed', listener);
    },
  },
```

- [ ] **Step 10: Stub the new bridge methods in the two existing renderer test mocks**

`src/renderer/src/App.test.tsx` and `src/renderer/src/theme/ThemeProvider.test.tsx` each construct a full `window.smartlife` mock. Because `SmartlifeApi` is derived from the preload object with `typeof`, **`npm run typecheck` fails if these mocks omit the new `canvas` key** — this exact failure cost a fix round in Phase 2 Task 5.

Add this block to the mock object in **both** files, alongside the existing `ai` block:

```ts
      canvas: {
        getStatus: vi.fn().mockResolvedValue({
          tokenConfigured: false,
          baseUrlConfigured: false,
          lastSyncedAt: null,
          tokenInvalid: false,
          tokenAgeDays: null,
          tokenExpiringSoon: false,
        }),
        setBaseUrl: vi.fn(),
        setToken: vi.fn(),
        clearToken: vi.fn(),
        testConnection: vi.fn(),
        syncNow: vi.fn(),
        getUpcoming: vi.fn().mockResolvedValue([]),
        getGrades: vi.fn().mockResolvedValue([]),
        getAnnouncements: vi.fn().mockResolvedValue([]),
        getCourse: vi.fn().mockResolvedValue(null),
        syncCourse: vi.fn(),
        getPage: vi.fn().mockResolvedValue(null),
        openFile: vi.fn(),
        searchMaterials: vi.fn().mockResolvedValue([]),
        onSyncChanged: vi.fn().mockReturnValue(() => {}),
      },
```

- [ ] **Step 11: Run the full check chain**

Run: `npm run lint && npm run typecheck && npm run test && npm run build`
Expected: all four exit 0. If `typecheck` reports a missing property on the `window.smartlife` mocks, Step 10 was incomplete — the mock must name every method added in Step 9.

- [ ] **Step 12: Verify the built main process still boots**

Run: `npx electron -e "require('./out/main/index.js')" 2>&1 | head -20` with `ELECTRON_RUN_AS_NODE=1` set.
Expected: no `ERR_REQUIRE_ESM` and no module-resolution error. (Phase 2 shipped a boot-crashing import that every test passed through; this smoke check is why it was caught.)

- [ ] **Step 13: Commit**

```bash
git add src/main/canvas/token.ts src/main/canvas/scheduler.ts src/main/canvas/scheduler.test.ts \
        src/main/canvas/ipc.ts src/main/csp.ts src/main/csp.test.ts src/main/index.ts \
        src/preload/index.ts src/renderer/src/App.test.tsx src/renderer/src/theme/ThemeProvider.test.tsx
git commit -m "Task 5: Canvas scheduler, IPC handlers, preload surface, and CSP"
```

---

### Task 6: School home view

**Files:**
- Create: `src/renderer/src/school/types.ts`
- Create: `src/renderer/src/school/sanitizeHtml.ts`
- Create: `src/renderer/src/school/formatters.ts`
- Create: `src/renderer/src/school/useCanvas.ts`
- Create: `src/renderer/src/school/TokenBanner.tsx`
- Create: `src/renderer/src/school/SyncStatus.tsx`
- Create: `src/renderer/src/school/DueSoon.tsx`
- Create: `src/renderer/src/school/GradeStrip.tsx`
- Create: `src/renderer/src/routes/School.tsx`
- Modify: `src/renderer/src/App.tsx`
- Test: `src/renderer/src/school/sanitizeHtml.test.ts`
- Test: `src/renderer/src/school/formatters.test.ts`
- Test: `src/renderer/src/routes/School.test.tsx`

**Interfaces:**
- Consumes: `window.smartlife.canvas.*` from Task 5.
- Produces:
  - `sanitizeHtml(html: string): string`
  - `formatRelative(iso: string | null, now?: Date): string`, `formatDue(iso: string, now?: Date): string`
  - `useCanvas(): { status: CanvasSyncStatus | null; upcoming: UpcomingAssignment[]; grades: CourseGrade[]; announcements: AnnouncementRow[]; syncing: boolean; refresh: () => Promise<void> }`
  - `<School />`, and the shared components `<TokenBanner />`, `<SyncStatus />`, `<DueSoon />`, `<GradeStrip />` reused by Task 7.
  - Route `/school`.

**Constraints specific to this task:**
- **Announcement and page HTML is written by instructors and must be sanitized before rendering.** The dev CSP allows `unsafe-inline` scripts, so CSP alone is not sufficient. `sanitizeHtml` is a trust boundary — it must strip `script`/`iframe`/`object`/`embed`/`style`/`link`/`meta`/`form` elements, every `on*` attribute, and `javascript:` URLs. **Do not add a sanitizer dependency** — use the DOM's own `DOMParser`.
- The empty state follows the convention Phase 2 settled on: treat `null` (still loading) and `false` (confirmed absent) identically via a `!== true` check, so there is no flash of the wrong content.
- Colour comes only from `var(--color-*)` tokens plus the `school` section accent `#3B82F6`; Tailwind is for layout only.

- [ ] **Step 1: Write the failing sanitizer test**

Create `src/renderer/src/school/sanitizeHtml.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from './sanitizeHtml';

describe('sanitizeHtml', () => {
  it('keeps ordinary formatting', () => {
    expect(sanitizeHtml('<p>Read <strong>chapter 4</strong></p>')).toBe(
      '<p>Read <strong>chapter 4</strong></p>'
    );
  });

  it('removes script elements entirely', () => {
    expect(sanitizeHtml('<p>hi</p><script>alert(1)</script>')).toBe('<p>hi</p>');
  });

  it('removes iframes, objects, embeds, and forms', () => {
    const dirty = '<iframe src="x"></iframe><object></object><embed><form></form><p>ok</p>';
    expect(sanitizeHtml(dirty)).toBe('<p>ok</p>');
  });

  it('strips inline event handlers', () => {
    const result = sanitizeHtml('<img src="https://uncw.instructure.com/a.png" onerror="alert(1)">');
    expect(result).not.toContain('onerror');
    expect(result).toContain('src="https://uncw.instructure.com/a.png"');
  });

  it('strips javascript: URLs from links', () => {
    const result = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(result).not.toContain('javascript:');
    expect(result).toContain('click');
  });

  it('keeps Canvas image sources so the CSP allowance is useful', () => {
    const result = sanitizeHtml('<img src="https://uncw.instructure.com/files/1/preview">');
    expect(result).toContain('https://uncw.instructure.com/files/1/preview');
  });

  it('returns an empty string for empty input', () => {
    expect(sanitizeHtml('')).toBe('');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- src/renderer/src/school/sanitizeHtml.test.ts`
Expected: FAIL with `Failed to resolve import "./sanitizeHtml"`.

- [ ] **Step 3: Implement `sanitizeHtml.ts`**

Create `src/renderer/src/school/sanitizeHtml.ts`:

```ts
/**
 * Canvas announcement and page bodies are authored by instructors — untrusted
 * third-party HTML. The dev CSP permits inline scripts, so this sanitizer is
 * the primary defence, not a decoration.
 * ponytail: DOMParser + a removal pass beats pulling in a sanitizer dependency.
 */
const FORBIDDEN = 'script,iframe,object,embed,style,link,meta,form,base';

export function sanitizeHtml(html: string): string {
  if (html.length === 0) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');

  for (const element of Array.from(doc.querySelectorAll(FORBIDDEN))) {
    element.remove();
  }

  for (const element of Array.from(doc.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (
        (name === 'href' || name === 'src' || name === 'xlink:href') &&
        /^\s*javascript:/i.test(attribute.value)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return doc.body.innerHTML;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run test -- src/renderer/src/school/sanitizeHtml.test.ts`
Expected: PASS, 7/7 tests.

- [ ] **Step 5: Write the failing formatters test**

Create `src/renderer/src/school/formatters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatDue, formatRelative } from './formatters';

const NOW = new Date('2026-08-18T12:00:00Z');

describe('formatRelative', () => {
  it('reports never for a null timestamp', () => {
    expect(formatRelative(null, NOW)).toBe('never');
  });

  it('reports just now for the last minute', () => {
    expect(formatRelative('2026-08-18T11:59:30Z', NOW)).toBe('just now');
  });

  it('reports whole minutes and hours', () => {
    expect(formatRelative('2026-08-18T11:57:00Z', NOW)).toBe('3 min ago');
    expect(formatRelative('2026-08-18T09:00:00Z', NOW)).toBe('3 hr ago');
  });

  it('reports days beyond 24 hours', () => {
    expect(formatRelative('2026-08-16T12:00:00Z', NOW)).toBe('2 days ago');
  });

  it('uses a singular day', () => {
    expect(formatRelative('2026-08-17T12:00:00Z', NOW)).toBe('1 day ago');
  });
});

describe('formatDue', () => {
  it('flags something due within the hour', () => {
    expect(formatDue('2026-08-18T12:30:00Z', NOW)).toBe('due in 30 min');
  });

  it('flags something due today in hours', () => {
    expect(formatDue('2026-08-18T18:00:00Z', NOW)).toBe('due in 6 hr');
  });

  it('counts whole days further out', () => {
    expect(formatDue('2026-08-21T12:00:00Z', NOW)).toBe('due in 3 days');
  });

  it('marks a past due date as overdue', () => {
    expect(formatDue('2026-08-17T12:00:00Z', NOW)).toBe('overdue');
  });
});
```

- [ ] **Step 6: Implement `formatters.ts`**

Create `src/renderer/src/school/formatters.ts`:

```ts
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function formatRelative(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return 'never';
  const elapsed = now.getTime() - Date.parse(iso);
  if (Number.isNaN(elapsed)) return 'never';
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} hr ago`;
  const days = Math.floor(elapsed / DAY);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

export function formatDue(iso: string, now: Date = new Date()): string {
  const remaining = Date.parse(iso) - now.getTime();
  if (Number.isNaN(remaining)) return '';
  if (remaining < 0) return 'overdue';
  if (remaining < HOUR) return `due in ${Math.max(1, Math.floor(remaining / MINUTE))} min`;
  if (remaining < DAY) return `due in ${Math.floor(remaining / HOUR)} hr`;
  const days = Math.floor(remaining / DAY);
  return days === 1 ? 'due in 1 day' : `due in ${days} days`;
}
```

- [ ] **Step 7: Run the formatters test to verify it passes**

Run: `npm run test -- src/renderer/src/school/formatters.test.ts`
Expected: PASS, 9/9 tests.

- [ ] **Step 8: Create the renderer-side types**

Create `src/renderer/src/school/types.ts`:

```ts
export interface CanvasSyncStatus {
  tokenConfigured: boolean;
  baseUrlConfigured: boolean;
  lastSyncedAt: string | null;
  tokenInvalid: boolean;
  tokenAgeDays: number | null;
  tokenExpiringSoon: boolean;
}

export interface UpcomingAssignment {
  id: number;
  courseId: number;
  courseName: string;
  name: string;
  dueAt: string;
  pointsPossible: number | null;
  hasSubmitted: boolean;
  htmlUrl: string | null;
}

export interface CourseGrade {
  id: number;
  name: string;
  courseCode: string | null;
  currentScore: number | null;
  currentGrade: string | null;
}

export interface AnnouncementRow {
  id: number;
  courseId: number;
  courseName: string;
  title: string | null;
  message: string | null;
  postedAt: string | null;
}

export interface CourseAssignment {
  id: number;
  name: string;
  dueAt: string | null;
  pointsPossible: number | null;
  hasSubmitted: boolean;
  score: number | null;
  grade: string | null;
  htmlUrl: string | null;
}

export interface ModuleItemRow {
  id: number;
  title: string | null;
  type: string | null;
  contentId: number | null;
  pageUrl: string | null;
  externalUrl: string | null;
}

export interface ModuleWithItems {
  id: number;
  name: string | null;
  items: ModuleItemRow[];
}

export interface FileRow {
  id: number;
  displayName: string | null;
  contentType: string | null;
  size: number | null;
}

export interface CourseDetail {
  course: CourseGrade;
  assignments: CourseAssignment[];
  modules: ModuleWithItems[];
  files: FileRow[];
  announcements: AnnouncementRow[];
  contentSyncedAt: string | null;
}

export const SCHOOL_ACCENT = '#3B82F6';
```

- [ ] **Step 9: Implement the `useCanvas` hook**

Create `src/renderer/src/school/useCanvas.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import type { AnnouncementRow, CanvasSyncStatus, CourseGrade, UpcomingAssignment } from './types';

const UPCOMING_WINDOW_DAYS = 14;
const ANNOUNCEMENT_LIMIT = 5;

export function useCanvas(): {
  status: CanvasSyncStatus | null;
  upcoming: UpcomingAssignment[];
  grades: CourseGrade[];
  announcements: AnnouncementRow[];
  syncing: boolean;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<CanvasSyncStatus | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingAssignment[]>([]);
  const [grades, setGrades] = useState<CourseGrade[]>([]);
  const [announcements, setAnnouncements] = useState<AnnouncementRow[]>([]);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const [nextStatus, nextUpcoming, nextGrades, nextAnnouncements] = await Promise.all([
      window.smartlife.canvas.getStatus(),
      window.smartlife.canvas.getUpcoming(UPCOMING_WINDOW_DAYS),
      window.smartlife.canvas.getGrades(),
      window.smartlife.canvas.getAnnouncements(ANNOUNCEMENT_LIMIT),
    ]);
    setStatus(nextStatus as CanvasSyncStatus);
    setUpcoming(nextUpcoming as UpcomingAssignment[]);
    setGrades(nextGrades as CourseGrade[]);
    setAnnouncements(nextAnnouncements as AnnouncementRow[]);
  }, []);

  useEffect(() => {
    void load().catch(() => {});
    return window.smartlife.canvas.onSyncChanged(() => {
      void load().catch(() => {});
    });
  }, [load]);

  const refresh = useCallback(async (): Promise<void> => {
    setSyncing(true);
    try {
      await window.smartlife.canvas.syncNow();
      await load();
    } catch {
      // The status row surfaces staleness; a failed manual refresh needs no modal.
    } finally {
      setSyncing(false);
    }
  }, [load]);

  return { status, upcoming, grades, announcements, syncing, refresh };
}
```

- [ ] **Step 10: Implement the presentational components**

Create `src/renderer/src/school/TokenBanner.tsx`:

```tsx
import type { CanvasSyncStatus } from './types';

export function TokenBanner({ status }: { status: CanvasSyncStatus }): React.JSX.Element | null {
  if (status.tokenInvalid) {
    return (
      <div
        className="rounded-lg px-4 py-3 text-sm"
        style={{ backgroundColor: 'var(--color-surface)', border: '1px solid #F87171', color: 'var(--color-text)' }}
      >
        <strong>Your Canvas token has expired.</strong> Showing the last data that synced. Generate a
        new token in Canvas under Account → Settings → Approved Integrations, then paste it into
        Settings.
      </div>
    );
  }

  if (status.tokenExpiringSoon) {
    return (
      <div
        className="rounded-lg px-4 py-3 text-sm"
        style={{ backgroundColor: 'var(--color-surface)', border: '1px solid #FBBF24', color: 'var(--color-text)' }}
      >
        Your Canvas token is {status.tokenAgeDays} days old and expires at 90. Generate a
        replacement before it lapses.
      </div>
    );
  }

  return null;
}
```

Create `src/renderer/src/school/SyncStatus.tsx`:

```tsx
import { formatRelative } from './formatters';
import type { CanvasSyncStatus } from './types';

export function SyncStatus({
  status,
  syncing,
  onRefresh,
}: {
  status: CanvasSyncStatus;
  syncing: boolean;
  onRefresh: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span style={{ color: 'var(--color-text-muted)' }}>
        Synced {formatRelative(status.lastSyncedAt)}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={syncing}
        className="rounded-md px-2.5 py-1 text-xs"
        style={{
          backgroundColor: 'var(--color-surface)',
          color: 'var(--color-text)',
          border: '1px solid var(--color-border)',
          opacity: syncing ? 0.6 : 1,
        }}
      >
        {syncing ? 'Syncing…' : 'Refresh'}
      </button>
    </div>
  );
}
```

Create `src/renderer/src/school/DueSoon.tsx`:

```tsx
import { formatDue } from './formatters';
import { SCHOOL_ACCENT, type UpcomingAssignment } from './types';

export function DueSoon({ items }: { items: UpcomingAssignment[] }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
        Due soon
      </h2>
      {items.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>Nothing due in the next two weeks.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between rounded-lg px-3 py-2"
              style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
            >
              <div className="flex flex-col">
                <span style={{ color: 'var(--color-text)' }}>{item.name}</span>
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {item.courseName}
                </span>
              </div>
              <span
                className="text-xs"
                style={{ color: item.hasSubmitted ? 'var(--color-text-muted)' : SCHOOL_ACCENT }}
              >
                {item.hasSubmitted ? 'submitted' : formatDue(item.dueAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

Create `src/renderer/src/school/GradeStrip.tsx`:

```tsx
import { Link } from 'react-router-dom';
import type { CourseGrade } from './types';

export function GradeStrip({ courses }: { courses: CourseGrade[] }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
        Courses
      </h2>
      {courses.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>No courses synced yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {courses.map((course) => (
            <li key={course.id}>
              <Link
                to={`/school/course/${course.id}`}
                className="flex items-center justify-between rounded-lg px-3 py-2"
                style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
              >
                <div className="flex flex-col">
                  <span style={{ color: 'var(--color-text)' }}>{course.name}</span>
                  {course.courseCode && (
                    <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      {course.courseCode}
                    </span>
                  )}
                </div>
                <span style={{ color: 'var(--color-text)' }}>
                  {course.currentScore === null
                    ? '—'
                    : `${course.currentScore}%${course.currentGrade ? ` (${course.currentGrade})` : ''}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 11: Write the failing School route test**

Create `src/renderer/src/routes/School.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { School } from './School';

const canvas = {
  getStatus: vi.fn(),
  getUpcoming: vi.fn(),
  getGrades: vi.fn(),
  getAnnouncements: vi.fn(),
  syncNow: vi.fn(),
  onSyncChanged: vi.fn().mockReturnValue(() => {}),
};

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tokenConfigured: true,
    baseUrlConfigured: true,
    lastSyncedAt: new Date().toISOString(),
    tokenInvalid: false,
    tokenAgeDays: 2,
    tokenExpiringSoon: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal('window', window);
  Object.defineProperty(window, 'smartlife', { value: { canvas }, writable: true, configurable: true });
  canvas.getStatus.mockResolvedValue(status());
  canvas.getUpcoming.mockResolvedValue([]);
  canvas.getGrades.mockResolvedValue([]);
  canvas.getAnnouncements.mockResolvedValue([]);
});

function renderSchool(): void {
  render(
    <MemoryRouter>
      <School />
    </MemoryRouter>
  );
}

describe('School', () => {
  it('shows the connect prompt while status is still loading', () => {
    renderSchool();
    expect(screen.getByText(/connect canvas/i)).toBeInTheDocument();
  });

  it('shows the connect prompt when no token is configured', async () => {
    canvas.getStatus.mockResolvedValue(status({ tokenConfigured: false }));
    renderSchool();
    expect(await screen.findByText(/connect canvas/i)).toBeInTheDocument();
  });

  it('shows the connect prompt when the base URL is missing', async () => {
    canvas.getStatus.mockResolvedValue(status({ baseUrlConfigured: false }));
    renderSchool();
    expect(await screen.findByText(/connect canvas/i)).toBeInTheDocument();
  });

  it('renders due-soon items once connected', async () => {
    canvas.getUpcoming.mockResolvedValue([
      {
        id: 1,
        courseId: 101,
        courseName: 'Statistics',
        name: 'Problem Set 3',
        dueAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        pointsPossible: 20,
        hasSubmitted: false,
        htmlUrl: null,
      },
    ]);
    renderSchool();

    expect(await screen.findByText('Problem Set 3')).toBeInTheDocument();
    expect(screen.getByText('Statistics')).toBeInTheDocument();
  });

  it('renders course grades', async () => {
    canvas.getGrades.mockResolvedValue([
      { id: 101, name: 'Statistics', courseCode: 'STT 215', currentScore: 91.5, currentGrade: 'A-' },
    ]);
    renderSchool();

    expect(await screen.findByText('STT 215')).toBeInTheDocument();
    expect(screen.getByText('91.5% (A-)')).toBeInTheDocument();
  });

  it('shows the expired-token banner while still listing cached work', async () => {
    canvas.getStatus.mockResolvedValue(status({ tokenInvalid: true }));
    canvas.getGrades.mockResolvedValue([
      { id: 101, name: 'Statistics', courseCode: 'STT 215', currentScore: 91.5, currentGrade: 'A-' },
    ]);
    renderSchool();

    expect(await screen.findByText(/token has expired/i)).toBeInTheDocument();
    expect(screen.getByText('STT 215')).toBeInTheDocument();
  });

  it('warns when the token is close to its 90-day cap', async () => {
    canvas.getStatus.mockResolvedValue(status({ tokenExpiringSoon: true, tokenAgeDays: 85 }));
    renderSchool();
    expect(await screen.findByText(/85 days old/i)).toBeInTheDocument();
  });

  it('says so plainly when nothing is due', async () => {
    renderSchool();
    expect(await screen.findByText(/nothing due in the next two weeks/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 12: Implement `School.tsx`**

Create `src/renderer/src/routes/School.tsx`:

```tsx
import { useNavigate } from 'react-router-dom';
import { useCanvas } from '../school/useCanvas';
import { DueSoon } from '../school/DueSoon';
import { GradeStrip } from '../school/GradeStrip';
import { SyncStatus } from '../school/SyncStatus';
import { TokenBanner } from '../school/TokenBanner';
import { sanitizeHtml } from '../school/sanitizeHtml';
import { formatRelative } from '../school/formatters';

export function School(): React.JSX.Element {
  const { status, upcoming, grades, announcements, syncing, refresh } = useCanvas();
  const navigate = useNavigate();

  // null (loading) and an unconfigured connection render the same prompt, so
  // there is no flash of an empty dashboard before the status resolves.
  const connected = status !== null && status.tokenConfigured && status.baseUrlConfigured;

  if (!connected) {
    return (
      <div className="flex flex-col items-start gap-4 p-8">
        <h1 className="text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
          School
        </h1>
        <p style={{ color: 'var(--color-text-muted)' }}>
          Connect Canvas to see what is due, your current grades, and your course materials.
        </p>
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="rounded-md px-3 py-1.5 text-sm"
          style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
        >
          Go to Settings
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
          School
        </h1>
        <SyncStatus status={status} syncing={syncing} onRefresh={() => void refresh()} />
      </div>

      <TokenBanner status={status} />
      <DueSoon items={upcoming} />
      <GradeStrip courses={grades} />

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
          Announcements
        </h2>
        {announcements.length === 0 ? (
          <p style={{ color: 'var(--color-text-muted)' }}>No recent announcements.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {announcements.map((announcement) => (
              <li
                key={announcement.id}
                className="rounded-lg px-3 py-2"
                style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span style={{ color: 'var(--color-text)' }}>{announcement.title ?? 'Untitled'}</span>
                  <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {announcement.courseName} · {formatRelative(announcement.postedAt)}
                  </span>
                </div>
                {announcement.message && (
                  <div
                    className="mt-1 text-sm"
                    style={{ color: 'var(--color-text-muted)' }}
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(announcement.message) }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 13: Wire the route in `App.tsx`**

In `src/renderer/src/App.tsx`, add the import:

```tsx
import { School } from './routes/School';
```

Replace the existing `/school` route (currently rendering `ComingSoon`) with:

```tsx
        <Route path="/school" element={<School />} />
```

- [ ] **Step 14: Run the School test to verify it passes**

Run: `npm run test -- src/renderer/src/routes/School.test.tsx`
Expected: PASS, 8/8 tests.

- [ ] **Step 15: Run the full check chain**

Run: `npm run lint && npm run typecheck && npm run test && npm run build`
Expected: all four exit 0.

- [ ] **Step 16: Commit**

```bash
git add src/renderer/src/school src/renderer/src/routes/School.tsx src/renderer/src/routes/School.test.tsx src/renderer/src/App.tsx
git commit -m "Task 6: School home view with due-soon, grades, and announcements"
```

---

### Task 7: Course detail view and the Settings Canvas block

**Files:**
- Modify: `src/main/canvas/ipc.ts` (add `canvas:open-external`)
- Modify: `src/preload/index.ts` (add `openExternal`)
- Modify: `src/renderer/src/App.test.tsx`, `src/renderer/src/theme/ThemeProvider.test.tsx` (stub `openExternal`)
- Create: `src/renderer/src/routes/Course.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/routes/Settings.tsx`
- Test: `src/renderer/src/routes/Course.test.tsx`
- Test: `src/renderer/src/routes/Settings.test.tsx` (this file exists — append the Canvas cases)

**Interfaces:**
- Consumes: `window.smartlife.canvas.*` from Task 5; `sanitizeHtml`, `formatDue`, `formatRelative`, `TokenBanner` and the types from Task 6.
- Produces: route `/school/course/:courseId`; the Canvas section of Settings; `window.smartlife.canvas.openExternal(url)`.

**Constraints specific to this task:**
- **`shell.openExternal` must only ever be handed an `http:` or `https:` URL.** These URLs come from Canvas, so a `file:` or custom-scheme value would be handing arbitrary local execution to third-party data. Validate the protocol in the main process, not the renderer.
- Opening a course for the first time triggers a tier-2 content sync; afterwards it serves from cache until the user refreshes.
- Page bodies render through `sanitizeHtml` — never raw.

- [ ] **Step 1: Add the external-link handler to `ipc.ts`**

Add `shell` to the existing electron import in `src/main/canvas/ipc.ts`:

```ts
import { ipcMain, shell, type BrowserWindow } from 'electron';
```

And add this handler inside `registerCanvasIpcHandlers`:

```ts
  ipcMain.handle('canvas:open-external', async (_event, url: string) => {
    // These URLs come from Canvas data. Anything other than http(s) — file:,
    // or a custom scheme registered by another app — must never be opened.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: 'That link is not a valid address.' };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, error: 'Only web links can be opened.' };
    }
    await shell.openExternal(parsed.toString());
    return { ok: true };
  });
```

- [ ] **Step 2: Add `openExternal` to the preload `canvas` block**

In `src/preload/index.ts`, add to the `canvas` object:

```ts
    openExternal: (url: string): Promise<CanvasActionResult> =>
      ipcRenderer.invoke('canvas:open-external', url),
```

Add `openExternal: vi.fn(),` to the `canvas` mock block in **both** `src/renderer/src/App.test.tsx` and `src/renderer/src/theme/ThemeProvider.test.tsx`.

- [ ] **Step 3: Write the failing Course test**

Create `src/renderer/src/routes/Course.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Course } from './Course';

const canvas = {
  getCourse: vi.fn(),
  syncCourse: vi.fn(),
  getPage: vi.fn(),
  openFile: vi.fn(),
  openExternal: vi.fn(),
  getStatus: vi.fn(),
  onSyncChanged: vi.fn().mockReturnValue(() => {}),
};

function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    course: { id: 101, name: 'Statistics', courseCode: 'STT 215', currentScore: 91.5, currentGrade: 'A-' },
    assignments: [],
    modules: [],
    files: [],
    announcements: [],
    contentSyncedAt: '2026-08-18T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'smartlife', { value: { canvas }, writable: true, configurable: true });
  canvas.getCourse.mockReset().mockResolvedValue(detail());
  canvas.syncCourse.mockReset().mockResolvedValue({ ok: true, tokenInvalid: false, errors: [] });
  canvas.getPage.mockReset();
  canvas.openFile.mockReset().mockResolvedValue({ ok: true });
  canvas.openExternal.mockReset().mockResolvedValue({ ok: true });
  canvas.getStatus.mockResolvedValue({
    tokenConfigured: true,
    baseUrlConfigured: true,
    lastSyncedAt: null,
    tokenInvalid: false,
    tokenAgeDays: 1,
    tokenExpiringSoon: false,
  });
});

function renderCourse(): void {
  render(
    <MemoryRouter initialEntries={['/school/course/101']}>
      <Routes>
        <Route path="/school/course/:courseId" element={<Course />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Course', () => {
  it('renders the course name and current grade', async () => {
    renderCourse();
    expect(await screen.findByText('Statistics')).toBeInTheDocument();
    expect(screen.getByText(/91.5%/)).toBeInTheDocument();
  });

  it('triggers a content sync the first time a course has never been synced', async () => {
    canvas.getCourse.mockResolvedValue(detail({ contentSyncedAt: null }));
    renderCourse();
    await waitFor(() => expect(canvas.syncCourse).toHaveBeenCalledWith(101));
  });

  it('does not re-sync a course whose content is already cached', async () => {
    renderCourse();
    await screen.findByText('Statistics');
    expect(canvas.syncCourse).not.toHaveBeenCalled();
  });

  it('lists modules with their items', async () => {
    canvas.getCourse.mockResolvedValue(
      detail({
        modules: [
          {
            id: 10,
            name: 'Week 1',
            items: [{ id: 1000, title: 'Syllabus', type: 'Page', contentId: null, pageUrl: 'syllabus', externalUrl: null }],
          },
        ],
      })
    );
    renderCourse();

    expect(await screen.findByText('Week 1')).toBeInTheDocument();
    expect(screen.getByText('Syllabus')).toBeInTheDocument();
  });

  it('opens a file through the main process when a file item is clicked', async () => {
    canvas.getCourse.mockResolvedValue(
      detail({ files: [{ id: 7, displayName: 'Lecture 1.pdf', contentType: 'application/pdf', size: 2048 }] })
    );
    renderCourse();

    await userEvent.click(await screen.findByText('Lecture 1.pdf'));

    expect(canvas.openFile).toHaveBeenCalledWith(7);
  });

  it('surfaces an error when opening a file fails', async () => {
    canvas.openFile.mockResolvedValue({ ok: false, error: 'Download failed with status 404.' });
    canvas.getCourse.mockResolvedValue(
      detail({ files: [{ id: 7, displayName: 'Lecture 1.pdf', contentType: 'application/pdf', size: 2048 }] })
    );
    renderCourse();

    await userEvent.click(await screen.findByText('Lecture 1.pdf'));

    expect(await screen.findByText(/download failed with status 404/i)).toBeInTheDocument();
  });

  it('fetches and renders a page body when a page item is clicked', async () => {
    canvas.getPage.mockResolvedValue({ title: 'Syllabus', body: '<p>Read chapter 1</p>' });
    canvas.getCourse.mockResolvedValue(
      detail({
        modules: [
          {
            id: 10,
            name: 'Week 1',
            items: [{ id: 1000, title: 'Syllabus', type: 'Page', contentId: null, pageUrl: 'syllabus', externalUrl: null }],
          },
        ],
      })
    );
    renderCourse();

    await userEvent.click(await screen.findByText('Syllabus'));

    await waitFor(() => expect(canvas.getPage).toHaveBeenCalledWith(101, 'syllabus'));
    expect(await screen.findByText('Read chapter 1')).toBeInTheDocument();
  });

  it('strips scripts out of page HTML before rendering', async () => {
    canvas.getPage.mockResolvedValue({ title: 'Syllabus', body: '<p>ok</p><script>alert(1)</script>' });
    canvas.getCourse.mockResolvedValue(
      detail({
        modules: [
          {
            id: 10,
            name: 'Week 1',
            items: [{ id: 1000, title: 'Syllabus', type: 'Page', contentId: null, pageUrl: 'syllabus', externalUrl: null }],
          },
        ],
      })
    );
    const { container } = render(
      <MemoryRouter initialEntries={['/school/course/101']}>
        <Routes>
          <Route path="/school/course/:courseId" element={<Course />} />
        </Routes>
      </MemoryRouter>
    );

    await userEvent.click(await screen.findByText('Syllabus'));

    await screen.findByText('ok');
    expect(container.querySelector('script')).toBeNull();
  });

  it('opens an external-link item through the main process', async () => {
    canvas.getCourse.mockResolvedValue(
      detail({
        modules: [
          {
            id: 10,
            name: 'Week 1',
            items: [
              {
                id: 1001,
                title: 'Course website',
                type: 'ExternalUrl',
                contentId: null,
                pageUrl: null,
                externalUrl: 'https://example.edu/stats',
              },
            ],
          },
        ],
      })
    );
    renderCourse();

    await userEvent.click(await screen.findByText('Course website'));

    expect(canvas.openExternal).toHaveBeenCalledWith('https://example.edu/stats');
  });

  it('lists assignments with their scores', async () => {
    canvas.getCourse.mockResolvedValue(
      detail({
        assignments: [
          {
            id: 555,
            name: 'Problem Set 3',
            dueAt: '2026-09-01T03:59:59Z',
            pointsPossible: 20,
            hasSubmitted: true,
            score: 18,
            grade: '18',
            htmlUrl: null,
          },
        ],
      })
    );
    renderCourse();

    expect(await screen.findByText('Problem Set 3')).toBeInTheDocument();
    expect(screen.getByText('18 / 20')).toBeInTheDocument();
  });

  it('reports a course that is not in the local mirror', async () => {
    canvas.getCourse.mockResolvedValue(null);
    renderCourse();
    expect(await screen.findByText(/course was not found/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm run test -- src/renderer/src/routes/Course.test.tsx`
Expected: FAIL with `Failed to resolve import "./Course"`.

- [ ] **Step 5: Implement `Course.tsx`**

Create `src/renderer/src/routes/Course.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { sanitizeHtml } from '../school/sanitizeHtml';
import { formatDue } from '../school/formatters';
import { SCHOOL_ACCENT, type CourseDetail, type ModuleItemRow } from '../school/types';

interface OpenPage {
  title: string | null;
  body: string | null;
}

export function Course(): React.JSX.Element {
  const { courseId } = useParams();
  const id = Number(courseId);
  const [detail, setDetail] = useState<CourseDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState<OpenPage | null>(null);

  const load = useCallback(async (): Promise<CourseDetail | null> => {
    const next = (await window.smartlife.canvas.getCourse(id)) as CourseDetail | null;
    setDetail(next);
    setLoaded(true);
    return next;
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const first = await load();
      // Tier-2 content is pulled the first time a course is opened, then cached.
      if (!cancelled && first !== null && first.contentSyncedAt === null) {
        await window.smartlife.canvas.syncCourse(id);
        if (!cancelled) await load();
      }
    })().catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [id, load]);

  async function openItem(item: ModuleItemRow): Promise<void> {
    setError('');
    if (item.type === 'Page' && item.pageUrl) {
      const result = (await window.smartlife.canvas.getPage(id, item.pageUrl)) as OpenPage | null;
      setPage(result ?? { title: item.title, body: null });
      return;
    }
    if (item.type === 'File' && item.contentId !== null) {
      const result = await window.smartlife.canvas.openFile(item.contentId);
      if (!result.ok) setError(result.error ?? 'Could not open that file.');
      return;
    }
    if (item.externalUrl) {
      const result = await window.smartlife.canvas.openExternal(item.externalUrl);
      if (!result.ok) setError(result.error ?? 'Could not open that link.');
    }
  }

  async function openFile(fileId: number): Promise<void> {
    setError('');
    const result = await window.smartlife.canvas.openFile(fileId);
    if (!result.ok) setError(result.error ?? 'Could not open that file.');
  }

  if (loaded && detail === null) {
    return (
      <div className="flex flex-col gap-3 p-8">
        <p style={{ color: 'var(--color-text)' }}>That course was not found in your synced data.</p>
        <Link to="/school" style={{ color: SCHOOL_ACCENT }}>
          Back to School
        </Link>
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="p-8">
        <p style={{ color: 'var(--color-text-muted)' }}>Loading…</p>
      </div>
    );
  }

  const rowStyle = {
    backgroundColor: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
  } as const;

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex flex-col gap-1">
        <Link to="/school" className="text-sm" style={{ color: SCHOOL_ACCENT }}>
          ← School
        </Link>
        <div className="flex items-baseline justify-between">
          <h1 className="text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
            {detail.course.name}
          </h1>
          <span style={{ color: 'var(--color-text)' }}>
            {detail.course.currentScore === null
              ? '—'
              : `${detail.course.currentScore}%${detail.course.currentGrade ? ` (${detail.course.currentGrade})` : ''}`}
          </span>
        </div>
        {detail.course.courseCode && (
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {detail.course.courseCode}
          </span>
        )}
      </div>

      {error && <p style={{ color: '#F87171' }}>{error}</p>}

      {page !== null && (
        <section className="flex flex-col gap-2 rounded-lg p-4" style={rowStyle}>
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold" style={{ color: 'var(--color-text)' }}>
              {page.title ?? 'Page'}
            </h2>
            <button
              type="button"
              onClick={() => setPage(null)}
              className="text-xs"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Close
            </button>
          </div>
          {page.body === null ? (
            <p style={{ color: 'var(--color-text-muted)' }}>This page has no content.</p>
          ) : (
            <div
              className="text-sm"
              style={{ color: 'var(--color-text)' }}
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(page.body) }}
            />
          )}
        </section>
      )}

      <Section title="Assignments">
        {detail.assignments.length === 0 ? (
          <Empty>No assignments synced.</Empty>
        ) : (
          detail.assignments.map((assignment) => (
            <div key={assignment.id} className="flex items-center justify-between rounded-lg px-3 py-2" style={rowStyle}>
              <div className="flex flex-col">
                <span style={{ color: 'var(--color-text)' }}>{assignment.name}</span>
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {assignment.dueAt ? formatDue(assignment.dueAt) : 'no due date'}
                </span>
              </div>
              <span className="text-sm" style={{ color: 'var(--color-text)' }}>
                {assignment.score === null
                  ? assignment.hasSubmitted
                    ? 'submitted'
                    : '—'
                  : `${assignment.score} / ${assignment.pointsPossible ?? '?'}`}
              </span>
            </div>
          ))
        )}
      </Section>

      <Section title="Modules">
        {detail.modules.length === 0 ? (
          <Empty>No modules synced.</Empty>
        ) : (
          detail.modules.map((module) => (
            <div key={module.id} className="flex flex-col gap-1.5 rounded-lg p-3" style={rowStyle}>
              <span className="font-medium" style={{ color: 'var(--color-text)' }}>
                {module.name ?? 'Untitled module'}
              </span>
              {module.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void openItem(item)}
                  className="text-left text-sm"
                  style={{ color: SCHOOL_ACCENT }}
                >
                  {item.title ?? 'Untitled'}
                </button>
              ))}
            </div>
          ))
        )}
      </Section>

      <Section title="Files">
        {detail.files.length === 0 ? (
          <Empty>No files synced.</Empty>
        ) : (
          detail.files.map((file) => (
            <button
              key={file.id}
              type="button"
              onClick={() => void openFile(file.id)}
              className="flex items-center justify-between rounded-lg px-3 py-2 text-left"
              style={rowStyle}
            >
              <span style={{ color: SCHOOL_ACCENT }}>{file.displayName ?? 'Untitled file'}</span>
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {file.contentType ?? ''}
              </span>
            </button>
          ))
        )}
      </Section>

      <Section title="Announcements">
        {detail.announcements.length === 0 ? (
          <Empty>No announcements.</Empty>
        ) : (
          detail.announcements.map((announcement) => (
            <div key={announcement.id} className="rounded-lg px-3 py-2" style={rowStyle}>
              <span style={{ color: 'var(--color-text)' }}>{announcement.title ?? 'Untitled'}</span>
              {announcement.message && (
                <div
                  className="mt-1 text-sm"
                  style={{ color: 'var(--color-text-muted)' }}
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(announcement.message) }}
                />
              )}
            </div>
          ))
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p style={{ color: 'var(--color-text-muted)' }}>{children}</p>;
}
```

- [ ] **Step 6: Add the route to `App.tsx`**

Add the import and the route:

```tsx
import { Course } from './routes/Course';
```

```tsx
        <Route path="/school/course/:courseId" element={<Course />} />
```

- [ ] **Step 7: Run the Course test to verify it passes**

Run: `npm run test -- src/renderer/src/routes/Course.test.tsx`
Expected: PASS, 11/11 tests.

- [ ] **Step 8: Add the Canvas block to Settings**

In `src/renderer/src/routes/Settings.tsx`, add this state alongside the existing hooks:

```tsx
  const [canvasUrlInput, setCanvasUrlInput] = useState('');
  const [canvasTokenInput, setCanvasTokenInput] = useState('');
  const [canvasStatus, setCanvasStatus] = useState<{ tokenConfigured: boolean; baseUrlConfigured: boolean } | null>(null);
  const [canvasMessage, setCanvasMessage] = useState('');
  const [canvasError, setCanvasError] = useState('');
```

Add this effect alongside the existing ones:

```tsx
  useEffect(() => {
    window.smartlife.canvas
      .getStatus()
      .then((status) => setCanvasStatus(status))
      .catch(() => {});
  }, []);
```

Add these handlers next to `handleSaveApiKey`:

```tsx
  async function handleSaveCanvas(): Promise<void> {
    setCanvasError('');
    setCanvasMessage('');
    try {
      if (canvasUrlInput.trim().length > 0) await window.smartlife.canvas.setBaseUrl(canvasUrlInput);
      if (canvasTokenInput.length > 0) await window.smartlife.canvas.setToken(canvasTokenInput);
      setCanvasUrlInput('');
      setCanvasTokenInput('');
      setCanvasStatus(await window.smartlife.canvas.getStatus());
      setCanvasMessage('Saved.');
    } catch (err) {
      setCanvasError(err instanceof Error ? err.message : 'Failed to save Canvas settings.');
    }
  }

  async function handleTestCanvas(): Promise<void> {
    setCanvasError('');
    setCanvasMessage('Testing…');
    const result = await window.smartlife.canvas.testConnection();
    if (result.ok) {
      setCanvasMessage(`Connected as ${result.name}.`);
    } else {
      setCanvasMessage('');
      setCanvasError(result.error ?? 'Could not reach Canvas.');
    }
  }

  async function handleDisconnectCanvas(): Promise<void> {
    await window.smartlife.canvas.clearToken();
    setCanvasStatus(await window.smartlife.canvas.getStatus());
    setCanvasMessage('Token removed.');
  }
```

And add this JSX block after the existing AI permission-mode block, before the version paragraph:

```tsx
      <div className="flex flex-col gap-2">
        <span style={{ color: 'var(--color-text-muted)' }}>
          Canvas{' '}
          {canvasStatus?.tokenConfigured && canvasStatus?.baseUrlConfigured
            ? '— connected'
            : canvasStatus
              ? '— not connected'
              : ''}
        </span>
        <input
          type="text"
          value={canvasUrlInput}
          onChange={(e) => setCanvasUrlInput(e.target.value)}
          placeholder="uncw.instructure.com"
          aria-label="Canvas URL"
          className="rounded-md px-3 py-1.5 text-sm"
          style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
        />
        <div className="flex gap-2">
          <input
            type="password"
            value={canvasTokenInput}
            onChange={(e) => setCanvasTokenInput(e.target.value)}
            placeholder="Canvas access token"
            aria-label="Canvas access token"
            className="rounded-md px-3 py-1.5 text-sm"
            style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
          />
          <button
            type="button"
            onClick={handleSaveCanvas}
            disabled={canvasUrlInput.trim().length === 0 && canvasTokenInput.length === 0}
            className="rounded-md px-3 py-1.5 text-sm"
            style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
          >
            Save
          </button>
          <button
            type="button"
            onClick={handleTestCanvas}
            className="rounded-md px-3 py-1.5 text-sm"
            style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
          >
            Test connection
          </button>
          {canvasStatus?.tokenConfigured && (
            <button
              type="button"
              onClick={handleDisconnectCanvas}
              className="rounded-md px-3 py-1.5 text-sm"
              style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
            >
              Disconnect
            </button>
          )}
        </div>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Generate a token in Canvas under Account → Settings → Approved Integrations. UNCW tokens
          expire after 90 days.
        </span>
        {canvasMessage && <span style={{ color: 'var(--color-text-muted)' }}>{canvasMessage}</span>}
        {canvasError && <span style={{ color: '#F87171' }}>{canvasError}</span>}
      </div>
```

- [ ] **Step 9: Append Canvas cases to `Settings.test.tsx`**

The existing file already mocks `window.smartlife`. Add a `canvas` key to that mock with the methods below, then add this describe block. Note the existing mock object must gain: `getStatus`, `setBaseUrl`, `setToken`, `clearToken`, `testConnection`.

```tsx
describe('Settings — Canvas', () => {
  it('shows not connected when no token is stored', async () => {
    expect(await screen.findByText(/canvas — not connected/i)).toBeInTheDocument();
  });

  it('saves the URL and token together', async () => {
    await userEvent.type(screen.getByLabelText('Canvas URL'), 'uncw.instructure.com');
    await userEvent.type(screen.getByLabelText('Canvas access token'), 'canvas-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(window.smartlife.canvas.setBaseUrl).toHaveBeenCalledWith('uncw.instructure.com');
    expect(window.smartlife.canvas.setToken).toHaveBeenCalledWith('canvas-secret');
  });

  it('reports the account name on a successful connection test', async () => {
    vi.mocked(window.smartlife.canvas.testConnection).mockResolvedValue({ ok: true, name: 'Alexander B' });
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/connected as alexander b/i)).toBeInTheDocument();
  });

  it('reports the failure reason when the connection test fails', async () => {
    vi.mocked(window.smartlife.canvas.testConnection).mockResolvedValue({
      ok: false,
      error: 'Canvas rejected the access token.',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/canvas rejected the access token/i)).toBeInTheDocument();
  });
});
```

Adapt the render/setup boilerplate of this block to match whatever the existing `Settings.test.tsx` already does (it renders `<Settings />` in a `beforeEach` or per test) rather than introducing a second pattern in the same file.

- [ ] **Step 10: Run the full check chain**

Run: `npm run lint && npm run typecheck && npm run test && npm run build`
Expected: all four exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/main/canvas/ipc.ts src/preload/index.ts src/renderer/src/routes/Course.tsx \
        src/renderer/src/routes/Course.test.tsx src/renderer/src/routes/Settings.tsx \
        src/renderer/src/routes/Settings.test.tsx src/renderer/src/App.tsx \
        src/renderer/src/App.test.tsx src/renderer/src/theme/ThemeProvider.test.tsx
git commit -m "Task 7: course detail view and Settings Canvas block"
```

---

### Task 8: Three READ-tier Canvas AI tools

**Files:**
- Create: `src/main/ai/tools/canvasUpcoming.ts`
- Create: `src/main/ai/tools/canvasGrades.ts`
- Create: `src/main/ai/tools/canvasSearchMaterials.ts`
- Modify: `src/main/ai/tools/registry.ts`
- Test: `src/main/ai/tools/canvasTools.test.ts`

**Interfaces:**
- Consumes: `ToolDefinition`, `ToolContext` from `src/main/ai/tools/types`; `ToolTier` from `src/main/ai/permissions`; `getUpcomingAssignments`, `getCourseGrades`, `searchMaterials` from `src/main/canvas/queries`.
- Produces: `canvasUpcomingTool`, `canvasGradesTool`, `canvasSearchMaterialsTool`, all appended to the exported `TOOLS` array.

**Constraints specific to this task:**
- **All three tools are tier `READ`.** READ is never gated by `resolveExecutionMode`, in any mode, so none of them may call `ctx.requestConfirmation`.
- **These tools read the local SQLite mirror and must never call the Canvas API.** That is what makes them instant, offline-capable, and unable to consume rate-limit quota no matter how much the user chats. Do not import anything from `canvas/client`, `canvas/api`, or `canvas/sync`.
- `run` returns a `string` — format results as compact readable text, not JSON dumps, and say plainly when there is nothing to report.

- [ ] **Step 1: Write the failing test**

Create `src/main/ai/tools/canvasTools.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

import { canvasUpcomingTool } from './canvasUpcoming';
import { canvasGradesTool } from './canvasGrades';
import { canvasSearchMaterialsTool } from './canvasSearchMaterials';
import { TOOLS } from './registry';
import { resolveExecutionMode } from '../permissions';

const SCHEMA = `
create table settings (key text primary key, value text not null);
create table canvas_courses (
  id integer primary key, name text not null, course_code text, term_name text,
  current_score real, current_grade text, synced_at text not null default (datetime('now'))
);
create table canvas_assignments (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  name text not null, description text, due_at text, points_possible real, html_url text,
  submission_types text, has_submitted integer not null default 0, submitted_at text,
  score real, grade text, workflow_state text,
  synced_at text not null default (datetime('now'))
);
create table canvas_announcements (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  title text, message text, posted_at text, html_url text,
  synced_at text not null default (datetime('now'))
);
create table canvas_files (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  display_name text, filename text, content_type text, size integer,
  updated_at text, synced_at text not null default (datetime('now'))
);
create table canvas_pages (
  course_id integer not null references canvas_courses(id) on delete cascade,
  url text not null, title text, body text, updated_at text,
  synced_at text not null default (datetime('now')), primary key (course_id, url)
);
create table canvas_sync_state (key text primary key, value text not null);
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare('insert into canvas_courses (id, name, course_code, current_score, current_grade) values (?,?,?,?,?)').run(
    101, 'Statistics', 'STT 215', 91.5, 'A-'
  );
  return db;
}

function ctx(db: Database.Database) {
  return {
    db,
    conversationId: 'conv-1',
    mode: 'ask' as const,
    requestConfirmation: vi.fn(async () => {
      throw new Error('READ-tier tools must never ask for confirmation');
    }),
  };
}

describe('Canvas tool registration', () => {
  it('registers all three tools', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toContain('canvas_upcoming_assignments');
    expect(names).toContain('canvas_course_grades');
    expect(names).toContain('canvas_search_materials');
  });

  it('registers them at READ tier, which never pauses in any mode', () => {
    for (const tool of [canvasUpcomingTool, canvasGradesTool, canvasSearchMaterialsTool]) {
      expect(tool.tier).toBe('READ');
      for (const mode of ['ask', 'assist', 'auto'] as const) {
        expect(resolveExecutionMode(tool.tier, mode)).toBe('auto');
      }
    }
  });

  it('declares object input schemas', () => {
    for (const tool of [canvasUpcomingTool, canvasGradesTool, canvasSearchMaterialsTool]) {
      expect(tool.schema.input_schema.type).toBe('object');
      expect(tool.schema.description.length).toBeGreaterThan(10);
    }
  });
});

describe('canvas_upcoming_assignments', () => {
  it('lists work due inside the requested window', async () => {
    const db = makeDb();
    const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
    db.prepare(
      'insert into canvas_assignments (id, course_id, name, due_at, points_possible, has_submitted) values (?,?,?,?,?,?)'
    ).run(555, 101, 'Problem Set 3', due, 20, 0);

    const output = await canvasUpcomingTool.run({ days: 7 }, ctx(db));

    expect(output).toContain('Problem Set 3');
    expect(output).toContain('Statistics');
  });

  it('marks submitted work so the model does not nag about it', async () => {
    const db = makeDb();
    const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
    db.prepare(
      'insert into canvas_assignments (id, course_id, name, due_at, points_possible, has_submitted) values (?,?,?,?,?,?)'
    ).run(555, 101, 'Problem Set 3', due, 20, 1);

    expect(await canvasUpcomingTool.run({ days: 7 }, ctx(db))).toContain('submitted');
  });

  it('defaults to a 7-day window when days is omitted', async () => {
    const db = makeDb();
    const inTenDays = new Date(Date.now() + 10 * 86_400_000).toISOString();
    db.prepare('insert into canvas_assignments (id, course_id, name, due_at) values (?,?,?,?)').run(
      556, 101, 'Far Off', inTenDays
    );

    expect(await canvasUpcomingTool.run({}, ctx(db))).toContain('Nothing is due');
  });

  it('says so plainly when nothing is due', async () => {
    expect(await canvasUpcomingTool.run({ days: 7 }, ctx(makeDb()))).toContain('Nothing is due');
  });

  it('clamps an out-of-range day count instead of failing', async () => {
    const db = makeDb();
    await expect(canvasUpcomingTool.run({ days: -5 }, ctx(db))).resolves.toContain('Nothing is due');
    await expect(canvasUpcomingTool.run({ days: 99999 }, ctx(db))).resolves.toBeTypeOf('string');
  });
});

describe('canvas_course_grades', () => {
  it('reports the current score and letter per course', async () => {
    const output = await canvasGradesTool.run({}, ctx(makeDb()));
    expect(output).toContain('Statistics');
    expect(output).toContain('91.5');
    expect(output).toContain('A-');
  });

  it('handles a course with no posted grade', async () => {
    const db = makeDb();
    db.prepare('insert into canvas_courses (id, name) values (?, ?)').run(202, 'Chemistry');
    const output = await canvasGradesTool.run({}, ctx(db));
    expect(output).toContain('Chemistry');
    expect(output).toContain('no grade posted');
  });

  it('says so when no courses are synced', async () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    expect(await canvasGradesTool.run({}, ctx(db))).toContain('No courses');
  });
});

describe('canvas_search_materials', () => {
  it('finds a file by partial name', async () => {
    const db = makeDb();
    db.prepare('insert into canvas_files (id, course_id, display_name) values (?,?,?)').run(7, 101, 'Syllabus.pdf');

    const output = await canvasSearchMaterialsTool.run({ query: 'syllab' }, ctx(db));

    expect(output).toContain('Syllabus.pdf');
    expect(output).toContain('Statistics');
  });

  it('finds a page by title', async () => {
    const db = makeDb();
    db.prepare('insert into canvas_pages (course_id, url, title) values (?,?,?)').run(101, 'week-1', 'Week 1 Overview');

    expect(await canvasSearchMaterialsTool.run({ query: 'overview' }, ctx(db))).toContain('Week 1 Overview');
  });

  it('reports no matches rather than returning an empty string', async () => {
    expect(await canvasSearchMaterialsTool.run({ query: 'nonexistent' }, ctx(makeDb()))).toContain('No materials');
  });

  it('asks for a query when given a blank one', async () => {
    expect(await canvasSearchMaterialsTool.run({ query: '   ' }, ctx(makeDb()))).toContain('search term');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/main/ai/tools/canvasTools.test.ts`
Expected: FAIL with `Failed to resolve import "./canvasUpcoming"`.

- [ ] **Step 3: Implement `canvasUpcoming.ts`**

Create `src/main/ai/tools/canvasUpcoming.ts`:

```ts
import type { ToolDefinition } from './types';
import { getUpcomingAssignments } from '../../canvas/queries';

const DEFAULT_DAYS = 7;
const MAX_DAYS = 180;

export const canvasUpcomingTool: ToolDefinition = {
  name: 'canvas_upcoming_assignments',
  tier: 'READ',
  label: 'Read upcoming Canvas assignments',
  schema: {
    name: 'canvas_upcoming_assignments',
    description:
      'List Canvas assignments due within the next N days, across all of the student’s active courses. Reads locally synced data, so it is instant and works offline.',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: `How many days ahead to look. Defaults to ${DEFAULT_DAYS}.`,
        },
      },
      required: [],
    },
  },
  async run(input, ctx) {
    const requested =
      typeof input.days === 'number' && Number.isFinite(input.days) ? input.days : DEFAULT_DAYS;
    const days = Math.min(MAX_DAYS, Math.max(0, Math.floor(requested)));
    return format(getUpcomingAssignments(ctx.db, days), days);
  },
};

function format(rows: ReturnType<typeof getUpcomingAssignments>, days: number): string {
  if (rows.length === 0) return `Nothing is due in the next ${days} days.`;
  const lines = rows.map((row) => {
    const status = row.hasSubmitted ? ' — submitted' : '';
    const points = row.pointsPossible === null ? '' : ` (${row.pointsPossible} pts)`;
    return `- ${row.name}${points} — ${row.courseName} — due ${row.dueAt}${status}`;
  });
  return `Due in the next ${days} days:\n${lines.join('\n')}`;
}
```

Note the signature: `run` receives `(input, ctx)` as separate arguments — it is not bound to a
context object, so the database handle comes from `ctx.db`, never `this`.

- [ ] **Step 4: Implement `canvasGrades.ts`**

Create `src/main/ai/tools/canvasGrades.ts`:

```ts
import type { ToolDefinition } from './types';
import { getCourseGrades } from '../../canvas/queries';

export const canvasGradesTool: ToolDefinition = {
  name: 'canvas_course_grades',
  tier: 'READ',
  label: 'Read Canvas course grades',
  schema: {
    name: 'canvas_course_grades',
    description:
      'Report the student’s current grade in each active Canvas course. Reads locally synced data.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  async run(_input, ctx) {
    const rows = getCourseGrades(ctx.db);
    if (rows.length === 0) return 'No courses have been synced from Canvas yet.';
    const lines = rows.map((row) => {
      const code = row.courseCode ? ` (${row.courseCode})` : '';
      if (row.currentScore === null) return `- ${row.name}${code}: no grade posted`;
      const letter = row.currentGrade ? ` (${row.currentGrade})` : '';
      return `- ${row.name}${code}: ${row.currentScore}%${letter}`;
    });
    return `Current grades:\n${lines.join('\n')}`;
  },
};
```

- [ ] **Step 5: Implement `canvasSearchMaterials.ts`**

Create `src/main/ai/tools/canvasSearchMaterials.ts`:

```ts
import type { ToolDefinition } from './types';
import { searchMaterials } from '../../canvas/queries';

export const canvasSearchMaterialsTool: ToolDefinition = {
  name: 'canvas_search_materials',
  tier: 'READ',
  label: 'Search Canvas course materials',
  schema: {
    name: 'canvas_search_materials',
    description:
      'Search the names of synced Canvas files and pages across all courses — for example to locate a syllabus or a lecture PDF. Reads locally synced data.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to match against file and page titles.' },
      },
      required: ['query'],
    },
  },
  async run(input, ctx) {
    const query = typeof input.query === 'string' ? input.query : '';
    if (query.trim().length === 0) return 'Provide a search term to look for.';
    const hits = searchMaterials(ctx.db, query);
    if (hits.length === 0) return `No materials matched "${query}".`;
    const lines = hits.map((hit) => `- [${hit.kind}] ${hit.title} — ${hit.courseName}`);
    return `Matches for "${query}":\n${lines.join('\n')}`;
  },
};
```

- [ ] **Step 6: Append the tools to the registry**

Replace `src/main/ai/tools/registry.ts`:

```ts
import type { ToolDefinition } from './types';
import { getSettingsTool } from './getSettings';
import { setThemeTool } from './setTheme';
import { clearConversationHistoryTool } from './clearConversationHistory';
import { canvasUpcomingTool } from './canvasUpcoming';
import { canvasGradesTool } from './canvasGrades';
import { canvasSearchMaterialsTool } from './canvasSearchMaterials';

export const TOOLS: ToolDefinition[] = [
  getSettingsTool,
  setThemeTool,
  clearConversationHistoryTool,
  canvasUpcomingTool,
  canvasGradesTool,
  canvasSearchMaterialsTool,
];
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm run test -- src/main/ai/tools/canvasTools.test.ts`
Expected: PASS, 15/15 tests.

- [ ] **Step 8: Run the full check chain**

Run: `npm run lint && npm run typecheck && npm run test && npm run build`
Expected: all four exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/main/ai/tools/canvasUpcoming.ts src/main/ai/tools/canvasGrades.ts \
        src/main/ai/tools/canvasSearchMaterials.ts src/main/ai/tools/registry.ts \
        src/main/ai/tools/canvasTools.test.ts
git commit -m "Task 8: three READ-tier Canvas AI tools"
```

---

### Task 9: Packaging and final verification

**Files:**
- No new files. This task verifies and packages everything from Tasks 1–8, matching the closing task of Phases 1 and 2.

**Interfaces:**
- Consumes: everything. Produces: nothing further.

- [ ] **Step 1: Run the complete pipeline**

Run: `npm run lint && npm run typecheck && npm run test && npm run build`
Expected: every command exits 0. Note the total test count for the task report — Phase 2 finished at 69, and Tasks 1–8 add roughly 100 more.

- [ ] **Step 2: Confirm no new runtime dependency crept in**

Run: `node -e "const p=require('./package.json');console.log(Object.keys(p.dependencies).join(','))"`
Expected: exactly `@anthropic-ai/sdk,better-sqlite3`. If anything else appears, a Global Constraint was violated — stop and report rather than proceeding.

- [ ] **Step 3: Confirm the sync engine never fans out**

Run: `grep -rn "Promise.all" src/main/canvas/`
Expected: no output. `Promise.all` over Canvas requests violates Instructure's one-request-at-a-time guidance. (`useCanvas.ts` in the renderer does use `Promise.all`, but that is over local IPC reads, not network calls — this grep is deliberately scoped to `src/main/canvas/`.)

- [ ] **Step 4: Confirm every list endpoint is paginated correctly**

Run: `grep -n "per_page" src/main/canvas/client.ts`
Expected: one hit, inside `canvasFetchAll`. Every list request routes through that function, so a single hit is correct — but if `api.ts` sets `per_page` anywhere itself, that is a duplicate worth removing.

- [ ] **Step 5: Package the app**

Run: `npm run package`
Expected: exits 0.

- [ ] **Step 6: Verify the packaged artifact exists**

Run: `find release -maxdepth 3 -name "SmartLife.app"`
Expected: prints one path.

- [ ] **Step 7: Verify the built main process boots**

Run with `ELECTRON_RUN_AS_NODE=1` set: `npx electron -e "require('./out/main/index.js')" 2>&1 | head -20`
Expected: no `ERR_REQUIRE_ESM`, no module-resolution error. Phase 2 shipped a boot-crashing import that every unit test passed straight through; this is the check that catches that class of bug.

- [ ] **Step 8: Confirm no secrets were committed**

Run: `git log --all -p -- '*.ts' '*.tsx' | grep -iE "(sk-ant-|[0-9]{4}~[A-Za-z0-9]{40,})" | grep -v "sk-ant-test"`
Expected: no output. Canvas personal access tokens have the shape `1234~<long random string>`; this checks that neither an Anthropic key nor a Canvas token was ever committed. **If this finds something, stop and report it — do not attempt to rewrite git history yourself.**

- [ ] **Step 9: Confirm the working tree is clean**

Run: `git status`
Expected: `release/` and `out/` are untracked or ignored, matching Phases 1 and 2. Nothing to commit for this task if clean.

---

## After this plan

Once all 9 tasks are reviewed and approved, the controller runs a whole-branch review (`git merge-base main HEAD` → HEAD), then a real visual pass the same way as Phases 1 and 2: launch the packaged app, open School, confirm the "Connect Canvas" empty state renders, paste the Canvas URL and token into Settings, hit **Test connection** and confirm it returns the account name, then confirm the first sync populates due-soon items and grades. Open a course, confirm modules and files appear, click a PDF and confirm it opens in Preview, and click a Page and confirm it renders inline. Finally ask the AI "what's due this week?" and confirm it answers from local data.

**The token belongs to the user and only they can enter it.** Never ask them to paste it into a chat message, a file, or a test fixture — it goes into the Settings field, where safeStorage encrypts it into the Keychain.

Update `../../../ROADMAP.md`'s status checklist once Phase 3 ships, and move on to brainstorming Phase 4 (Google Calendar) when the user is ready.
