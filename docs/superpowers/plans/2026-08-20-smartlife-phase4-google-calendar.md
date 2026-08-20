# SmartLife Phase 4: Google Calendar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `calendar` nav section into a working week view of the user's Google Calendar — readable offline, editable in place, and driveable by the assistant with confirm-before-write.

**Architecture:** OAuth 2.0 loopback flow with PKCE obtains a refresh token stored via safeStorage; access tokens live in memory only. A serial sync engine mirrors a rolling 60-days-back/180-days-forward window into SQLite using `singleEvents=true` (Google expands recurrences server-side, so no RRULE engine is needed). Writes call the Google API directly and then resync that calendar. The renderer reads exclusively from the local mirror.

**Tech Stack:** Electron 3x main/preload/renderer split, better-sqlite3 with numbered SQL migrations, React + react-router-dom (MemoryRouter), Tailwind for layout with `var(--color-*)` design tokens, Vitest + Testing Library, `@anthropic-ai/sdk` beta Tool Runner for AI tools.

## Global Constraints

- **No new runtime dependencies.** `package.json` `dependencies` must remain exactly `@anthropic-ai/sdk` and `better-sqlite3`. This constraint is *why* the design uses `singleEvents=true` instead of incremental sync — do not add an RRULE library.
- **All network access happens in the main process.** The renderer reaches Google only through `window.smartlife.calendar.*` IPC.
- **Never `Promise.all` over Google API calls.** Sync is strictly serial, one request in flight at a time. `Promise.all` over *local* IPC reads in the renderer is fine.
- **No test performs a live Google API call.** Every test fakes `fetch`, `http`, or the `api` module.
- **All-day events store Google's raw date string** (`"2026-08-20"`), never a timestamp. `is_all_day` gates every parsing, formatting, and layout path.
- **Access tokens are never written to disk.** Only the refresh token, client ID, and client secret are persisted, all safeStorage-encrypted.
- **Do not modify `src/main/csp.ts`.** All Google traffic originates in the main process, so no CSP directive needs widening. Widening it would be a silent security regression.
- **Sync window:** 60 days back, 180 days forward, recomputed at each run.
- **Sync cadence:** launch, window focus (5-minute throttle), 30-minute background interval, manual refresh.
- **Event list requests use** `singleEvents=true`, `orderBy=startTime`, `maxResults=250`, and follow `pageToken`.
- **Existing Canvas scheduler tests must pass unchanged** after the shared-scheduler extraction in Task 4. Do not edit `src/main/canvas/scheduler.test.ts`.
- Code style follows the existing codebase: named exports, explicit return types, `async`/`await`, comments that explain *why* rather than *what*.

## File Structure

**Created — main process:**

| File | Responsibility |
|---|---|
| `src/main/db/migrations/0004_calendar.sql` | Three tables: `google_calendars`, `google_events`, `calendar_sync_state` |
| `src/main/calendar/errors.ts` | `GoogleAuthError`, `GoogleRateLimitError`, `GoogleConflictError`, `GoogleNetworkError` |
| `src/main/calendar/token.ts` | safeStorage storage for refresh token / client ID / client secret / account email; in-memory access-token cache |
| `src/main/calendar/oauth.ts` | PKCE generation, loopback server, `state` verification, code and refresh exchanges |
| `src/main/calendar/client.ts` | The only module that calls the Google API: bearer auth, refresh-on-expiry, `pageToken` pagination, error mapping |
| `src/main/calendar/api.ts` | Typed endpoint wrappers: `listCalendars`, `listEvents`, `createEvent`, `updateEvent`, `deleteEvent`, `getUserInfo` |
| `src/main/calendar/sync.ts` | `syncAll`, `syncOneCalendar`, sync-state helpers, window computation |
| `src/main/calendar/queries.ts` | Local SQLite reads for the renderer and AI tools. Never touches the network |
| `src/main/calendar/writes.ts` | Create/update/delete, etag preconditions, and error-to-sentence mapping shared by the IPC handlers and the AI tools |
| `src/main/calendar/scheduler.ts` | Thin Calendar wrapper over the shared scheduler |
| `src/main/calendar/ipc.ts` | Renderer IPC handlers |
| `src/main/scheduler.ts` | Shared `createScheduler`, consumed by both Canvas and Calendar |

**Created — renderer:**

| File | Responsibility |
|---|---|
| `src/renderer/src/calendar/types.ts` | Shared renderer types |
| `src/renderer/src/calendar/formatters.ts` | Time and date formatting, all-day aware |
| `src/renderer/src/calendar/layout.ts` | Pure week-grid geometry: day bucketing, time→offset, overlap clustering |
| `src/renderer/src/calendar/inputs.ts` | `datetime-local` ↔ ISO conversion, done in local time |
| `src/renderer/src/calendar/useCalendar.ts` | Data-loading hook |
| `src/renderer/src/calendar/AllDayStrip.tsx` | All-day events row above the grid |
| `src/renderer/src/calendar/WeekGrid.tsx` | 7-column timed grid with current-time line |
| `src/renderer/src/calendar/AgendaPanel.tsx` | Upcoming events list |
| `src/renderer/src/calendar/EventDialog.tsx` | Create/edit/delete form |
| `src/renderer/src/calendar/CalendarToggles.tsx` | Per-calendar enable/disable |
| `src/renderer/src/calendar/ConnectBanner.tsx` | Reconnect banner for a dead token |
| `src/renderer/src/routes/Calendar.tsx` | The `/calendar` route |

**Created — AI tools:** `src/main/ai/tools/calendarListEvents.ts`, `calendarCreateEvent.ts`, `calendarUpdateEvent.ts`, `calendarDeleteEvent.ts`

**Modified:** `src/main/db/index.ts` (register migration), `src/main/canvas/scheduler.ts` (use shared scheduler), `src/preload/index.ts` (calendar bridge), `src/main/index.ts` (scheduler + IPC wiring), `src/renderer/src/App.tsx` (route), `src/renderer/src/routes/Settings.tsx` (Google block), `src/main/ai/tools/registry.ts` (four tools)

## Task Overview

| Task | Deliverable |
|---|---|
| 1 | Migration, error types, token storage |
| 2 | OAuth loopback flow with PKCE |
| 3 | API client and typed endpoint wrappers |
| 4 | Shared scheduler extraction (Canvas rewired, its tests untouched) |
| 5 | Sync engine |
| 6 | Local queries |
| 7 | Event writes |
| 8 | Calendar scheduler, IPC, preload bridge, main-process wiring |
| 9 | Renderer types, date math, and formatters |
| 10 | Calendar route: week grid, all-day strip, agenda panel |
| 11 | Event dialog, calendar toggles, Settings block |
| 12 | Four AI tools with runtime tier escalation |
| 13 | Packaging and final verification |

---

### Task 1: Migration, error types, and token storage

**Files:**
- Create: `src/main/db/migrations/0004_calendar.sql`
- Create: `src/main/calendar/errors.ts`
- Create: `src/main/calendar/token.ts`
- Create: `src/main/calendar/token.test.ts`
- Modify: `src/main/db/index.ts`

**Interfaces:**
- Consumes: the existing `settings` table from `0001_init.sql` (`key text primary key, value text not null`).
- Produces:
  - `GoogleAuthError`, `GoogleRateLimitError`, `GoogleConflictError`, `GoogleNotFoundError`, `GoogleNetworkError` (all `extends Error`)
  - `interface GoogleClientConfig { clientId: string; clientSecret: string }`
  - `getGoogleClientConfig(db): GoogleClientConfig | null`
  - `setGoogleClientConfig(db, clientId: string, clientSecret: string): void`
  - `getGoogleRefreshToken(db): string | null`
  - `setGoogleRefreshToken(db, token: string): void`
  - `clearGoogleAuth(db): void`
  - `getGoogleAccountEmail(db): string | null`
  - `setGoogleAccountEmail(db, email: string): void`
  - `hasGoogleAuth(db): boolean`
  - `getCachedAccessToken(now?: number): string | null`
  - `setCachedAccessToken(token: string, expiresInSeconds: number, now?: number): void`
  - `clearCachedAccessToken(): void`

- [ ] **Step 1: Write the migration**

Create `src/main/db/migrations/0004_calendar.sql`:

```sql
create table google_calendars (
  id text primary key,
  summary text not null,
  time_zone text,
  background_color text,
  access_role text,
  is_primary integer not null default 0,
  enabled integer not null default 1,
  synced_at text not null default (datetime('now'))
);

-- Composite PK: Google event IDs are unique within a calendar, not across
-- calendars, and the same event can appear in two calendars the user owns.
create table google_events (
  calendar_id text not null references google_calendars(id) on delete cascade,
  id text not null,
  summary text,
  description text,
  location text,
  -- For timed events these are RFC3339 timestamps. For all-day events they
  -- are Google's raw date strings ("2026-08-20") and must never be parsed as
  -- timestamps -- doing so renders the event on the wrong day west of UTC.
  start_at text not null,
  end_at text not null,
  is_all_day integer not null default 0,
  status text,
  html_link text,
  organizer_email text,
  -- Two columns instead of an attendees table: has_guests drives the
  -- CONSEQUENTIAL tier escalation, guest_count renders in the UI, and
  -- nothing in this phase reads individual attendees.
  has_guests integer not null default 0,
  guest_count integer not null default 0,
  recurring_event_id text,
  etag text,
  updated_at text,
  synced_at text not null default (datetime('now')),
  primary key (calendar_id, id)
);

create index google_events_start_idx on google_events(start_at);
create index google_events_calendar_start_idx on google_events(calendar_id, start_at);

create table calendar_sync_state (
  key text primary key,
  value text not null
);
```

- [ ] **Step 2: Register the migration**

Modify `src/main/db/index.ts` — add the import alongside the existing three and the entry at the end of the `runMigrations` array:

```ts
import migration0004 from './migrations/0004_calendar.sql?raw';
```

```ts
  runMigrations(db, [
    { filename: '0001_init.sql', sql: migration0001 },
    { filename: '0002_ai_core.sql', sql: migration0002 },
    { filename: '0003_canvas.sql', sql: migration0003 },
    { filename: '0004_calendar.sql', sql: migration0004 },
  ]);
```

- [ ] **Step 3: Write the error types**

Create `src/main/calendar/errors.ts`:

```ts
/** The refresh token is revoked, expired, or the grant was withdrawn. Routine. */
export class GoogleAuthError extends Error {
  constructor(message = 'Google rejected the credentials.') {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

/** Google throttled the request. Back off; do not retry immediately. */
export class GoogleRateLimitError extends Error {
  constructor(message = 'Google is rate limiting requests.') {
    super(message);
    this.name = 'GoogleRateLimitError';
  }
}

/**
 * The event changed elsewhere since we last synced it (etag mismatch on an
 * If-Match write). The caller must resync and let the user retry rather than
 * blindly overwriting whatever the other client wrote.
 */
export class GoogleConflictError extends Error {
  constructor(message = 'This event was changed somewhere else.') {
    super(message);
    this.name = 'GoogleConflictError';
  }
}

/**
 * The event or calendar no longer exists on Google's side. For a delete this
 * is effectively success; for an update the user needs to be told.
 */
export class GoogleNotFoundError extends Error {
  constructor(message = 'That event no longer exists on Google Calendar.') {
    super(message);
    this.name = 'GoogleNotFoundError';
  }
}

/** Offline, DNS failure, 5xx, or any other unexpected HTTP status. */
export class GoogleNetworkError extends Error {
  constructor(message = 'Could not reach Google.') {
    super(message);
    this.name = 'GoogleNetworkError';
  }
}
```

- [ ] **Step 4: Write the failing token-storage test**

Create `src/main/calendar/token.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('Google client config storage', () => {
  it('returns null until both the ID and secret are stored', async () => {
    const { getGoogleClientConfig, setGoogleClientConfig } = await import('./token');
    const db = makeDb();
    expect(getGoogleClientConfig(db)).toBeNull();

    setGoogleClientConfig(db, 'client-123.apps.googleusercontent.com', 'secret-abc');
    expect(getGoogleClientConfig(db)).toEqual({
      clientId: 'client-123.apps.googleusercontent.com',
      clientSecret: 'secret-abc',
    });
  });

  it('stores the client secret encrypted, not in plaintext', async () => {
    const { setGoogleClientConfig } = await import('./token');
    const db = makeDb();
    setGoogleClientConfig(db, 'client-123', 'secret-abc');

    const rows = db.prepare('select value from settings').all() as Array<{ value: string }>;
    for (const row of rows) {
      expect(row.value).not.toContain('secret-abc');
    }
  });

  it('rejects a blank client ID or secret', async () => {
    const { setGoogleClientConfig } = await import('./token');
    const db = makeDb();
    expect(() => setGoogleClientConfig(db, '  ', 'secret')).toThrow('Client ID is required');
    expect(() => setGoogleClientConfig(db, 'client', '  ')).toThrow('Client secret is required');
  });
});

describe('Google refresh token storage', () => {
  it('round-trips the refresh token', async () => {
    const { getGoogleRefreshToken, setGoogleRefreshToken, hasGoogleAuth } = await import('./token');
    const db = makeDb();
    expect(hasGoogleAuth(db)).toBe(false);
    expect(getGoogleRefreshToken(db)).toBeNull();

    setGoogleRefreshToken(db, 'refresh-xyz');
    expect(getGoogleRefreshToken(db)).toBe('refresh-xyz');
    expect(hasGoogleAuth(db)).toBe(true);
  });

  it('clearGoogleAuth removes the token and email but keeps the client config', async () => {
    const mod = await import('./token');
    const db = makeDb();
    mod.setGoogleClientConfig(db, 'client-123', 'secret-abc');
    mod.setGoogleRefreshToken(db, 'refresh-xyz');
    mod.setGoogleAccountEmail(db, 'me@example.com');

    mod.clearGoogleAuth(db);

    expect(mod.getGoogleRefreshToken(db)).toBeNull();
    expect(mod.getGoogleAccountEmail(db)).toBeNull();
    // Re-connecting must not require re-typing the client credentials.
    expect(mod.getGoogleClientConfig(db)).toEqual({
      clientId: 'client-123',
      clientSecret: 'secret-abc',
    });
  });
});

describe('access token cache', () => {
  beforeEach(async () => {
    const { clearCachedAccessToken } = await import('./token');
    clearCachedAccessToken();
  });

  it('returns the cached token while it is still valid', async () => {
    const { getCachedAccessToken, setCachedAccessToken } = await import('./token');
    setCachedAccessToken('access-1', 3600, 1_000_000);
    expect(getCachedAccessToken(1_000_000 + 60_000)).toBe('access-1');
  });

  it('returns null once the token is within the safety margin of expiry', async () => {
    const { getCachedAccessToken, setCachedAccessToken } = await import('./token');
    setCachedAccessToken('access-1', 100, 1_000_000);
    // 100s lifetime, 60s margin -> treated as expired from t+40s onward.
    expect(getCachedAccessToken(1_000_000 + 39_000)).toBe('access-1');
    expect(getCachedAccessToken(1_000_000 + 41_000)).toBeNull();
  });

  it('clearCachedAccessToken drops the token immediately', async () => {
    const { clearCachedAccessToken, getCachedAccessToken, setCachedAccessToken } = await import('./token');
    setCachedAccessToken('access-1', 3600, 1_000_000);
    clearCachedAccessToken();
    expect(getCachedAccessToken(1_000_000)).toBeNull();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm run test -- src/main/calendar/token.test.ts`
Expected: FAIL with `Failed to resolve import "./token"`.

- [ ] **Step 6: Implement token storage**

Create `src/main/calendar/token.ts`:

```ts
import { safeStorage } from 'electron';
import type Database from 'better-sqlite3';

const REFRESH_TOKEN_KEY = 'google_refresh_token_encrypted';
const CLIENT_ID_KEY = 'google_client_id_encrypted';
const CLIENT_SECRET_KEY = 'google_client_secret_encrypted';
const ACCOUNT_EMAIL_KEY = 'google_account_email';

/**
 * Refresh a little before the token actually dies. Without a margin, a token
 * that passes the check and then spends 30s in a slow request arrives expired.
 */
const EXPIRY_MARGIN_MS = 60_000;

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
}

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

function writeEncrypted(db: Database.Database, key: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system.');
  }
  writeSetting(db, key, safeStorage.encryptString(value).toString('base64'));
}

function readEncrypted(db: Database.Database, key: string): string | null {
  const stored = readSetting(db, key);
  if (stored === null || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    return null;
  }
}

/**
 * Google issues a client secret even for Desktop clients and the token
 * exchange requires it. It is explicitly not confidential for installed apps,
 * but there is no reason to leave it sitting in the database in plaintext.
 */
export function setGoogleClientConfig(
  db: Database.Database,
  clientId: string,
  clientSecret: string
): void {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (id.length === 0) throw new Error('Client ID is required.');
  if (secret.length === 0) throw new Error('Client secret is required.');
  writeEncrypted(db, CLIENT_ID_KEY, id);
  writeEncrypted(db, CLIENT_SECRET_KEY, secret);
}

export function getGoogleClientConfig(db: Database.Database): GoogleClientConfig | null {
  const clientId = readEncrypted(db, CLIENT_ID_KEY);
  const clientSecret = readEncrypted(db, CLIENT_SECRET_KEY);
  if (clientId === null || clientSecret === null) return null;
  return { clientId, clientSecret };
}

export function setGoogleRefreshToken(db: Database.Database, token: string): void {
  writeEncrypted(db, REFRESH_TOKEN_KEY, token);
}

export function getGoogleRefreshToken(db: Database.Database): string | null {
  return readEncrypted(db, REFRESH_TOKEN_KEY);
}

export function hasGoogleAuth(db: Database.Database): boolean {
  return readSetting(db, REFRESH_TOKEN_KEY) !== null;
}

export function setGoogleAccountEmail(db: Database.Database, email: string): void {
  writeSetting(db, ACCOUNT_EMAIL_KEY, email);
}

export function getGoogleAccountEmail(db: Database.Database): string | null {
  return readSetting(db, ACCOUNT_EMAIL_KEY);
}

/**
 * Disconnects the account but deliberately keeps the client ID and secret:
 * those describe the user's Google Cloud project, not their grant, and making
 * them retype both to reconnect would be pointless friction.
 */
export function clearGoogleAuth(db: Database.Database): void {
  db.prepare('delete from settings where key in (?, ?)').run(REFRESH_TOKEN_KEY, ACCOUNT_EMAIL_KEY);
  clearCachedAccessToken();
}

// Access tokens are short-lived and must never be persisted, so this cache is
// module-scoped and dies with the process.
// ponytail: one slot is enough -- there is exactly one Google account.
let accessTokenCache: { token: string; expiresAtMs: number } | null = null;

export function setCachedAccessToken(
  token: string,
  expiresInSeconds: number,
  now: number = Date.now()
): void {
  accessTokenCache = { token, expiresAtMs: now + expiresInSeconds * 1000 };
}

export function getCachedAccessToken(now: number = Date.now()): string | null {
  if (accessTokenCache === null) return null;
  if (now >= accessTokenCache.expiresAtMs - EXPIRY_MARGIN_MS) return null;
  return accessTokenCache.token;
}

export function clearCachedAccessToken(): void {
  accessTokenCache = null;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test -- src/main/calendar/token.test.ts`
Expected: PASS, 8/8.

- [ ] **Step 8: Verify the migration applies against a real database**

Run: `npm run test -- src/main/db`
Expected: PASS. The existing `src/main/db/index.test.ts` and `migrate.test.ts` exercise the migration runner; adding a fourth migration must not break them.

- [ ] **Step 9: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/main/db/migrations/0004_calendar.sql src/main/db/index.ts src/main/calendar/errors.ts src/main/calendar/token.ts src/main/calendar/token.test.ts
git commit -m "Task 1: calendar migration, error types, and token storage"
```

---

### Task 2: OAuth loopback flow with PKCE

**Files:**
- Create: `src/main/calendar/oauth.ts`
- Create: `src/main/calendar/oauth.test.ts`

**Interfaces:**
- Consumes: `GoogleClientConfig` and `GoogleAuthError`/`GoogleNetworkError` from Task 1.
- Produces:
  - `generatePkcePair(): { verifier: string; challenge: string }`
  - `buildAuthUrl(clientId: string, redirectUri: string, challenge: string, state: string): string`
  - `exchangeCodeForTokens(config, code, redirectUri, verifier): Promise<TokenResponse>`
  - `refreshAccessToken(config, refreshToken): Promise<TokenResponse>`
  - `interface TokenResponse { accessToken: string; refreshToken: string | null; expiresIn: number }`
  - `runOAuthFlow(config, openBrowser: (url: string) => void): Promise<TokenResponse>`
  - `GOOGLE_CALENDAR_SCOPE`

- [ ] **Step 1: Write the failing test**

Create `src/main/calendar/oauth.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

const CONFIG = { clientId: 'client-123', clientSecret: 'secret-abc' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generatePkcePair', () => {
  it('produces a URL-safe verifier of legal length and a different challenge', async () => {
    const { generatePkcePair } = await import('./oauth');
    const { verifier, challenge } = generatePkcePair();

    // RFC 7636 requires 43-128 characters from the unreserved set.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    // The challenge is the S256 hash, so it must never equal the verifier --
    // sending the verifier as the challenge silently disables PKCE.
    expect(challenge).not.toBe(verifier);
  });

  it('produces a different verifier every call', async () => {
    const { generatePkcePair } = await import('./oauth');
    expect(generatePkcePair().verifier).not.toBe(generatePkcePair().verifier);
  });
});

describe('buildAuthUrl', () => {
  it('requests offline access with consent and sends the S256 challenge', async () => {
    const { buildAuthUrl, GOOGLE_CALENDAR_SCOPE } = await import('./oauth');
    const url = new URL(buildAuthUrl('client-123', 'http://127.0.0.1:5555', 'chal', 'st4te'));

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5555');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('st4te');
    // Without access_type=offline Google returns no refresh token at all, and
    // without prompt=consent it omits it on every re-authorization after the
    // first -- both produce an app that silently stops syncing in a week.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_CALENDAR_SCOPE);
  });
});

describe('exchangeCodeForTokens', () => {
  it('posts the PKCE verifier and returns the parsed tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599 }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const { exchangeCodeForTokens } = await import('./oauth');
    const result = await exchangeCodeForTokens(CONFIG, 'the-code', 'http://127.0.0.1:5555', 'the-verifier');

    expect(result).toEqual({ accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 3599 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe('the-verifier');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_secret')).toBe('secret-abc');
  });

  it('maps a rejected grant to GoogleAuthError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      )
    );

    const { exchangeCodeForTokens } = await import('./oauth');
    const { GoogleAuthError } = await import('./errors');
    await expect(
      exchangeCodeForTokens(CONFIG, 'bad', 'http://127.0.0.1:5555', 'v')
    ).rejects.toBeInstanceOf(GoogleAuthError);
  });
});

describe('refreshAccessToken', () => {
  it('sends grant_type=refresh_token and tolerates a response with no new refresh token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at-2', expires_in: 3599 }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { refreshAccessToken } = await import('./oauth');
    const result = await refreshAccessToken(CONFIG, 'rt-1');

    // Google omits refresh_token on refresh responses; treating that as an
    // error would break every sync after the first hour.
    expect(result).toEqual({ accessToken: 'at-2', refreshToken: null, expiresIn: 3599 });
    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt-1');
  });

  it('maps a revoked grant to GoogleAuthError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      )
    );
    const { refreshAccessToken } = await import('./oauth');
    const { GoogleAuthError } = await import('./errors');
    await expect(refreshAccessToken(CONFIG, 'dead')).rejects.toBeInstanceOf(GoogleAuthError);
  });

  it('maps a network failure to GoogleNetworkError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const { refreshAccessToken } = await import('./oauth');
    const { GoogleNetworkError } = await import('./errors');
    await expect(refreshAccessToken(CONFIG, 'rt')).rejects.toBeInstanceOf(GoogleNetworkError);
  });
});

describe('runOAuthFlow', () => {
  // The loopback callback in these tests is a REAL HTTP request to the real
  // server the flow just started. Stubbing global fetch outright would
  // swallow that call too, and the flow would hang until its timeout — so the
  // stub passes 127.0.0.1 through and only fakes Google's token endpoint.
  const realFetch = globalThis.fetch.bind(globalThis);

  function stubTokenEndpoint(body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('http://127.0.0.1')) return realFetch(url, init);
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      })
    );
  }

  /** Mimics the user approving (or declining) in their browser. */
  function callBack(authUrl: string, params: Record<string, string>): void {
    const parsed = new URL(authUrl);
    const redirectUri = parsed.searchParams.get('redirect_uri') ?? '';
    const query = new URLSearchParams(params).toString();
    void fetch(`${redirectUri}/?${query}`).catch(() => {});
  }

  it('completes when the browser redirect carries a matching state', async () => {
    stubTokenEndpoint({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599 });
    const { runOAuthFlow } = await import('./oauth');

    const pending = runOAuthFlow(CONFIG, (url) => {
      const state = new URL(url).searchParams.get('state') ?? '';
      callBack(url, { code: 'the-code', state });
    });

    await expect(pending).resolves.toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresIn: 3599,
    });
  });

  it('rejects a callback whose state does not match', async () => {
    stubTokenEndpoint({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599 });
    const { runOAuthFlow } = await import('./oauth');
    const { GoogleAuthError } = await import('./errors');

    const pending = runOAuthFlow(CONFIG, (url) => {
      // Any other local process could reach this port. Without the state
      // check it could inject its own authorization code.
      callBack(url, { code: 'attacker-code', state: 'wrong-state' });
    });

    await expect(pending).rejects.toBeInstanceOf(GoogleAuthError);
  });

  it('never exchanges a code when the state is wrong', async () => {
    stubTokenEndpoint({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599 });
    const { runOAuthFlow } = await import('./oauth');

    await runOAuthFlow(CONFIG, (url) => {
      callBack(url, { code: 'attacker-code', state: 'wrong-state' });
    }).catch(() => {});

    const exchanges = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([input]) => String(input).includes('oauth2.googleapis.com'));
    // Rejecting after exchanging would still have burned the code.
    expect(exchanges).toHaveLength(0);
  });

  it('rejects when Google returns an error instead of a code', async () => {
    stubTokenEndpoint({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599 });
    const { runOAuthFlow } = await import('./oauth');
    const { GoogleAuthError } = await import('./errors');

    const pending = runOAuthFlow(CONFIG, (url) => {
      const state = new URL(url).searchParams.get('state') ?? '';
      callBack(url, { error: 'access_denied', state });
    });

    await expect(pending).rejects.toBeInstanceOf(GoogleAuthError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/main/calendar/oauth.test.ts`
Expected: FAIL with `Failed to resolve import "./oauth"`.

- [ ] **Step 3: Implement the OAuth module**

Create `src/main/calendar/oauth.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GoogleAuthError, GoogleNetworkError } from './errors';
import type { GoogleClientConfig } from './token';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Read plus write. The readonly scope cannot satisfy this phase's CRUD. */
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

/** Abandon the flow if the user never finishes in their browser. */
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  // 32 random bytes -> 43 base64url chars, the RFC 7636 minimum.
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  challenge: string,
  state: string
): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_CALENDAR_SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  // access_type=offline is what makes Google issue a refresh token at all;
  // prompt=consent forces it to reissue one on every re-authorization rather
  // than only the first.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (error) {
    throw new GoogleNetworkError(error instanceof Error ? error.message : 'Could not reach Google.');
  }

  const text = await response.text();
  if (!response.ok) {
    // 400 invalid_grant is the ordinary "revoked or expired" signal; 401 is a
    // bad client. Both mean the user has to reconnect, so both are auth errors.
    if (response.status === 400 || response.status === 401) {
      throw new GoogleAuthError(`Google rejected the credentials: ${text.slice(0, 200)}`);
    }
    throw new GoogleNetworkError(`Google returned ${response.status}.`);
  }

  const parsed = JSON.parse(text) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!parsed.access_token) {
    throw new GoogleAuthError('Google returned no access token.');
  }
  return {
    accessToken: parsed.access_token,
    // Refresh responses legitimately omit this; only the initial exchange
    // carries one.
    refreshToken: parsed.refresh_token ?? null,
    expiresIn: parsed.expires_in ?? 3600,
  };
}

export function exchangeCodeForTokens(
  config: GoogleClientConfig,
  code: string,
  redirectUri: string,
  verifier: string
): Promise<TokenResponse> {
  return postToken(
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    })
  );
}

export function refreshAccessToken(
  config: GoogleClientConfig,
  refreshToken: string
): Promise<TokenResponse> {
  return postToken(
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    })
  );
}

function respond(res: ServerResponse, message: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><html><body style="font-family:-apple-system,sans-serif;padding:48px;text-align:center">
      <h2>${message}</h2><p>You can close this tab and return to SmartLife.</p>
    </body></html>`
  );
}

/**
 * Runs the full loopback flow: start a one-shot server on an OS-assigned port,
 * open the system browser, and resolve once Google redirects back.
 *
 * Binding 127.0.0.1 (never 0.0.0.0), verifying `state`, and shutting down after
 * a single request are what stop another local process from reaching this port
 * and injecting its own authorization code.
 */
export function runOAuthFlow(
  config: GoogleClientConfig,
  openBrowser: (url: string) => void
): Promise<TokenResponse> {
  const { verifier, challenge } = generatePkcePair();
  const state = base64Url(randomBytes(16));

  return new Promise<TokenResponse>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (settled) {
        res.writeHead(404);
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const returnedState = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (returnedState !== state) {
        respond(res, 'Sign-in could not be verified.');
        finish(null, new GoogleAuthError('The sign-in response could not be verified.'));
        return;
      }
      if (error !== null || code === null) {
        respond(res, 'Sign-in was cancelled.');
        finish(null, new GoogleAuthError(`Google returned "${error ?? 'no code'}".`));
        return;
      }

      respond(res, 'SmartLife is connected.');
      const redirectUri = redirectUriFor(server.address() as AddressInfo);
      exchangeCodeForTokens(config, code, redirectUri, verifier).then(
        (tokens) => finish(tokens, null),
        (err: unknown) => finish(null, err)
      );
    });

    function finish(tokens: TokenResponse | null, error: unknown): void {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      server.close();
      if (error !== null) reject(error);
      else resolve(tokens as TokenResponse);
    }

    server.on('error', (err) => finish(null, new GoogleNetworkError(err.message)));

    // Port 0 asks the OS for any free port; 127.0.0.1 keeps it off the network.
    server.listen(0, '127.0.0.1', () => {
      const redirectUri = redirectUriFor(server.address() as AddressInfo);
      timer = setTimeout(
        () => finish(null, new GoogleAuthError('Sign-in timed out.')),
        FLOW_TIMEOUT_MS
      );
      openBrowser(buildAuthUrl(config.clientId, redirectUri, challenge, state));
    });
  });
}

function redirectUriFor(address: AddressInfo): string {
  return `http://127.0.0.1:${address.port}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/main/calendar/oauth.test.ts`
Expected: PASS, 12/12.

- [ ] **Step 5: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/main/calendar/oauth.ts src/main/calendar/oauth.test.ts
git commit -m "Task 2: OAuth loopback flow with PKCE and state verification"
```

---

### Task 3: API client and typed endpoint wrappers

**Files:**
- Create: `src/main/calendar/client.ts`
- Create: `src/main/calendar/client.test.ts`
- Create: `src/main/calendar/api.ts`

**Interfaces:**
- Consumes: from Task 1 `getGoogleClientConfig`, `getGoogleRefreshToken`, `setGoogleRefreshToken`, `getCachedAccessToken`, `setCachedAccessToken`, `clearCachedAccessToken`, and all five error classes. From Task 2 `refreshAccessToken`.
- Produces:
  - `getAccessToken(db): Promise<string>`
  - `googleRequest<T>(db, path: string, options?: RequestOptions): Promise<T | null>`
  - `googleFetchAll<T>(db, path: string, query?: QueryParams): Promise<T[]>`
  - `interface RequestOptions { method?: string; query?: QueryParams; body?: unknown; etag?: string }`
  - `type QueryParams = Record<string, string | number | boolean>`
  - From `api.ts`: `listCalendars`, `listEvents`, `createEvent`, `updateEvent`, `deleteEvent`, and the types `GoogleCalendarListEntry`, `GoogleEvent`, `GoogleEventDateTime`, `GoogleEventInput`

**Context for the implementer:** there is deliberately no `getUserInfo` call. The `userinfo` endpoint needs a scope this app does not request, and it is unnecessary: **the primary calendar's `id` is the user's email address**, so `listCalendars` already carries it for free.

- [ ] **Step 1: Write the failing client test**

Create `src/main/calendar/client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

async function makeDb(): Promise<Database.Database> {
  const { setGoogleClientConfig, setGoogleRefreshToken, clearCachedAccessToken } = await import('./token');
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null)');
  setGoogleClientConfig(db, 'client-123', 'secret-abc');
  setGoogleRefreshToken(db, 'rt-1');
  clearCachedAccessToken();
  return db;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const TOKEN_OK = { access_token: 'at-1', expires_in: 3599 };

beforeEach(async () => {
  const { clearCachedAccessToken } = await import('./token');
  clearCachedAccessToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getAccessToken', () => {
  it('refreshes once and then serves the cached token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(TOKEN_OK));
    vi.stubGlobal('fetch', fetchMock);

    const { getAccessToken } = await import('./client');
    const db = await makeDb();

    expect(await getAccessToken(db)).toBe('at-1');
    expect(await getAccessToken(db)).toBe('at-1');
    // One network round trip, not two -- the cache is the whole point.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('persists a rotated refresh token when Google sends one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ ...TOKEN_OK, refresh_token: 'rt-2' }))
    );

    const { getAccessToken } = await import('./client');
    const { getGoogleRefreshToken } = await import('./token');
    const db = await makeDb();

    await getAccessToken(db);
    // Dropping a rotated token would strand the app on a dead credential.
    expect(getGoogleRefreshToken(db)).toBe('rt-2');
  });

  it('throws GoogleAuthError when nothing is connected', async () => {
    const { getAccessToken } = await import('./client');
    const { GoogleAuthError } = await import('./errors');
    const db = new Database(':memory:');
    db.exec('create table settings (key text primary key, value text not null)');

    await expect(getAccessToken(db)).rejects.toBeInstanceOf(GoogleAuthError);
  });
});

describe('googleRequest', () => {
  it('sends the bearer token and returns parsed JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(TOKEN_OK))
      .mockResolvedValueOnce(jsonResponse({ id: 'evt-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const { googleRequest } = await import('./client');
    const db = await makeDb();

    const result = await googleRequest<{ id: string }>(db, '/calendars/primary/events/evt-1');
    expect(result).toEqual({ id: 'evt-1' });

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer at-1');
  });

  it('sends If-Match when an etag is supplied', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(TOKEN_OK))
      .mockResolvedValueOnce(jsonResponse({ id: 'evt-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const { googleRequest } = await import('./client');
    const db = await makeDb();

    await googleRequest(db, '/calendars/primary/events/evt-1', {
      method: 'PUT',
      body: { summary: 'x' },
      etag: '"abc123"',
    });

    const init = fetchMock.mock.calls[1][1];
    expect((init.headers as Record<string, string>)['If-Match']).toBe('"abc123"');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ summary: 'x' }));
  });

  it('returns null for a 204 with no body', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(TOKEN_OK))
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
    );

    const { googleRequest } = await import('./client');
    const db = await makeDb();

    expect(await googleRequest(db, '/calendars/primary/events/evt-1', { method: 'DELETE' })).toBeNull();
  });

  it('maps 401 to GoogleAuthError and drops the cached access token', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(TOKEN_OK))
        .mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401))
    );

    const { googleRequest } = await import('./client');
    const { getCachedAccessToken } = await import('./token');
    const { GoogleAuthError } = await import('./errors');
    const db = await makeDb();

    await expect(googleRequest(db, '/calendars')).rejects.toBeInstanceOf(GoogleAuthError);
    // Holding a token Google just rejected guarantees the next call fails too.
    expect(getCachedAccessToken()).toBeNull();
  });

  it('maps 403 rateLimitExceeded to GoogleRateLimitError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(TOKEN_OK))
        .mockResolvedValueOnce(
          jsonResponse({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }, 403)
        )
    );

    const { googleRequest } = await import('./client');
    const { GoogleRateLimitError } = await import('./errors');
    const db = await makeDb();

    await expect(googleRequest(db, '/calendars')).rejects.toBeInstanceOf(GoogleRateLimitError);
  });

  it('maps 429 to GoogleRateLimitError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse(TOKEN_OK)).mockResolvedValueOnce(jsonResponse({}, 429))
    );

    const { googleRequest } = await import('./client');
    const { GoogleRateLimitError } = await import('./errors');
    const db = await makeDb();

    await expect(googleRequest(db, '/calendars')).rejects.toBeInstanceOf(GoogleRateLimitError);
  });

  it('maps 412 to GoogleConflictError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse(TOKEN_OK)).mockResolvedValueOnce(jsonResponse({}, 412))
    );

    const { googleRequest } = await import('./client');
    const { GoogleConflictError } = await import('./errors');
    const db = await makeDb();

    await expect(googleRequest(db, '/x', { method: 'PUT', etag: '"old"' })).rejects.toBeInstanceOf(
      GoogleConflictError
    );
  });

  it('maps 404 to GoogleNotFoundError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse(TOKEN_OK)).mockResolvedValueOnce(jsonResponse({}, 404))
    );

    const { googleRequest } = await import('./client');
    const { GoogleNotFoundError } = await import('./errors');
    const db = await makeDb();

    await expect(googleRequest(db, '/x')).rejects.toBeInstanceOf(GoogleNotFoundError);
  });

  it('maps a thrown fetch to GoogleNetworkError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse(TOKEN_OK)).mockRejectedValueOnce(new Error('offline'))
    );

    const { googleRequest } = await import('./client');
    const { GoogleNetworkError } = await import('./errors');
    const db = await makeDb();

    await expect(googleRequest(db, '/calendars')).rejects.toBeInstanceOf(GoogleNetworkError);
  });
});

describe('googleFetchAll', () => {
  it('follows nextPageToken serially and concatenates items', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('https://oauth2.googleapis.com')) return Promise.resolve(jsonResponse(TOKEN_OK));
      calls.push(url);
      if (calls.length === 1) {
        return Promise.resolve(jsonResponse({ items: [{ id: 'a' }], nextPageToken: 'page-2' }));
      }
      return Promise.resolve(jsonResponse({ items: [{ id: 'b' }] }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { googleFetchAll } = await import('./client');
    const db = await makeDb();

    const items = await googleFetchAll<{ id: string }>(db, '/calendars/primary/events', {
      singleEvents: true,
    });

    expect(items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('singleEvents=true');
    expect(calls[0]).not.toContain('pageToken');
    expect(calls[1]).toContain('pageToken=page-2');
    // The second page must also carry the original query, or Google silently
    // resets the window and returns a different result set.
    expect(calls[1]).toContain('singleEvents=true');
  });

  it('stops at the page cap rather than looping forever', async () => {
    let pages = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.startsWith('https://oauth2.googleapis.com')) return Promise.resolve(jsonResponse(TOKEN_OK));
        pages += 1;
        // A server that always returns a next token would hang the sync.
        return Promise.resolve(jsonResponse({ items: [{ id: String(pages) }], nextPageToken: 'more' }));
      })
    );

    const { googleFetchAll, MAX_PAGES } = await import('./client');
    const db = await makeDb();

    const items = await googleFetchAll<{ id: string }>(db, '/calendars/primary/events');
    expect(items).toHaveLength(MAX_PAGES);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/main/calendar/client.test.ts`
Expected: FAIL with `Failed to resolve import "./client"`.

- [ ] **Step 3: Implement the client**

Create `src/main/calendar/client.ts`:

```ts
import type Database from 'better-sqlite3';
import {
  GoogleAuthError,
  GoogleConflictError,
  GoogleNetworkError,
  GoogleNotFoundError,
  GoogleRateLimitError,
} from './errors';
import { refreshAccessToken } from './oauth';
import {
  clearCachedAccessToken,
  getCachedAccessToken,
  getGoogleClientConfig,
  getGoogleRefreshToken,
  setCachedAccessToken,
  setGoogleRefreshToken,
} from './token';

const API_BASE = 'https://www.googleapis.com/calendar/v3';

/**
 * Safety cap on pagination. At maxResults=250 this is 12,500 events inside a
 * 240-day window -- far past any real calendar, but bounded if a nextPageToken
 * ever fails to terminate.
 * ponytail: fixed cap; parameterize only if a real calendar exceeds it.
 */
export const MAX_PAGES = 50;

export type QueryParams = Record<string, string | number | boolean>;

export interface RequestOptions {
  method?: string;
  query?: QueryParams;
  body?: unknown;
  /** Sent as If-Match so a write cannot clobber a change made elsewhere. */
  etag?: string;
}

/**
 * Returns a usable access token, refreshing through the refresh token when the
 * cached one is missing or near expiry. Access tokens are never persisted.
 */
export async function getAccessToken(db: Database.Database): Promise<string> {
  const cached = getCachedAccessToken();
  if (cached !== null) return cached;

  const config = getGoogleClientConfig(db);
  const refreshToken = getGoogleRefreshToken(db);
  if (config === null || refreshToken === null) {
    throw new GoogleAuthError('Google Calendar is not connected.');
  }

  const tokens = await refreshAccessToken(config, refreshToken);
  setCachedAccessToken(tokens.accessToken, tokens.expiresIn);
  // Google usually omits this on refresh, but when it does rotate the token,
  // failing to store the new one strands the app on a dead credential.
  if (tokens.refreshToken !== null) setGoogleRefreshToken(db, tokens.refreshToken);
  return tokens.accessToken;
}

function buildUrl(path: string, query: QueryParams = {}): string {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function isRateLimitBody(body: string): boolean {
  return /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(body);
}

export async function googleRequest<T>(
  db: Database.Database,
  path: string,
  options: RequestOptions = {}
): Promise<T | null> {
  const token = await getAccessToken(db);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.etag !== undefined) headers['If-Match'] = options.etag;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    throw new GoogleNetworkError(error instanceof Error ? error.message : 'Could not reach Google.');
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 401) {
      // Whatever we were holding is not acceptable to Google; keeping it
      // guarantees the next request fails the same way.
      clearCachedAccessToken();
      throw new GoogleAuthError('Google rejected the access token.');
    }
    if (response.status === 429) throw new GoogleRateLimitError();
    if (response.status === 403) {
      // 403 covers both throttling and genuine permission failures, and only
      // the body distinguishes them.
      if (isRateLimitBody(body)) throw new GoogleRateLimitError();
      throw new GoogleNetworkError(`Google returned 403: ${body.slice(0, 200)}`);
    }
    if (response.status === 404 || response.status === 410) throw new GoogleNotFoundError();
    if (response.status === 412) throw new GoogleConflictError();
    throw new GoogleNetworkError(`Google returned ${response.status}.`);
  }

  // DELETE returns 204 with an empty body; JSON.parse('') would throw.
  if (response.status === 204) return null;
  const text = await response.text();
  if (text.length === 0) return null;
  return JSON.parse(text) as T;
}

interface ListResponse<T> {
  items?: T[];
  nextPageToken?: string;
}

/**
 * Fetch every page of a list endpoint SERIALLY, carrying the original query
 * forward on each page. Must never become a parallel fan-out.
 */
export async function googleFetchAll<T>(
  db: Database.Database,
  path: string,
  query: QueryParams = {}
): Promise<T[]> {
  const results: T[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const pageQuery: QueryParams = pageToken === undefined ? query : { ...query, pageToken };
    const response = await googleRequest<ListResponse<T>>(db, path, { query: pageQuery });
    if (response === null) break;
    if (Array.isArray(response.items)) results.push(...response.items);
    if (response.nextPageToken === undefined) break;
    pageToken = response.nextPageToken;
  }

  return results;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/main/calendar/client.test.ts`
Expected: PASS, 13/13.

- [ ] **Step 5: Write the endpoint wrappers**

Create `src/main/calendar/api.ts`:

```ts
import type Database from 'better-sqlite3';
import { googleFetchAll, googleRequest } from './client';

export interface GoogleCalendarListEntry {
  id: string;
  summary?: string;
  timeZone?: string;
  backgroundColor?: string;
  accessRole?: string;
  primary?: boolean;
}

/** Google sends `dateTime` for timed events and `date` for all-day ones. */
export interface GoogleEventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
  status?: string;
  htmlLink?: string;
  organizer?: { email?: string };
  attendees?: Array<{ email?: string; self?: boolean }>;
  recurringEventId?: string;
  etag?: string;
  updated?: string;
}

/** The subset of Google's event body this app writes. */
export interface GoogleEventInput {
  summary: string;
  description?: string;
  location?: string;
  start: GoogleEventDateTime;
  end: GoogleEventDateTime;
  attendees?: Array<{ email: string }>;
}

export function listCalendars(db: Database.Database): Promise<GoogleCalendarListEntry[]> {
  return googleFetchAll<GoogleCalendarListEntry>(db, '/users/me/calendarList', { maxResults: 250 });
}

/**
 * singleEvents=true makes Google expand recurring events into concrete
 * instances server-side. That is the entire reason this app needs no RRULE
 * engine, so it must not be removed.
 */
export function listEvents(
  db: Database.Database,
  calendarId: string,
  timeMin: string,
  timeMax: string
): Promise<GoogleEvent[]> {
  return googleFetchAll<GoogleEvent>(db, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
    showDeleted: false,
    timeMin,
    timeMax,
  });
}

export async function createEvent(
  db: Database.Database,
  calendarId: string,
  event: GoogleEventInput
): Promise<GoogleEvent> {
  const created = await googleRequest<GoogleEvent>(
    db,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    { method: 'POST', body: event }
  );
  if (created === null) throw new Error('Google returned no event.');
  return created;
}

export async function updateEvent(
  db: Database.Database,
  calendarId: string,
  eventId: string,
  event: GoogleEventInput,
  etag?: string
): Promise<GoogleEvent> {
  const updated = await googleRequest<GoogleEvent>(
    db,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'PUT', body: event, etag }
  );
  if (updated === null) throw new Error('Google returned no event.');
  return updated;
}

export async function deleteEvent(
  db: Database.Database,
  calendarId: string,
  eventId: string
): Promise<void> {
  await googleRequest(
    db,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' }
  );
}
```

- [ ] **Step 6: Run lint, typecheck, and the calendar tests**

Run: `npm run lint && npm run typecheck && npm run test -- src/main/calendar`
Expected: all exit 0; calendar tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/main/calendar/client.ts src/main/calendar/client.test.ts src/main/calendar/api.ts
git commit -m "Task 3: Google API client with refresh, pagination, and error mapping"
```

---

### Task 4: Shared scheduler extraction

**Files:**
- Create: `src/main/scheduler.ts`
- Create: `src/main/scheduler.test.ts`
- Modify: `src/main/canvas/scheduler.ts`
- **Do NOT modify:** `src/main/canvas/scheduler.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface Scheduler { runNow(): Promise<void>; runExclusive<T>(fn: () => Promise<T>): Promise<T | null>; stop(): void }`
  - `createScheduler(options: { intervalMs: number; focusThrottleMs: number; run: () => Promise<void> }): Scheduler`

**Context for the implementer:** `src/main/canvas/scheduler.ts` currently hand-rolls a self-rescheduling timer, a 5-minute focus throttle, and an in-flight exclusivity guard. Calendar needs the identical machine with different intervals. This task moves that logic into `src/main/scheduler.ts` and rewires Canvas to consume it.

**The existing `src/main/canvas/scheduler.test.ts` is the acceptance test for this refactor.** All 10 of its cases must pass **without editing that file**. If a case fails, the extraction changed behavior and the extraction is wrong — do not adjust the test to match.

Two behaviors in the existing implementation are load-bearing and easy to lose:
1. `lastFocusSync` is seeded to `Date.now()`, not `0`. The scheduler syncs immediately on start, so a focus event a moment later must not trigger a second sync.
2. The timer chain starts with `setTimeout(..., 0)` rather than calling `run()` directly, and reschedules from *completion*. The comment in the current file explains why in terms of vitest's fake-timer semantics — preserve both the behavior and the comment.

- [ ] **Step 1: Write the failing shared-scheduler test**

Create `src/main/scheduler.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listeners = new Map<string, () => void>();

vi.mock('electron', () => ({
  app: { on: (event: string, cb: () => void) => listeners.set(event, cb) },
}));

beforeEach(() => {
  listeners.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createScheduler', () => {
  it('runs once on start', async () => {
    const { createScheduler } = await import('./scheduler');
    const run = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler({ intervalMs: 1000, focusThrottleMs: 500, run });

    await vi.runOnlyPendingTimersAsync();

    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('runs again after the interval elapses', async () => {
    const { createScheduler } = await import('./scheduler');
    const run = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler({ intervalMs: 1000, focusThrottleMs: 500, run });
    await vi.runOnlyPendingTimersAsync();

    await vi.advanceTimersByTimeAsync(1000);

    expect(run).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('never runs two tasks concurrently', async () => {
    const { createScheduler } = await import('./scheduler');
    let inFlight = 0;
    let maxInFlight = 0;
    const run = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 50));
      inFlight -= 1;
    });
    const scheduler = createScheduler({ intervalMs: 100_000, focusThrottleMs: 500, run });

    const a = scheduler.runNow();
    const b = scheduler.runNow();
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([a, b]);

    expect(maxInFlight).toBe(1);
    scheduler.stop();
  });

  it('runExclusive returns null while a task is in flight', async () => {
    const { createScheduler } = await import('./scheduler');
    const run = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const scheduler = createScheduler({ intervalMs: 100_000, focusThrottleMs: 500, run });

    const background = scheduler.runNow();
    const blocked = scheduler.runExclusive(async () => 'value');
    await vi.advanceTimersByTimeAsync(200);
    const [, blockedResult] = await Promise.all([background, blocked]);

    expect(blockedResult).toBeNull();
    scheduler.stop();
  });

  it('runExclusive returns the value when nothing is in flight', async () => {
    const { createScheduler } = await import('./scheduler');
    const scheduler = createScheduler({
      intervalMs: 100_000,
      focusThrottleMs: 500,
      run: vi.fn().mockResolvedValue(undefined),
    });
    await vi.runOnlyPendingTimersAsync();

    await expect(scheduler.runExclusive(async () => 'value')).resolves.toBe('value');
    scheduler.stop();
  });

  it('throttles focus-triggered runs', async () => {
    const { createScheduler } = await import('./scheduler');
    const run = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler({ intervalMs: 100_000, focusThrottleMs: 5000, run });
    await vi.runOnlyPendingTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);

    const onFocus = listeners.get('browser-window-focus');
    onFocus?.();
    onFocus?.();
    // Settle promises without advancing the clock -- runOnlyPendingTimersAsync
    // would jump to the pending interval timer and falsely move time forward.
    await vi.advanceTimersByTimeAsync(0);
    // Seeded to "now" on start, so an immediate focus is inside the throttle.
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6000);
    onFocus?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it('stops scheduling after stop()', async () => {
    const { createScheduler } = await import('./scheduler');
    const run = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler({ intervalMs: 1000, focusThrottleMs: 500, run });
    await vi.runOnlyPendingTimersAsync();
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('survives a task that throws without wedging the guard', async () => {
    const { createScheduler } = await import('./scheduler');
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const scheduler = createScheduler({ intervalMs: 100_000, focusThrottleMs: 500, run });
    await vi.runOnlyPendingTimersAsync();

    await scheduler.runNow();

    expect(run).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/main/scheduler.test.ts`
Expected: FAIL with `Failed to resolve import "./scheduler"`.

- [ ] **Step 3: Implement the shared scheduler**

Create `src/main/scheduler.ts`:

```ts
import { app } from 'electron';

export interface Scheduler {
  /** Run the task now, subject to the in-flight guard. */
  runNow(): Promise<void>;
  /**
   * Run fn() under the same in-flight guard as the scheduled task, so a
   * user-triggered sync can never overlap a background one. Returns null
   * without calling fn if something is already running -- matching the
   * guard's "skip, don't queue" behavior rather than adding a queue.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T | null>;
  stop(): void;
}

export interface SchedulerOptions {
  intervalMs: number;
  focusThrottleMs: number;
  run: () => Promise<void>;
}

/**
 * Self-rescheduling background task runner shared by the Canvas and Calendar
 * sync engines: run on start, run again a fixed delay after each completion,
 * run on window focus (throttled), and never run two at once.
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const { intervalMs, focusThrottleMs, run: runTask } = options;

  // Single in-flight guard. Checked and set synchronously before the first
  // await so two callers can never interleave a run.
  let running = false;
  // Seeded to "now" because the scheduler runs immediately on start -- the
  // first focus a moment later must not trigger a second run.
  let lastFocusRun = Date.now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function runExclusive<T>(fn: () => Promise<T>): Promise<T | null> {
    if (running) return null;
    running = true;
    try {
      return await fn();
    } finally {
      running = false;
    }
  }

  async function runNow(): Promise<void> {
    if (stopped) return;
    await runExclusive(async () => {
      try {
        await runTask();
      } catch {
        // A throwing task must still release the guard (runExclusive's
        // finally guarantees that) and must not break the reschedule chain.
      }
    });
  }

  // Self-rescheduling setTimeout, kicked off with a 0ms delay rather than
  // calling runNow() directly. This isn't cosmetic: it's what makes the first
  // run-on-start behave as a single, isolated tick instead of racing the
  // follow-up interval into the same one. Registering the next timer straight
  // after runNow() resolves means it's always visible for the next *explicit*
  // advance (the background-interval test), while starting the chain from a
  // real (fake-clock) timer keeps each cycle's firing scoped to its own tick.
  function scheduleNext(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void runNow().finally(() => scheduleNext(intervalMs));
    }, delayMs);
  }

  function onFocus(): void {
    const now = Date.now();
    if (now - lastFocusRun < focusThrottleMs) return;
    lastFocusRun = now;
    void runNow();
  }

  app.on('browser-window-focus', onFocus);
  scheduleNext(0);

  return {
    runNow,
    runExclusive,
    stop(): void {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      app.removeListener?.('browser-window-focus', onFocus);
    },
  };
}
```

- [ ] **Step 4: Run the shared-scheduler tests**

Run: `npm run test -- src/main/scheduler.test.ts`
Expected: PASS, 8/8.

- [ ] **Step 5: Rewire Canvas onto the shared scheduler**

Replace the whole body of `src/main/canvas/scheduler.ts` with:

```ts
import type { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { syncCore } from './sync';
import { getCanvasCredentials } from './token';
import { createScheduler } from '../scheduler';

const BACKGROUND_INTERVAL_MS = 30 * 60 * 1000;
const FOCUS_THROTTLE_MS = 5 * 60 * 1000;

export interface CanvasScheduler {
  syncNow(): Promise<void>;
  // Runs fn() under the same in-flight guard as the background/focus syncs,
  // so a manual per-course sync (canvas:sync-course) can never overlap a
  // scheduled one. Returns null, without calling fn, if something is
  // already syncing.
  runExclusive<T>(fn: () => Promise<T>): Promise<T | null>;
  stop(): void;
}

export function startCanvasScheduler(
  db: Database.Database,
  getWindow: () => BrowserWindow | null
): CanvasScheduler {
  const scheduler = createScheduler({
    intervalMs: BACKGROUND_INTERVAL_MS,
    focusThrottleMs: FOCUS_THROTTLE_MS,
    run: async () => {
      const creds = getCanvasCredentials(db);
      if (creds === null) return;
      await syncCore(db, creds);
      // Deliberately after the await: a failed sync throws past this line, so
      // the renderer is only told to refetch when there is new data.
      getWindow()?.webContents.send('canvas:sync-changed');
    },
  });

  return {
    syncNow: () => scheduler.runNow(),
    runExclusive: (fn) => scheduler.runExclusive(fn),
    stop: () => scheduler.stop(),
  };
}
```

- [ ] **Step 6: Verify the untouched Canvas scheduler tests still pass**

Run: `npm run test -- src/main/canvas/scheduler.test.ts`
Expected: PASS, 10/10, with `src/main/canvas/scheduler.test.ts` unmodified. Confirm with `git status` that the test file is not in the diff.

If any case fails, the extraction changed behavior — fix `src/main/scheduler.ts` or the Canvas wrapper. **Do not edit the test.**

- [ ] **Step 7: Run the full suite**

Run: `npm run test`
Expected: PASS. Every pre-existing test must still pass; this task adds 8.

- [ ] **Step 8: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/main/scheduler.ts src/main/scheduler.test.ts src/main/canvas/scheduler.ts
git commit -m "Task 4: extract shared scheduler and rewire Canvas onto it"
```

---

### Task 5: Sync engine

**Files:**
- Create: `src/main/calendar/sync.ts`
- Create: `src/main/calendar/sync.test.ts`

**Interfaces:**
- Consumes: from Task 3 `listCalendars`, `listEvents`, and the types `GoogleCalendarListEntry`, `GoogleEvent`. From Task 1 the error classes.
- Produces:
  - `SYNC_KEY_LAST_SYNC`, `SYNC_KEY_TOKEN_INVALID`
  - `getSyncState(db, key): string | null`, `setSyncState(db, key, value): void`, `clearSyncState(db, key): void`
  - `syncWindow(now?: Date): { timeMin: string; timeMax: string; deleteMin: string; deleteMax: string }`
  - `interface CalendarSyncResult { ok: boolean; calendarsSynced: number; eventsSynced: number; tokenInvalid: boolean; errors: string[] }`
  - `syncAll(db, now?): Promise<CalendarSyncResult>`
  - `syncOneCalendar(db, calendarId: string, now?): Promise<void>`

**Context for the implementer:** two mixed date formats live in `google_events.start_at` — RFC3339 timestamps for timed events and bare `YYYY-MM-DD` dates for all-day events. Comparing a bare date against a full timestamp lexicographically is where the subtle bugs live, and the delete-window bounds below are deliberately **date-only strings** so both formats compare correctly. Read the comment on `syncWindow` before changing any comparison.

- [ ] **Step 1: Write the failing sync test**

Create `src/main/calendar/sync.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

vi.mock('./api', () => ({
  listCalendars: vi.fn(),
  listEvents: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
}));

import { listCalendars, listEvents } from './api';

const NOW = new Date('2026-08-20T12:00:00.000Z');

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    create table settings (key text primary key, value text not null);
    create table google_calendars (
      id text primary key, summary text not null, time_zone text, background_color text,
      access_role text, is_primary integer not null default 0, enabled integer not null default 1,
      synced_at text not null default (datetime('now'))
    );
    create table google_events (
      calendar_id text not null references google_calendars(id) on delete cascade,
      id text not null, summary text, description text, location text,
      start_at text not null, end_at text not null, is_all_day integer not null default 0,
      status text, html_link text, organizer_email text,
      has_guests integer not null default 0, guest_count integer not null default 0,
      recurring_event_id text, etag text, updated_at text,
      synced_at text not null default (datetime('now')),
      primary key (calendar_id, id)
    );
    create table calendar_sync_state (key text primary key, value text not null);
  `);
  return db;
}

const PRIMARY = {
  id: 'me@example.com',
  summary: 'Personal',
  timeZone: 'America/New_York',
  backgroundColor: '#3B82F6',
  accessRole: 'owner',
  primary: true,
};

function timedEvent(id: string, startIso: string, endIso: string, extra = {}): unknown {
  return {
    id,
    summary: `Event ${id}`,
    start: { dateTime: startIso },
    end: { dateTime: endIso },
    etag: `"etag-${id}"`,
    htmlLink: `https://calendar.google.com/${id}`,
    ...extra,
  };
}

beforeEach(() => {
  vi.mocked(listCalendars).mockReset();
  vi.mocked(listEvents).mockReset();
  vi.mocked(listCalendars).mockResolvedValue([PRIMARY] as never);
  vi.mocked(listEvents).mockResolvedValue([] as never);
});

describe('syncWindow', () => {
  it('spans 60 days back and 180 forward, with date-only delete bounds', async () => {
    const { syncWindow } = await import('./sync');
    const w = syncWindow(NOW);

    expect(w.timeMin).toBe('2026-06-21T12:00:00.000Z');
    expect(w.timeMax).toBe('2027-02-16T12:00:00.000Z');
    // Date-only, and the upper bound is the day AFTER timeMax's date, so an
    // all-day event stored as "2027-02-16" still falls inside a `< deleteMax`
    // comparison.
    expect(w.deleteMin).toBe('2026-06-21');
    expect(w.deleteMax).toBe('2027-02-17');
  });
});

describe('syncAll', () => {
  it('stores calendars and marks the primary one', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();

    await syncAll(db, NOW);

    const row = db.prepare('select * from google_calendars').get() as Record<string, unknown>;
    expect(row.id).toBe('me@example.com');
    expect(row.summary).toBe('Personal');
    expect(row.is_primary).toBe(1);
    expect(row.enabled).toBe(1);
  });

  it('never overwrites the user enabled flag on resync', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    await syncAll(db, NOW);

    db.prepare('update google_calendars set enabled = 0 where id = ?').run('me@example.com');
    await syncAll(db, NOW);

    const row = db.prepare('select enabled from google_calendars').get() as { enabled: number };
    // A resync silently re-enabling a calendar the user switched off would be
    // maddening and near-impossible to diagnose.
    expect(row.enabled).toBe(0);
  });

  it('skips fetching events for disabled calendars', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    await syncAll(db, NOW);
    db.prepare('update google_calendars set enabled = 0').run();

    vi.mocked(listEvents).mockClear();
    await syncAll(db, NOW);

    expect(listEvents).not.toHaveBeenCalled();
  });

  it('keeps a disabled calendar rows rather than deleting them', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    vi.mocked(listEvents).mockResolvedValue([
      timedEvent('e1', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z'),
    ] as never);
    await syncAll(db, NOW);
    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 1 });

    db.prepare('update google_calendars set enabled = 0').run();
    await syncAll(db, NOW);

    // Rows survive so re-enabling is instant instead of waiting for a refetch.
    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 1 });
  });

  it('stores a timed event with is_all_day = 0', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    vi.mocked(listEvents).mockResolvedValue([
      timedEvent('e1', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z', { location: 'Room 5' }),
    ] as never);

    await syncAll(db, NOW);

    const row = db.prepare('select * from google_events').get() as Record<string, unknown>;
    expect(row.start_at).toBe('2026-08-21T14:00:00Z');
    expect(row.end_at).toBe('2026-08-21T15:00:00Z');
    expect(row.is_all_day).toBe(0);
    expect(row.location).toBe('Room 5');
    expect(row.etag).toBe('"etag-e1"');
  });

  it('stores an all-day event as a raw date string, never a timestamp', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    vi.mocked(listEvents).mockResolvedValue([
      { id: 'a1', summary: 'Holiday', start: { date: '2026-08-25' }, end: { date: '2026-08-26' } },
    ] as never);

    await syncAll(db, NOW);

    const row = db.prepare('select * from google_events').get() as Record<string, unknown>;
    expect(row.is_all_day).toBe(1);
    // Storing "2026-08-25T00:00:00Z" here is the classic all-day bug: it
    // renders on the 24th for anyone west of UTC.
    expect(row.start_at).toBe('2026-08-25');
    expect(row.end_at).toBe('2026-08-26');
  });

  it('counts only other people as guests, not the user themselves', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    vi.mocked(listEvents).mockResolvedValue([
      timedEvent('solo', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z', {
        attendees: [{ email: 'me@example.com', self: true }],
      }),
      timedEvent('group', '2026-08-22T14:00:00Z', '2026-08-22T15:00:00Z', {
        attendees: [
          { email: 'me@example.com', self: true },
          { email: 'a@example.com' },
          { email: 'b@example.com' },
        ],
      }),
    ] as never);

    await syncAll(db, NOW);

    const rows = db
      .prepare('select id, has_guests, guest_count from google_events order by id')
      .all() as Array<{ id: string; has_guests: number; guest_count: number }>;
    // An event whose only "attendee" is you is a solo event -- treating it as
    // having guests would escalate it to CONSEQUENTIAL for no reason.
    expect(rows).toEqual([
      { id: 'group', has_guests: 1, guest_count: 2 },
      { id: 'solo', has_guests: 0, guest_count: 0 },
    ]);
  });

  it('removes events that vanished from Google', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    vi.mocked(listEvents).mockResolvedValue([
      timedEvent('e1', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z'),
      timedEvent('e2', '2026-08-22T14:00:00Z', '2026-08-22T15:00:00Z'),
    ] as never);
    await syncAll(db, NOW);

    vi.mocked(listEvents).mockResolvedValue([
      timedEvent('e1', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z'),
    ] as never);
    await syncAll(db, NOW);

    const ids = db.prepare('select id from google_events').all() as Array<{ id: string }>;
    expect(ids).toEqual([{ id: 'e1' }]);
  });

  it('deletes an all-day event sitting exactly on the window boundary', async () => {
    const { syncAll, syncWindow } = await import('./sync');
    const db = makeDb();
    const boundary = syncWindow(NOW).deleteMin;
    vi.mocked(listEvents).mockResolvedValue([
      { id: 'edge', summary: 'Edge', start: { date: boundary }, end: { date: '2026-06-22' } },
    ] as never);
    await syncAll(db, NOW);
    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 1 });

    vi.mocked(listEvents).mockResolvedValue([] as never);
    await syncAll(db, NOW);

    // A bare date compares lexicographically BEFORE a same-day timestamp, so
    // a timestamp lower bound would leave this row orphaned forever.
    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 0 });
  });

  it('is idempotent across repeated syncs', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    vi.mocked(listEvents).mockResolvedValue([
      timedEvent('e1', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z'),
    ] as never);

    await syncAll(db, NOW);
    await syncAll(db, NOW);

    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 1 });
  });

  it('drops calendars Google no longer returns, cascading their events', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    vi.mocked(listCalendars).mockResolvedValue([PRIMARY, { id: 'other', summary: 'Other' }] as never);
    vi.mocked(listEvents).mockResolvedValue([
      timedEvent('e1', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z'),
    ] as never);
    await syncAll(db, NOW);
    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 2 });

    vi.mocked(listCalendars).mockResolvedValue([PRIMARY] as never);
    await syncAll(db, NOW);

    expect(db.prepare('select count(*) as n from google_calendars').get()).toEqual({ n: 1 });
    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 1 });
  });

  it('records the account email from the primary calendar', async () => {
    const { syncAll } = await import('./sync');
    const { getGoogleAccountEmail } = await import('./token');
    const db = makeDb();

    await syncAll(db, NOW);

    // The primary calendar's id IS the account email, so this costs nothing
    // and avoids requesting a userinfo scope the app does not otherwise need.
    expect(getGoogleAccountEmail(db)).toBe('me@example.com');
  });

  it('keeps syncing other calendars when one fails', async () => {
    const { syncAll } = await import('./sync');
    const db = makeDb();
    vi.mocked(listCalendars).mockResolvedValue([PRIMARY, { id: 'other', summary: 'Other' }] as never);
    vi.mocked(listEvents).mockImplementation(async (_db, calendarId) => {
      if (calendarId === 'other') throw new Error('boom');
      return [timedEvent('e1', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z')] as never;
    });

    const result = await syncAll(db, NOW);

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    // One broken calendar must not cost the user the others.
    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 1 });
  });

  it('flags an invalid token and stops, leaving existing rows intact', async () => {
    const { syncAll, getSyncState, SYNC_KEY_TOKEN_INVALID } = await import('./sync');
    const { GoogleAuthError } = await import('./errors');
    const db = makeDb();
    vi.mocked(listEvents).mockResolvedValue([
      timedEvent('e1', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z'),
    ] as never);
    await syncAll(db, NOW);

    vi.mocked(listCalendars).mockRejectedValue(new GoogleAuthError());
    const result = await syncAll(db, NOW);

    expect(result.tokenInvalid).toBe(true);
    expect(getSyncState(db, SYNC_KEY_TOKEN_INVALID)).toBe('1');
    // A dead token means stale data, never a blank screen.
    expect(db.prepare('select count(*) as n from google_events').get()).toEqual({ n: 1 });
  });

  it('clears the token-invalid flag after a successful sync', async () => {
    const { syncAll, getSyncState, setSyncState, SYNC_KEY_TOKEN_INVALID } = await import('./sync');
    const db = makeDb();
    setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');

    await syncAll(db, NOW);

    expect(getSyncState(db, SYNC_KEY_TOKEN_INVALID)).toBeNull();
  });

  it('aborts the run on a rate limit rather than hammering', async () => {
    const { syncAll } = await import('./sync');
    const { GoogleRateLimitError } = await import('./errors');
    const db = makeDb();
    vi.mocked(listCalendars).mockResolvedValue([PRIMARY, { id: 'other', summary: 'Other' }] as never);
    vi.mocked(listEvents).mockRejectedValue(new GoogleRateLimitError());

    const result = await syncAll(db, NOW);

    expect(result.ok).toBe(false);
    // Stops after the first 429 instead of burning the remaining quota.
    expect(vi.mocked(listEvents)).toHaveBeenCalledTimes(1);
  });

  it('records the last sync timestamp', async () => {
    const { syncAll, getSyncState, SYNC_KEY_LAST_SYNC } = await import('./sync');
    const db = makeDb();

    await syncAll(db, NOW);

    expect(getSyncState(db, SYNC_KEY_LAST_SYNC)).toBe(NOW.toISOString());
  });
});

describe('syncOneCalendar', () => {
  it('refetches only the named calendar', async () => {
    const { syncAll, syncOneCalendar } = await import('./sync');
    const db = makeDb();
    vi.mocked(listCalendars).mockResolvedValue([PRIMARY, { id: 'other', summary: 'Other' }] as never);
    await syncAll(db, NOW);

    vi.mocked(listEvents).mockClear();
    vi.mocked(listEvents).mockResolvedValue([
      timedEvent('new', '2026-08-21T14:00:00Z', '2026-08-21T15:00:00Z'),
    ] as never);
    await syncOneCalendar(db, 'other', NOW);

    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listEvents).mock.calls[0][1]).toBe('other');
    const row = db.prepare('select calendar_id from google_events').get() as { calendar_id: string };
    expect(row.calendar_id).toBe('other');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/main/calendar/sync.test.ts`
Expected: FAIL with `Failed to resolve import "./sync"`.

- [ ] **Step 3: Implement the sync engine**

Create `src/main/calendar/sync.ts`:

```ts
import type Database from 'better-sqlite3';
import * as api from './api';
import type { GoogleCalendarListEntry, GoogleEvent } from './api';
import { GoogleAuthError, GoogleRateLimitError } from './errors';
import { setGoogleAccountEmail } from './token';

export const SYNC_KEY_LAST_SYNC = 'last_sync';
export const SYNC_KEY_TOKEN_INVALID = 'token_invalid';

const WINDOW_BACK_DAYS = 60;
const WINDOW_FORWARD_DAYS = 180;
const MS_PER_DAY = 86_400_000;

export interface CalendarSyncResult {
  ok: boolean;
  calendarsSynced: number;
  eventsSynced: number;
  tokenInvalid: boolean;
  errors: string[];
}

export function getSyncState(db: Database.Database, key: string): string | null {
  const row = db.prepare('select value from calendar_sync_state where key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setSyncState(db: Database.Database, key: string, value: string): void {
  db.prepare(
    'insert into calendar_sync_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
  ).run(key, value);
}

export function clearSyncState(db: Database.Database, key: string): void {
  db.prepare('delete from calendar_sync_state where key = ?').run(key);
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The rolling sync window.
 *
 * `timeMin`/`timeMax` are RFC3339 and go to Google. `deleteMin`/`deleteMax`
 * are DATE-ONLY and are used for the local delete-and-reinsert, because
 * `google_events.start_at` holds two formats: RFC3339 for timed events and a
 * bare `YYYY-MM-DD` for all-day ones. Lexicographically a bare date sorts
 * BEFORE a same-day timestamp ("2026-06-21" < "2026-06-21T00:00:00.000Z"), so
 * an all-day event on the window's first day would escape a timestamp lower
 * bound and be orphaned forever. `deleteMax` is the day after `timeMax` so the
 * upper comparison can stay exclusive and still include that final day.
 */
export function syncWindow(now: Date = new Date()): {
  timeMin: string;
  timeMax: string;
  deleteMin: string;
  deleteMax: string;
} {
  const min = new Date(now.getTime() - WINDOW_BACK_DAYS * MS_PER_DAY);
  const max = new Date(now.getTime() + WINDOW_FORWARD_DAYS * MS_PER_DAY);
  return {
    timeMin: min.toISOString(),
    timeMax: max.toISOString(),
    deleteMin: dateOnly(min),
    deleteMax: dateOnly(new Date(max.getTime() + MS_PER_DAY)),
  };
}

interface EventRowValues {
  calendar_id: string;
  id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  start_at: string;
  end_at: string;
  is_all_day: number;
  status: string | null;
  html_link: string | null;
  organizer_email: string | null;
  has_guests: number;
  guest_count: number;
  recurring_event_id: string | null;
  etag: string | null;
  updated_at: string | null;
  synced_at: string;
}

/**
 * Returns null for anything unusable: a cancelled event, or one with neither a
 * dateTime nor a date. Both are cheaper to skip than to represent.
 */
function normalizeEvent(
  calendarId: string,
  event: GoogleEvent,
  syncedAt: string
): EventRowValues | null {
  if (event.status === 'cancelled') return null;

  const startDate = event.start?.date ?? null;
  const endDate = event.end?.date ?? null;
  const startTime = event.start?.dateTime ?? null;
  const endTime = event.end?.dateTime ?? null;

  const isAllDay = startDate !== null;
  // All-day events keep Google's raw date string. Converting to a timestamp
  // here shifts the event to the previous day for any user west of UTC.
  const startAt = isAllDay ? startDate : startTime;
  const endAt = isAllDay ? (endDate ?? startDate) : (endTime ?? startTime);
  if (startAt === null || endAt === null) return null;

  // Only OTHER people count as guests. An event whose sole attendee is the
  // user is a solo event, and escalating it to CONSEQUENTIAL would make the
  // assistant ask permission for nothing.
  const guests = (event.attendees ?? []).filter((attendee) => attendee.self !== true);

  return {
    calendar_id: calendarId,
    id: event.id,
    summary: event.summary ?? null,
    description: event.description ?? null,
    location: event.location ?? null,
    start_at: startAt,
    end_at: endAt,
    is_all_day: isAllDay ? 1 : 0,
    status: event.status ?? null,
    html_link: event.htmlLink ?? null,
    organizer_email: event.organizer?.email ?? null,
    has_guests: guests.length > 0 ? 1 : 0,
    guest_count: guests.length,
    recurring_event_id: event.recurringEventId ?? null,
    etag: event.etag ?? null,
    updated_at: event.updated ?? null,
    synced_at: syncedAt,
  };
}

function upsertCalendars(
  db: Database.Database,
  calendars: GoogleCalendarListEntry[],
  syncedAt: string
): void {
  // `enabled` is deliberately absent from the update clause: it is user state,
  // not Google state, and a resync must never flip it back on.
  const upsert = db.prepare(
    `insert into google_calendars (id, summary, time_zone, background_color, access_role, is_primary, synced_at)
     values (@id, @summary, @time_zone, @background_color, @access_role, @is_primary, @synced_at)
     on conflict(id) do update set
       summary = excluded.summary, time_zone = excluded.time_zone,
       background_color = excluded.background_color, access_role = excluded.access_role,
       is_primary = excluded.is_primary, synced_at = excluded.synced_at`
  );

  const run = db.transaction((rows: GoogleCalendarListEntry[]) => {
    for (const calendar of rows) {
      upsert.run({
        id: calendar.id,
        summary: calendar.summary ?? calendar.id,
        time_zone: calendar.timeZone ?? null,
        background_color: calendar.backgroundColor ?? null,
        access_role: calendar.accessRole ?? null,
        is_primary: calendar.primary === true ? 1 : 0,
        synced_at: syncedAt,
      });
    }
    // Calendars the user removed in Google should disappear here too; events
    // cascade via the foreign key.
    const ids = rows.map((calendar) => calendar.id);
    const placeholders = ids.map(() => '?').join(',');
    if (ids.length === 0) {
      db.prepare('delete from google_calendars').run();
    } else {
      db.prepare(`delete from google_calendars where id not in (${placeholders})`).run(...ids);
    }
  });

  run(calendars);
}

function replaceWindow(
  db: Database.Database,
  calendarId: string,
  rows: EventRowValues[],
  deleteMin: string,
  deleteMax: string
): void {
  const insert = db.prepare(
    `insert into google_events (
       calendar_id, id, summary, description, location, start_at, end_at, is_all_day,
       status, html_link, organizer_email, has_guests, guest_count, recurring_event_id,
       etag, updated_at, synced_at
     ) values (
       @calendar_id, @id, @summary, @description, @location, @start_at, @end_at, @is_all_day,
       @status, @html_link, @organizer_email, @has_guests, @guest_count, @recurring_event_id,
       @etag, @updated_at, @synced_at
     )`
  );

  // Delete-then-insert instead of diffing: an event deleted in Google is
  // simply absent from the response, so it disappears here with no tombstone
  // bookkeeping. Correct by construction. Rows outside the window survive.
  const run = db.transaction((events: EventRowValues[]) => {
    db.prepare(
      'delete from google_events where calendar_id = ? and start_at >= ? and start_at < ?'
    ).run(calendarId, deleteMin, deleteMax);
    for (const event of events) insert.run(event);
  });

  run(rows);
}

async function syncCalendarEvents(
  db: Database.Database,
  calendarId: string,
  now: Date
): Promise<number> {
  const { timeMin, timeMax, deleteMin, deleteMax } = syncWindow(now);
  const events = await api.listEvents(db, calendarId, timeMin, timeMax);
  const syncedAt = now.toISOString();
  const rows = events
    .map((event) => normalizeEvent(calendarId, event, syncedAt))
    .filter((row): row is EventRowValues => row !== null);
  replaceWindow(db, calendarId, rows, deleteMin, deleteMax);
  return rows.length;
}

/** Refetch a single calendar's window. Used right after a write lands. */
export async function syncOneCalendar(
  db: Database.Database,
  calendarId: string,
  now: Date = new Date()
): Promise<void> {
  await syncCalendarEvents(db, calendarId, now);
}

/**
 * Full sync: calendar list, then each enabled calendar's events, strictly
 * one request chain at a time.
 */
export async function syncAll(
  db: Database.Database,
  now: Date = new Date()
): Promise<CalendarSyncResult> {
  const result: CalendarSyncResult = {
    ok: true,
    calendarsSynced: 0,
    eventsSynced: 0,
    tokenInvalid: false,
    errors: [],
  };

  let calendars: GoogleCalendarListEntry[];
  try {
    calendars = await api.listCalendars(db);
  } catch (error) {
    if (error instanceof GoogleAuthError) {
      setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');
      return { ...result, ok: false, tokenInvalid: true, errors: ['Google rejected the credentials.'] };
    }
    return { ...result, ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }

  upsertCalendars(db, calendars, now.toISOString());

  // The primary calendar's id is the account's email address, so the account
  // name comes free with the list and needs no extra scope.
  const primary = calendars.find((calendar) => calendar.primary === true);
  if (primary !== undefined) setGoogleAccountEmail(db, primary.id);

  const enabled = db
    .prepare('select id from google_calendars where enabled = 1 order by is_primary desc, id')
    .all() as Array<{ id: string }>;

  // Serial by construction. Google advises against concurrent request chains,
  // and this must never become a Promise.all fan-out.
  for (const calendar of enabled) {
    try {
      result.eventsSynced += await syncCalendarEvents(db, calendar.id, now);
      result.calendarsSynced += 1;
    } catch (error) {
      result.ok = false;
      if (error instanceof GoogleAuthError) {
        setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');
        return { ...result, tokenInvalid: true, errors: [...result.errors, 'Google rejected the credentials.'] };
      }
      if (error instanceof GoogleRateLimitError) {
        // Back off for this cycle instead of burning the remaining quota on
        // calendars that will be throttled too.
        result.errors.push('Google is rate limiting; skipped the rest of this sync.');
        return result;
      }
      // One broken calendar must not cost the user the others.
      result.errors.push(`${calendar.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (result.ok) {
    clearSyncState(db, SYNC_KEY_TOKEN_INVALID);
  }
  setSyncState(db, SYNC_KEY_LAST_SYNC, now.toISOString());
  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/main/calendar/sync.test.ts`
Expected: PASS, 19/19.

- [ ] **Step 5: Confirm the sync engine never fans out**

Run: `grep -rn "Promise.all" src/main/calendar/`
Expected: no output.

- [ ] **Step 6: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/main/calendar/sync.ts src/main/calendar/sync.test.ts
git commit -m "Task 5: windowed calendar sync engine with delete-and-reinsert"
```

---

### Task 6: Local queries

**Files:**
- Create: `src/main/calendar/queries.ts`
- Create: `src/main/calendar/queries.test.ts`

**Interfaces:**
- Consumes: from Task 1 `getGoogleClientConfig`, `hasGoogleAuth`, `getGoogleAccountEmail`. From Task 5 `getSyncState`, `SYNC_KEY_LAST_SYNC`, `SYNC_KEY_TOKEN_INVALID`.
- Produces:
  - `interface CalendarStatus { clientConfigured: boolean; connected: boolean; accountEmail: string | null; lastSyncedAt: string | null; tokenInvalid: boolean }`
  - `interface CalendarRow { id: string; summary: string; backgroundColor: string | null; isPrimary: boolean; enabled: boolean }`
  - `interface EventRow { calendarId: string; id: string; summary: string | null; description: string | null; location: string | null; startAt: string; endAt: string; isAllDay: boolean; htmlLink: string | null; hasGuests: boolean; guestCount: number; etag: string | null }`
  - `interface AssignmentDueRow { id: number; courseName: string; name: string; dueAt: string; courseId: number }`
  - `getCalendarStatus(db): CalendarStatus`
  - `listCalendarRows(db): CalendarRow[]`
  - `setCalendarEnabled(db, calendarId: string, enabled: boolean): void`
  - `getEventsInRange(db, fromDate: string, toDate: string): EventRow[]`
  - `getEvent(db, calendarId: string, eventId: string): EventRow | null`
  - `getAssignmentDueDates(db, fromDate: string, toDate: string): AssignmentDueRow[]`

**Context for the implementer:** `fromDate`/`toDate` are **date-only strings** (`YYYY-MM-DD`). Range comparisons use SQLite's `date()` function, which normalizes both stored formats — `date('2026-08-20')` and `date('2026-08-20T14:00:00Z')` both yield `'2026-08-20'` — so one comparison handles timed and all-day events without branching.

`getAssignmentDueDates` reads the **Canvas** tables from Phase 3. Calendar must work fully with Canvas disconnected, in which case those tables are simply empty.

- [ ] **Step 1: Write the failing test**

Create `src/main/calendar/queries.test.ts`:

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
  db.pragma('foreign_keys = ON');
  db.exec(`
    create table settings (key text primary key, value text not null);
    create table google_calendars (
      id text primary key, summary text not null, time_zone text, background_color text,
      access_role text, is_primary integer not null default 0, enabled integer not null default 1,
      synced_at text not null default (datetime('now'))
    );
    create table google_events (
      calendar_id text not null references google_calendars(id) on delete cascade,
      id text not null, summary text, description text, location text,
      start_at text not null, end_at text not null, is_all_day integer not null default 0,
      status text, html_link text, organizer_email text,
      has_guests integer not null default 0, guest_count integer not null default 0,
      recurring_event_id text, etag text, updated_at text,
      synced_at text not null default (datetime('now')),
      primary key (calendar_id, id)
    );
    create table calendar_sync_state (key text primary key, value text not null);
    create table canvas_courses (id integer primary key, name text not null);
    create table canvas_assignments (
      id integer primary key, course_id integer not null references canvas_courses(id) on delete cascade,
      name text not null, due_at text, html_url text, has_submitted integer not null default 0
    );
  `);
  db.prepare(
    "insert into google_calendars (id, summary, background_color, is_primary) values ('me@example.com','Personal','#3B82F6',1)"
  ).run();
  db.prepare(
    "insert into google_calendars (id, summary, is_primary, enabled) values ('other','Other',0,0)"
  ).run();
  return db;
}

function addEvent(db: Database.Database, values: Record<string, unknown>): void {
  db.prepare(
    `insert into google_events (calendar_id, id, summary, start_at, end_at, is_all_day, has_guests, guest_count, etag)
     values (@calendar_id, @id, @summary, @start_at, @end_at, @is_all_day, @has_guests, @guest_count, @etag)`
  ).run({
    calendar_id: 'me@example.com',
    summary: 'Event',
    is_all_day: 0,
    has_guests: 0,
    guest_count: 0,
    etag: null,
    ...values,
  });
}

describe('getCalendarStatus', () => {
  it('reports nothing configured on a fresh database', async () => {
    const { getCalendarStatus } = await import('./queries');
    const status = getCalendarStatus(makeDb());

    expect(status.clientConfigured).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.accountEmail).toBeNull();
    expect(status.tokenInvalid).toBe(false);
  });

  it('reports connected once a client config and refresh token exist', async () => {
    const { getCalendarStatus } = await import('./queries');
    const { setGoogleClientConfig, setGoogleRefreshToken, setGoogleAccountEmail } = await import('./token');
    const db = makeDb();
    setGoogleClientConfig(db, 'client', 'secret');
    setGoogleRefreshToken(db, 'rt');
    setGoogleAccountEmail(db, 'me@example.com');

    const status = getCalendarStatus(db);
    expect(status.clientConfigured).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.accountEmail).toBe('me@example.com');
  });

  it('surfaces the token-invalid flag', async () => {
    const { getCalendarStatus } = await import('./queries');
    const { setSyncState, SYNC_KEY_TOKEN_INVALID } = await import('./sync');
    const db = makeDb();
    setSyncState(db, SYNC_KEY_TOKEN_INVALID, '1');

    expect(getCalendarStatus(db).tokenInvalid).toBe(true);
  });
});

describe('listCalendarRows and setCalendarEnabled', () => {
  it('lists calendars with the primary first and reports enabled state', async () => {
    const { listCalendarRows } = await import('./queries');
    const rows = listCalendarRows(makeDb());

    expect(rows).toEqual([
      { id: 'me@example.com', summary: 'Personal', backgroundColor: '#3B82F6', isPrimary: true, enabled: true },
      { id: 'other', summary: 'Other', backgroundColor: null, isPrimary: false, enabled: false },
    ]);
  });

  it('toggles a calendar on and off', async () => {
    const { listCalendarRows, setCalendarEnabled } = await import('./queries');
    const db = makeDb();

    setCalendarEnabled(db, 'other', true);
    expect(listCalendarRows(db).find((c) => c.id === 'other')?.enabled).toBe(true);

    setCalendarEnabled(db, 'other', false);
    expect(listCalendarRows(db).find((c) => c.id === 'other')?.enabled).toBe(false);
  });
});

describe('getEventsInRange', () => {
  it('returns timed events inside the range, ordered by start', async () => {
    const { getEventsInRange } = await import('./queries');
    const db = makeDb();
    addEvent(db, { id: 'b', start_at: '2026-08-21T15:00:00Z', end_at: '2026-08-21T16:00:00Z' });
    addEvent(db, { id: 'a', start_at: '2026-08-21T09:00:00Z', end_at: '2026-08-21T10:00:00Z' });

    const rows = getEventsInRange(db, '2026-08-17', '2026-08-23');
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('includes all-day events stored as bare dates', async () => {
    const { getEventsInRange } = await import('./queries');
    const db = makeDb();
    addEvent(db, { id: 'allday', start_at: '2026-08-21', end_at: '2026-08-22', is_all_day: 1 });

    const rows = getEventsInRange(db, '2026-08-17', '2026-08-23');
    expect(rows).toHaveLength(1);
    // The raw date must survive the round trip untouched.
    expect(rows[0].startAt).toBe('2026-08-21');
    expect(rows[0].isAllDay).toBe(true);
  });

  it('includes a multi-day event that started before the range', async () => {
    const { getEventsInRange } = await import('./queries');
    const db = makeDb();
    addEvent(db, { id: 'trip', start_at: '2026-08-15', end_at: '2026-08-20', is_all_day: 1 });

    // A week view that dropped an in-progress vacation would be plainly wrong.
    expect(getEventsInRange(db, '2026-08-17', '2026-08-23')).toHaveLength(1);
  });

  it('excludes events from disabled calendars', async () => {
    const { getEventsInRange } = await import('./queries');
    const db = makeDb();
    addEvent(db, { id: 'hidden', calendar_id: 'other', start_at: '2026-08-21T09:00:00Z', end_at: '2026-08-21T10:00:00Z' });

    expect(getEventsInRange(db, '2026-08-17', '2026-08-23')).toHaveLength(0);
  });

  it('excludes events outside the range', async () => {
    const { getEventsInRange } = await import('./queries');
    const db = makeDb();
    addEvent(db, { id: 'far', start_at: '2026-10-01T09:00:00Z', end_at: '2026-10-01T10:00:00Z' });

    expect(getEventsInRange(db, '2026-08-17', '2026-08-23')).toHaveLength(0);
  });
});

describe('getEvent', () => {
  it('returns a single event with its etag, or null', async () => {
    const { getEvent } = await import('./queries');
    const db = makeDb();
    addEvent(db, {
      id: 'e1',
      start_at: '2026-08-21T09:00:00Z',
      end_at: '2026-08-21T10:00:00Z',
      etag: '"tag"',
      has_guests: 1,
      guest_count: 3,
    });

    const row = getEvent(db, 'me@example.com', 'e1');
    expect(row?.etag).toBe('"tag"');
    expect(row?.hasGuests).toBe(true);
    expect(row?.guestCount).toBe(3);
    expect(getEvent(db, 'me@example.com', 'missing')).toBeNull();
  });
});

describe('getAssignmentDueDates', () => {
  it('returns Canvas assignments inside the range', async () => {
    const { getAssignmentDueDates } = await import('./queries');
    const db = makeDb();
    db.prepare("insert into canvas_courses (id, name) values (1, 'BIO 101')").run();
    db.prepare(
      "insert into canvas_assignments (id, course_id, name, due_at) values (10, 1, 'Lab 3', '2026-08-21T23:59:00Z')"
    ).run();
    db.prepare(
      "insert into canvas_assignments (id, course_id, name, due_at) values (11, 1, 'Later', '2026-10-01T23:59:00Z')"
    ).run();

    const rows = getAssignmentDueDates(db, '2026-08-17', '2026-08-23');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Lab 3');
    expect(rows[0].courseName).toBe('BIO 101');
  });

  it('returns nothing when Canvas is not connected', async () => {
    const { getAssignmentDueDates } = await import('./queries');
    // Calendar must be fully usable without Canvas; empty tables, not an error.
    expect(getAssignmentDueDates(makeDb(), '2026-08-17', '2026-08-23')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/main/calendar/queries.test.ts`
Expected: FAIL with `Failed to resolve import "./queries"`.

- [ ] **Step 3: Implement the queries**

Create `src/main/calendar/queries.ts`:

```ts
import type Database from 'better-sqlite3';
import { getGoogleAccountEmail, getGoogleClientConfig, hasGoogleAuth } from './token';
import { getSyncState, SYNC_KEY_LAST_SYNC, SYNC_KEY_TOKEN_INVALID } from './sync';

export interface CalendarStatus {
  clientConfigured: boolean;
  connected: boolean;
  accountEmail: string | null;
  lastSyncedAt: string | null;
  tokenInvalid: boolean;
}

export interface CalendarRow {
  id: string;
  summary: string;
  backgroundColor: string | null;
  isPrimary: boolean;
  enabled: boolean;
}

export interface EventRow {
  calendarId: string;
  id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  htmlLink: string | null;
  hasGuests: boolean;
  guestCount: number;
  etag: string | null;
}

export interface AssignmentDueRow {
  id: number;
  courseId: number;
  courseName: string;
  name: string;
  dueAt: string;
}

interface RawEventRow {
  calendar_id: string;
  id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  start_at: string;
  end_at: string;
  is_all_day: number;
  html_link: string | null;
  has_guests: number;
  guest_count: number;
  etag: string | null;
}

const EVENT_COLUMNS = `calendar_id, id, summary, description, location, start_at, end_at,
  is_all_day, html_link, has_guests, guest_count, etag`;

function toEventRow(row: RawEventRow): EventRow {
  return {
    calendarId: row.calendar_id,
    id: row.id,
    summary: row.summary,
    description: row.description,
    location: row.location,
    startAt: row.start_at,
    endAt: row.end_at,
    isAllDay: row.is_all_day === 1,
    htmlLink: row.html_link,
    hasGuests: row.has_guests === 1,
    guestCount: row.guest_count,
    etag: row.etag,
  };
}

export function getCalendarStatus(db: Database.Database): CalendarStatus {
  return {
    clientConfigured: getGoogleClientConfig(db) !== null,
    connected: hasGoogleAuth(db),
    accountEmail: getGoogleAccountEmail(db),
    lastSyncedAt: getSyncState(db, SYNC_KEY_LAST_SYNC),
    tokenInvalid: getSyncState(db, SYNC_KEY_TOKEN_INVALID) === '1',
  };
}

export function listCalendarRows(db: Database.Database): CalendarRow[] {
  const rows = db
    .prepare(
      `select id, summary, background_color, is_primary, enabled
       from google_calendars order by is_primary desc, summary collate nocase`
    )
    .all() as Array<{
    id: string;
    summary: string;
    background_color: string | null;
    is_primary: number;
    enabled: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    summary: row.summary,
    backgroundColor: row.background_color,
    isPrimary: row.is_primary === 1,
    enabled: row.enabled === 1,
  }));
}

export function setCalendarEnabled(
  db: Database.Database,
  calendarId: string,
  enabled: boolean
): void {
  db.prepare('update google_calendars set enabled = ? where id = ?').run(enabled ? 1 : 0, calendarId);
}

/**
 * Events overlapping [fromDate, toDate], both date-only strings.
 *
 * `date()` normalizes both stored formats -- date('2026-08-21') and
 * date('2026-08-21T14:00:00Z') are both '2026-08-21' -- so one comparison
 * covers timed and all-day events with no branching. Testing overlap rather
 * than start-within-range is what keeps a multi-day event visible during the
 * days it spans.
 */
export function getEventsInRange(
  db: Database.Database,
  fromDate: string,
  toDate: string
): EventRow[] {
  const rows = db
    .prepare(
      `select ${EVENT_COLUMNS} from google_events
       where calendar_id in (select id from google_calendars where enabled = 1)
         and date(start_at) <= ?
         and date(end_at) >= ?
       order by start_at, id`
    )
    .all(toDate, fromDate) as RawEventRow[];
  return rows.map(toEventRow);
}

export function getEvent(
  db: Database.Database,
  calendarId: string,
  eventId: string
): EventRow | null {
  const row = db
    .prepare(`select ${EVENT_COLUMNS} from google_events where calendar_id = ? and id = ?`)
    .get(calendarId, eventId) as RawEventRow | undefined;
  return row === undefined ? null : toEventRow(row);
}

/**
 * Canvas assignment deadlines for the calendar overlay. Reads Phase 3's tables
 * directly -- no network, and no dependency on Canvas being connected: with no
 * Canvas token the tables are simply empty.
 */
export function getAssignmentDueDates(
  db: Database.Database,
  fromDate: string,
  toDate: string
): AssignmentDueRow[] {
  const rows = db
    .prepare(
      `select a.id, a.course_id, c.name as course_name, a.name, a.due_at
       from canvas_assignments a
       join canvas_courses c on c.id = a.course_id
       where a.due_at is not null and date(a.due_at) >= ? and date(a.due_at) <= ?
       order by a.due_at, a.id`
    )
    .all(fromDate, toDate) as Array<{
    id: number;
    course_id: number;
    course_name: string;
    name: string;
    due_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    courseId: row.course_id,
    courseName: row.course_name,
    name: row.name,
    dueAt: row.due_at,
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/main/calendar/queries.test.ts`
Expected: PASS, 13/13.

- [ ] **Step 5: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/main/calendar/queries.ts src/main/calendar/queries.test.ts
git commit -m "Task 6: local calendar queries with Canvas due-date overlay"
```

---

### Task 7: Event writes

**Files:**
- Create: `src/main/calendar/writes.ts`
- Create: `src/main/calendar/writes.test.ts`

**Interfaces:**
- Consumes: from Task 3 `createEvent`, `updateEvent`, `deleteEvent`, `GoogleEventInput`. From Task 5 `syncOneCalendar`. From Task 6 `getEvent`. From Task 1 the error classes.
- Produces:
  - `interface EventDraft { calendarId: string; summary: string; description?: string; location?: string; startAt: string; endAt: string; isAllDay: boolean; attendees?: string[] }`
  - `interface WriteResult { ok: boolean; error?: string; eventId?: string }`
  - `toGoogleInput(draft: EventDraft): GoogleEventInput`
  - `createCalendarEvent(db, draft: EventDraft, now?: Date): Promise<WriteResult>`
  - `updateCalendarEvent(db, eventId: string, draft: EventDraft, now?: Date): Promise<WriteResult>`
  - `deleteCalendarEvent(db, calendarId: string, eventId: string, now?: Date): Promise<WriteResult>`

**Context for the implementer:** every write finishes by calling `syncOneCalendar` so the local mirror reflects what Google actually stored (Google normalizes times, assigns IDs, and may adjust attendees). This resync is deliberately **not** routed through the scheduler's exclusivity guard: a write is user-initiated and latency matters, and Google — unlike Canvas — publishes no one-request-at-a-time guidance. The worst case is one brief extra request chain against a 1,000,000/day quota.

Errors become user-facing sentences here rather than being re-thrown, because both callers (IPC handlers and AI tools) need a message to show.

- [ ] **Step 1: Write the failing test**

Create `src/main/calendar/writes.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

vi.mock('./api', () => ({
  listCalendars: vi.fn(),
  listEvents: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
}));

import { createEvent, deleteEvent, listEvents, updateEvent } from './api';

const NOW = new Date('2026-08-20T12:00:00.000Z');

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    create table settings (key text primary key, value text not null);
    create table google_calendars (
      id text primary key, summary text not null, time_zone text, background_color text,
      access_role text, is_primary integer not null default 0, enabled integer not null default 1,
      synced_at text not null default (datetime('now'))
    );
    create table google_events (
      calendar_id text not null references google_calendars(id) on delete cascade,
      id text not null, summary text, description text, location text,
      start_at text not null, end_at text not null, is_all_day integer not null default 0,
      status text, html_link text, organizer_email text,
      has_guests integer not null default 0, guest_count integer not null default 0,
      recurring_event_id text, etag text, updated_at text,
      synced_at text not null default (datetime('now')),
      primary key (calendar_id, id)
    );
    create table calendar_sync_state (key text primary key, value text not null);
  `);
  db.prepare("insert into google_calendars (id, summary) values ('cal-1','Personal')").run();
  return db;
}

const DRAFT = {
  calendarId: 'cal-1',
  summary: 'Study block',
  startAt: '2026-08-21T14:00:00.000Z',
  endAt: '2026-08-21T16:00:00.000Z',
  isAllDay: false,
};

beforeEach(() => {
  vi.mocked(createEvent).mockReset();
  vi.mocked(updateEvent).mockReset();
  vi.mocked(deleteEvent).mockReset();
  vi.mocked(listEvents).mockReset();
  vi.mocked(listEvents).mockResolvedValue([] as never);
  vi.mocked(createEvent).mockResolvedValue({ id: 'new-1' } as never);
  vi.mocked(updateEvent).mockResolvedValue({ id: 'evt-1' } as never);
  vi.mocked(deleteEvent).mockResolvedValue(undefined as never);
});

describe('toGoogleInput', () => {
  it('uses dateTime for a timed event', async () => {
    const { toGoogleInput } = await import('./writes');
    expect(toGoogleInput(DRAFT)).toEqual({
      summary: 'Study block',
      start: { dateTime: '2026-08-21T14:00:00.000Z' },
      end: { dateTime: '2026-08-21T16:00:00.000Z' },
    });
  });

  it('uses date for an all-day event', async () => {
    const { toGoogleInput } = await import('./writes');
    const result = toGoogleInput({
      ...DRAFT,
      isAllDay: true,
      startAt: '2026-08-21',
      endAt: '2026-08-22',
    });
    // Sending dateTime for an all-day event makes Google store it as a timed
    // event at midnight, which is not the same thing.
    expect(result.start).toEqual({ date: '2026-08-21' });
    expect(result.end).toEqual({ date: '2026-08-22' });
  });

  it('includes attendees when supplied', async () => {
    const { toGoogleInput } = await import('./writes');
    const result = toGoogleInput({ ...DRAFT, attendees: ['a@example.com', 'b@example.com'] });
    expect(result.attendees).toEqual([{ email: 'a@example.com' }, { email: 'b@example.com' }]);
  });
});

describe('createCalendarEvent', () => {
  it('creates the event and resyncs that calendar', async () => {
    const { createCalendarEvent } = await import('./writes');
    const db = makeDb();

    const result = await createCalendarEvent(db, DRAFT, NOW);

    expect(result).toEqual({ ok: true, eventId: 'new-1' });
    expect(createEvent).toHaveBeenCalledTimes(1);
    // The resync is what makes the new event appear in the UI with Google's
    // own normalization applied.
    expect(listEvents).toHaveBeenCalledTimes(1);
  });

  it('rejects a blank summary without calling Google', async () => {
    const { createCalendarEvent } = await import('./writes');
    const result = await createCalendarEvent(makeDb(), { ...DRAFT, summary: '   ' }, NOW);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('title');
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('rejects an end that is not after the start', async () => {
    const { createCalendarEvent } = await import('./writes');
    const result = await createCalendarEvent(
      makeDb(),
      { ...DRAFT, endAt: '2026-08-21T14:00:00.000Z' },
      NOW
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('end');
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('reports being offline in plain language', async () => {
    const { createCalendarEvent } = await import('./writes');
    const { GoogleNetworkError } = await import('./errors');
    vi.mocked(createEvent).mockRejectedValue(new GoogleNetworkError());

    const result = await createCalendarEvent(makeDb(), DRAFT, NOW);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("offline");
  });

  it('reports a dead token as needing reconnection', async () => {
    const { createCalendarEvent } = await import('./writes');
    const { GoogleAuthError } = await import('./errors');
    vi.mocked(createEvent).mockRejectedValue(new GoogleAuthError());

    const result = await createCalendarEvent(makeDb(), DRAFT, NOW);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('reconnect');
  });
});

describe('updateCalendarEvent', () => {
  function seedEvent(db: Database.Database, etag: string | null): void {
    db.prepare(
      `insert into google_events (calendar_id, id, summary, start_at, end_at, etag)
       values ('cal-1','evt-1','Old','2026-08-21T14:00:00Z','2026-08-21T15:00:00Z', ?)`
    ).run(etag);
  }

  it('sends the stored etag as the precondition', async () => {
    const { updateCalendarEvent } = await import('./writes');
    const db = makeDb();
    seedEvent(db, '"etag-1"');

    const result = await updateCalendarEvent(db, 'evt-1', DRAFT, NOW);

    expect(result.ok).toBe(true);
    // Without If-Match this call silently overwrites whatever another client
    // wrote since the last sync.
    expect(vi.mocked(updateEvent).mock.calls[0][4]).toBe('"etag-1"');
  });

  it('reports a conflict and refreshes rather than overwriting', async () => {
    const { updateCalendarEvent } = await import('./writes');
    const { GoogleConflictError } = await import('./errors');
    const db = makeDb();
    seedEvent(db, '"etag-1"');
    vi.mocked(updateEvent).mockRejectedValue(new GoogleConflictError());

    const result = await updateCalendarEvent(db, 'evt-1', DRAFT, NOW);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('changed');
    // Refreshed so the user sees the other change before retrying.
    expect(listEvents).toHaveBeenCalledTimes(1);
  });

  it('reports an event that no longer exists', async () => {
    const { updateCalendarEvent } = await import('./writes');
    const { GoogleNotFoundError } = await import('./errors');
    const db = makeDb();
    seedEvent(db, '"etag-1"');
    vi.mocked(updateEvent).mockRejectedValue(new GoogleNotFoundError());

    const result = await updateCalendarEvent(db, 'evt-1', DRAFT, NOW);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('no longer exists');
  });

  it('fails when the event is not in the local mirror', async () => {
    const { updateCalendarEvent } = await import('./writes');
    const result = await updateCalendarEvent(makeDb(), 'ghost', DRAFT, NOW);

    expect(result.ok).toBe(false);
    expect(updateEvent).not.toHaveBeenCalled();
  });
});

describe('deleteCalendarEvent', () => {
  it('deletes and resyncs', async () => {
    const { deleteCalendarEvent } = await import('./writes');
    const result = await deleteCalendarEvent(makeDb(), 'cal-1', 'evt-1', NOW);

    expect(result).toEqual({ ok: true });
    expect(deleteEvent).toHaveBeenCalledWith(expect.anything(), 'cal-1', 'evt-1');
    expect(listEvents).toHaveBeenCalledTimes(1);
  });

  it('treats an already-deleted event as success', async () => {
    const { deleteCalendarEvent } = await import('./writes');
    const { GoogleNotFoundError } = await import('./errors');
    vi.mocked(deleteEvent).mockRejectedValue(new GoogleNotFoundError());

    // The user asked for it gone and it is gone; surfacing an error here would
    // be pedantic and confusing.
    const result = await deleteCalendarEvent(makeDb(), 'cal-1', 'evt-1', NOW);
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/main/calendar/writes.test.ts`
Expected: FAIL with `Failed to resolve import "./writes"`.

- [ ] **Step 3: Implement the writes module**

Create `src/main/calendar/writes.ts`:

```ts
import type Database from 'better-sqlite3';
import * as api from './api';
import type { GoogleEventInput } from './api';
import {
  GoogleAuthError,
  GoogleConflictError,
  GoogleNetworkError,
  GoogleNotFoundError,
  GoogleRateLimitError,
} from './errors';
import { getEvent } from './queries';
import { syncOneCalendar } from './sync';

export interface EventDraft {
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  /** RFC3339 for timed events, YYYY-MM-DD when isAllDay is true. */
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  attendees?: string[];
}

export interface WriteResult {
  ok: boolean;
  error?: string;
  eventId?: string;
}

export function toGoogleInput(draft: EventDraft): GoogleEventInput {
  // Google distinguishes all-day from timed purely by which key is present.
  // Sending dateTime for an all-day event stores a midnight timed event.
  const start = draft.isAllDay ? { date: draft.startAt } : { dateTime: draft.startAt };
  const end = draft.isAllDay ? { date: draft.endAt } : { dateTime: draft.endAt };
  const input: GoogleEventInput = { summary: draft.summary.trim(), start, end };
  if (draft.description !== undefined) input.description = draft.description;
  if (draft.location !== undefined) input.location = draft.location;
  if (draft.attendees !== undefined && draft.attendees.length > 0) {
    input.attendees = draft.attendees.map((email) => ({ email }));
  }
  return input;
}

function validate(draft: EventDraft): string | null {
  if (draft.summary.trim().length === 0) return 'The event needs a title.';
  if (draft.calendarId.trim().length === 0) return 'Pick a calendar for the event.';
  if (draft.endAt <= draft.startAt) return 'The end time has to be after the start time.';
  return null;
}

/** Turns a thrown Google error into a sentence both the UI and the AI can show. */
function describeError(error: unknown): string {
  if (error instanceof GoogleNetworkError) return "You're offline — this change wasn't saved.";
  if (error instanceof GoogleAuthError) return 'Google Calendar needs to be reconnected in Settings.';
  if (error instanceof GoogleRateLimitError) return 'Google is rate limiting right now. Try again in a minute.';
  if (error instanceof GoogleConflictError) {
    return 'This event was changed somewhere else. Refreshed it — take a look and try again.';
  }
  if (error instanceof GoogleNotFoundError) return 'That event no longer exists on Google Calendar.';
  return error instanceof Error ? error.message : String(error);
}

/**
 * Best-effort refresh of one calendar after a write. Swallows its own errors:
 * the write already succeeded, and failing the whole operation because the
 * follow-up read failed would be misleading.
 */
async function resync(db: Database.Database, calendarId: string, now: Date): Promise<void> {
  try {
    await syncOneCalendar(db, calendarId, now);
  } catch {
    // The next scheduled sync will pick it up.
  }
}

export async function createCalendarEvent(
  db: Database.Database,
  draft: EventDraft,
  now: Date = new Date()
): Promise<WriteResult> {
  const invalid = validate(draft);
  if (invalid !== null) return { ok: false, error: invalid };

  try {
    const created = await api.createEvent(db, draft.calendarId, toGoogleInput(draft));
    await resync(db, draft.calendarId, now);
    return { ok: true, eventId: created.id };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

export async function updateCalendarEvent(
  db: Database.Database,
  eventId: string,
  draft: EventDraft,
  now: Date = new Date()
): Promise<WriteResult> {
  const invalid = validate(draft);
  if (invalid !== null) return { ok: false, error: invalid };

  const existing = getEvent(db, draft.calendarId, eventId);
  if (existing === null) {
    return { ok: false, error: 'That event is not in the local calendar. Try refreshing first.' };
  }

  try {
    // If-Match with the stored etag: without it, this overwrites whatever
    // another client (a phone, the web UI) wrote since the last sync.
    await api.updateEvent(
      db,
      draft.calendarId,
      eventId,
      toGoogleInput(draft),
      existing.etag ?? undefined
    );
    await resync(db, draft.calendarId, now);
    return { ok: true, eventId };
  } catch (error) {
    // A conflict means someone else's change is the newer truth. Pull it in
    // so the user can see what happened before deciding to retry.
    if (error instanceof GoogleConflictError) await resync(db, draft.calendarId, now);
    return { ok: false, error: describeError(error) };
  }
}

export async function deleteCalendarEvent(
  db: Database.Database,
  calendarId: string,
  eventId: string,
  now: Date = new Date()
): Promise<WriteResult> {
  try {
    await api.deleteEvent(db, calendarId, eventId);
  } catch (error) {
    // Already gone is the outcome the user asked for.
    if (!(error instanceof GoogleNotFoundError)) {
      return { ok: false, error: describeError(error) };
    }
  }
  await resync(db, calendarId, now);
  return { ok: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/main/calendar/writes.test.ts`
Expected: PASS, 15/15.

- [ ] **Step 5: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/main/calendar/writes.ts src/main/calendar/writes.test.ts
git commit -m "Task 7: calendar event writes with etag preconditions"
```

---

### Task 8: Scheduler, IPC handlers, preload bridge, and main wiring

**Files:**
- Create: `src/main/calendar/scheduler.ts`
- Create: `src/main/calendar/ipc.ts`
- Create: `src/main/calendar/ipc.test.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7. From Task 4, `createScheduler`.
- Produces:
  - `interface CalendarScheduler { syncNow(): Promise<void>; runExclusive<T>(fn: () => Promise<T>): Promise<T | null>; stop(): void }`
  - `startCalendarScheduler(db, getWindow): CalendarScheduler`
  - `registerCalendarIpcHandlers(db, getWindow, scheduler): void`
  - `window.smartlife.calendar.*` on the renderer side

**Context for the implementer:** `src/main/csp.ts` must not be touched. All Google traffic originates in the main process, so no CSP directive needs to change; widening it would be a silent security regression.

- [ ] **Step 1: Write the calendar scheduler**

Create `src/main/calendar/scheduler.ts`:

```ts
import type { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { createScheduler } from '../scheduler';
import { syncAll } from './sync';
import { hasGoogleAuth } from './token';

const BACKGROUND_INTERVAL_MS = 30 * 60 * 1000;
const FOCUS_THROTTLE_MS = 5 * 60 * 1000;

export interface CalendarScheduler {
  syncNow(): Promise<void>;
  runExclusive<T>(fn: () => Promise<T>): Promise<T | null>;
  stop(): void;
}

export function startCalendarScheduler(
  db: Database.Database,
  getWindow: () => BrowserWindow | null
): CalendarScheduler {
  const scheduler = createScheduler({
    intervalMs: BACKGROUND_INTERVAL_MS,
    focusThrottleMs: FOCUS_THROTTLE_MS,
    run: async () => {
      if (!hasGoogleAuth(db)) return;
      await syncAll(db);
      getWindow()?.webContents.send('calendar:sync-changed');
    },
  });

  return {
    syncNow: () => scheduler.runNow(),
    runExclusive: (fn) => scheduler.runExclusive(fn),
    stop: () => scheduler.stop(),
  };
}
```

- [ ] **Step 2: Write the failing IPC test**

Create `src/main/calendar/ipc.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

vi.mock('./oauth', () => ({
  runOAuthFlow: vi.fn(),
  GOOGLE_CALENDAR_SCOPE: 'scope',
}));

vi.mock('./sync', async () => {
  const actual = await vi.importActual<typeof import('./sync')>('./sync');
  return { ...actual, syncAll: vi.fn().mockResolvedValue({ ok: true, calendarsSynced: 0, eventsSynced: 0, tokenInvalid: false, errors: [] }) };
});

import { runOAuthFlow } from './oauth';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    create table settings (key text primary key, value text not null);
    create table google_calendars (
      id text primary key, summary text not null, time_zone text, background_color text,
      access_role text, is_primary integer not null default 0, enabled integer not null default 1,
      synced_at text not null default (datetime('now'))
    );
    create table google_events (
      calendar_id text not null references google_calendars(id) on delete cascade,
      id text not null, summary text, description text, location text,
      start_at text not null, end_at text not null, is_all_day integer not null default 0,
      status text, html_link text, organizer_email text,
      has_guests integer not null default 0, guest_count integer not null default 0,
      recurring_event_id text, etag text, updated_at text,
      synced_at text not null default (datetime('now')),
      primary key (calendar_id, id)
    );
    create table calendar_sync_state (key text primary key, value text not null);
    create table canvas_courses (id integer primary key, name text not null);
    create table canvas_assignments (
      id integer primary key, course_id integer not null references canvas_courses(id) on delete cascade,
      name text not null, due_at text, html_url text, has_submitted integer not null default 0
    );
  `);
  return db;
}

const fakeScheduler = {
  syncNow: vi.fn().mockResolvedValue(undefined),
  runExclusive: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  stop: vi.fn(),
};

async function register(db: Database.Database): Promise<void> {
  const { registerCalendarIpcHandlers } = await import('./ipc');
  registerCalendarIpcHandlers(db, () => null, fakeScheduler as never);
}

beforeEach(() => {
  handlers.clear();
  vi.mocked(runOAuthFlow).mockReset();
  fakeScheduler.syncNow.mockClear();
});

describe('registerCalendarIpcHandlers', () => {
  it('registers every channel the preload bridge calls', async () => {
    await register(makeDb());

    for (const channel of [
      'calendar:get-status',
      'calendar:set-client-config',
      'calendar:connect',
      'calendar:disconnect',
      'calendar:sync-now',
      'calendar:list-calendars',
      'calendar:set-calendar-enabled',
      'calendar:get-events',
      'calendar:get-assignments',
      'calendar:create-event',
      'calendar:update-event',
      'calendar:delete-event',
    ]) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  it('refuses to connect before the client config is saved', async () => {
    await register(makeDb());

    const result = await handlers.get('calendar:connect')?.({});

    expect(result).toEqual({ ok: false, error: expect.stringContaining('Client ID') });
    expect(runOAuthFlow).not.toHaveBeenCalled();
  });

  it('stores the refresh token and syncs after a successful connect', async () => {
    const db = makeDb();
    await register(db);
    const { setGoogleClientConfig, getGoogleRefreshToken } = await import('./token');
    setGoogleClientConfig(db, 'client', 'secret');
    vi.mocked(runOAuthFlow).mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt-new',
      expiresIn: 3599,
    } as never);

    const result = await handlers.get('calendar:connect')?.({});

    expect(result).toEqual({ ok: true });
    expect(getGoogleRefreshToken(db)).toBe('rt-new');
    expect(fakeScheduler.syncNow).toHaveBeenCalledTimes(1);
  });

  it('reports a connect that returns no refresh token', async () => {
    const db = makeDb();
    await register(db);
    const { setGoogleClientConfig } = await import('./token');
    setGoogleClientConfig(db, 'client', 'secret');
    // Without access_type=offline / prompt=consent Google does this, and the
    // app would otherwise look connected while being unable to sync.
    vi.mocked(runOAuthFlow).mockResolvedValue({
      accessToken: 'at',
      refreshToken: null,
      expiresIn: 3599,
    } as never);

    const result = (await handlers.get('calendar:connect')?.({})) as { ok: boolean };
    expect(result.ok).toBe(false);
  });

  it('disconnect clears the token but keeps the client config', async () => {
    const db = makeDb();
    await register(db);
    const { setGoogleClientConfig, setGoogleRefreshToken, getGoogleClientConfig, hasGoogleAuth } =
      await import('./token');
    setGoogleClientConfig(db, 'client', 'secret');
    setGoogleRefreshToken(db, 'rt');

    await handlers.get('calendar:disconnect')?.({});

    expect(hasGoogleAuth(db)).toBe(false);
    expect(getGoogleClientConfig(db)).not.toBeNull();
  });

  it('returns events and assignments for a date range', async () => {
    const db = makeDb();
    await register(db);
    db.prepare("insert into google_calendars (id, summary) values ('cal-1','Personal')").run();
    db.prepare(
      `insert into google_events (calendar_id, id, summary, start_at, end_at)
       values ('cal-1','e1','Lecture','2026-08-21T14:00:00Z','2026-08-21T15:00:00Z')`
    ).run();
    db.prepare("insert into canvas_courses (id, name) values (1,'BIO 101')").run();
    db.prepare(
      "insert into canvas_assignments (id, course_id, name, due_at) values (5,1,'Lab','2026-08-21T23:59:00Z')"
    ).run();

    const events = (await handlers.get('calendar:get-events')?.({}, '2026-08-17', '2026-08-23')) as unknown[];
    const assignments = (await handlers.get('calendar:get-assignments')?.(
      {},
      '2026-08-17',
      '2026-08-23'
    )) as unknown[];

    expect(events).toHaveLength(1);
    expect(assignments).toHaveLength(1);
  });

  it('toggles a calendar and triggers a sync', async () => {
    const db = makeDb();
    await register(db);
    db.prepare("insert into google_calendars (id, summary, enabled) values ('cal-1','Personal',0)").run();

    await handlers.get('calendar:set-calendar-enabled')?.({}, 'cal-1', true);

    const row = db.prepare('select enabled from google_calendars where id = ?').get('cal-1') as {
      enabled: number;
    };
    expect(row.enabled).toBe(1);
    // Enabling a calendar with no locally cached events must fetch them, or
    // the user toggles it on and sees nothing.
    expect(fakeScheduler.syncNow).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test -- src/main/calendar/ipc.test.ts`
Expected: FAIL with `Failed to resolve import "./ipc"`.

- [ ] **Step 4: Implement the IPC handlers**

Create `src/main/calendar/ipc.ts`:

```ts
import { ipcMain, shell, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { runOAuthFlow } from './oauth';
import {
  clearGoogleAuth,
  getGoogleClientConfig,
  setGoogleClientConfig,
  setGoogleRefreshToken,
} from './token';
import {
  getAssignmentDueDates,
  getCalendarStatus,
  getEventsInRange,
  listCalendarRows,
  setCalendarEnabled,
} from './queries';
import { createCalendarEvent, deleteCalendarEvent, updateCalendarEvent, type EventDraft } from './writes';
import type { CalendarScheduler } from './scheduler';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerCalendarIpcHandlers(
  db: Database.Database,
  getWindow: () => BrowserWindow | null,
  scheduler: CalendarScheduler
): void {
  ipcMain.handle('calendar:get-status', () => getCalendarStatus(db));

  ipcMain.handle('calendar:set-client-config', (_event, clientId: string, clientSecret: string) => {
    try {
      setGoogleClientConfig(db, clientId, clientSecret);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle('calendar:connect', async () => {
    const config = getGoogleClientConfig(db);
    if (config === null) {
      return { ok: false, error: 'Save your Google Client ID and Client Secret first.' };
    }
    try {
      // The consent screen opens in the user's own browser, where they are
      // already signed in. No Google password ever passes through SmartLife.
      const tokens = await runOAuthFlow(config, (url) => {
        void shell.openExternal(url);
      });
      if (tokens.refreshToken === null) {
        // Without a refresh token the app can sync exactly once and then go
        // silent, which is worse than failing loudly here.
        return {
          ok: false,
          error: 'Google did not return a refresh token. Remove SmartLife from your Google account permissions and try again.',
        };
      }
      setGoogleRefreshToken(db, tokens.refreshToken);
      await scheduler.syncNow();
      getWindow()?.webContents.send('calendar:sync-changed');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle('calendar:disconnect', () => {
    clearGoogleAuth(db);
    return { ok: true };
  });

  ipcMain.handle('calendar:sync-now', async () => {
    await scheduler.syncNow();
    return getCalendarStatus(db);
  });

  ipcMain.handle('calendar:list-calendars', () => listCalendarRows(db));

  ipcMain.handle('calendar:set-calendar-enabled', async (_event, calendarId: string, enabled: boolean) => {
    setCalendarEnabled(db, calendarId, enabled);
    // A newly enabled calendar has no cached events yet, so toggling it on
    // without a sync would show an empty calendar.
    if (enabled) await scheduler.syncNow();
    getWindow()?.webContents.send('calendar:sync-changed');
    return listCalendarRows(db);
  });

  ipcMain.handle('calendar:get-events', (_event, fromDate: string, toDate: string) =>
    getEventsInRange(db, fromDate, toDate)
  );

  ipcMain.handle('calendar:get-assignments', (_event, fromDate: string, toDate: string) =>
    getAssignmentDueDates(db, fromDate, toDate)
  );

  ipcMain.handle('calendar:create-event', async (_event, draft: EventDraft) => {
    const result = await createCalendarEvent(db, draft);
    if (result.ok) getWindow()?.webContents.send('calendar:sync-changed');
    return result;
  });

  ipcMain.handle('calendar:update-event', async (_event, eventId: string, draft: EventDraft) => {
    const result = await updateCalendarEvent(db, eventId, draft);
    getWindow()?.webContents.send('calendar:sync-changed');
    return result;
  });

  ipcMain.handle('calendar:delete-event', async (_event, calendarId: string, eventId: string) => {
    const result = await deleteCalendarEvent(db, calendarId, eventId);
    if (result.ok) getWindow()?.webContents.send('calendar:sync-changed');
    return result;
  });
}
```

- [ ] **Step 5: Run the IPC tests**

Run: `npm run test -- src/main/calendar/ipc.test.ts`
Expected: PASS, 7/7.

- [ ] **Step 6: Add the preload bridge**

Modify `src/preload/index.ts`. Add these interfaces next to the existing `CanvasSyncStatus`:

```ts
interface CalendarStatus {
  clientConfigured: boolean;
  connected: boolean;
  accountEmail: string | null;
  lastSyncedAt: string | null;
  tokenInvalid: boolean;
}

interface CalendarActionResult {
  ok: boolean;
  error?: string;
  eventId?: string;
}

interface EventDraft {
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  attendees?: string[];
}
```

Add a `calendar` object to the `smartlife` const, after `canvas`:

```ts
  calendar: {
    getStatus: (): Promise<CalendarStatus> => ipcRenderer.invoke('calendar:get-status'),
    setClientConfig: (clientId: string, clientSecret: string): Promise<CalendarActionResult> =>
      ipcRenderer.invoke('calendar:set-client-config', clientId, clientSecret),
    connect: (): Promise<CalendarActionResult> => ipcRenderer.invoke('calendar:connect'),
    disconnect: (): Promise<CalendarActionResult> => ipcRenderer.invoke('calendar:disconnect'),
    syncNow: (): Promise<CalendarStatus> => ipcRenderer.invoke('calendar:sync-now'),
    listCalendars: (): Promise<unknown[]> => ipcRenderer.invoke('calendar:list-calendars'),
    setCalendarEnabled: (calendarId: string, enabled: boolean): Promise<unknown[]> =>
      ipcRenderer.invoke('calendar:set-calendar-enabled', calendarId, enabled),
    getEvents: (fromDate: string, toDate: string): Promise<unknown[]> =>
      ipcRenderer.invoke('calendar:get-events', fromDate, toDate),
    getAssignments: (fromDate: string, toDate: string): Promise<unknown[]> =>
      ipcRenderer.invoke('calendar:get-assignments', fromDate, toDate),
    createEvent: (draft: EventDraft): Promise<CalendarActionResult> =>
      ipcRenderer.invoke('calendar:create-event', draft),
    updateEvent: (eventId: string, draft: EventDraft): Promise<CalendarActionResult> =>
      ipcRenderer.invoke('calendar:update-event', eventId, draft),
    deleteEvent: (calendarId: string, eventId: string): Promise<CalendarActionResult> =>
      ipcRenderer.invoke('calendar:delete-event', calendarId, eventId),
    onSyncChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      ipcRenderer.on('calendar:sync-changed', listener);
      return () => ipcRenderer.removeListener('calendar:sync-changed', listener);
    },
  },
```

- [ ] **Step 7: Wire the scheduler and handlers into the main process**

Modify `src/main/index.ts`:

Add the imports next to the Canvas ones:

```ts
import { registerCalendarIpcHandlers } from './calendar/ipc';
import { startCalendarScheduler, type CalendarScheduler } from './calendar/scheduler';
```

Add the module-scoped variable next to `canvasScheduler`:

```ts
  let calendarScheduler: CalendarScheduler | null = null;
```

Inside `loadContent`, after the Canvas registration lines and before `handlersRegistered = true;`:

```ts
        calendarScheduler = startCalendarScheduler(dbConnection, () => mainWindow);
        registerCalendarIpcHandlers(dbConnection, () => mainWindow, calendarScheduler);
```

In the `before-quit` handler, alongside `canvasScheduler?.stop();`:

```ts
    calendarScheduler?.stop();
```

- [ ] **Step 8: Confirm the CSP was not touched**

Run: `git diff --name-only src/main/csp.ts`
Expected: no output. All Google traffic is main-process, so no CSP change is warranted.

- [ ] **Step 9: Run the full suite, lint, typecheck, and build**

Run: `npm run lint && npm run typecheck && npm run test && npm run build`
Expected: all exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/main/calendar/scheduler.ts src/main/calendar/ipc.ts src/main/calendar/ipc.test.ts src/preload/index.ts src/main/index.ts
git commit -m "Task 8: calendar scheduler, IPC handlers, preload bridge, and main wiring"
```

---

### Task 9: Renderer types, date math, and formatters

**Files:**
- Create: `src/renderer/src/calendar/types.ts`
- Create: `src/renderer/src/calendar/layout.ts`
- Create: `src/renderer/src/calendar/layout.test.ts`
- Create: `src/renderer/src/calendar/formatters.ts`
- Create: `src/renderer/src/calendar/formatters.test.ts`

**Interfaces:**
- Consumes: the shapes returned by Task 6's queries, restated as renderer types.
- Produces:
  - types: `CalendarStatus`, `CalendarRow`, `CalendarEvent`, `AssignmentDue`, `EventDraft`, `CALENDAR_ACCENT`, `SCHOOL_ACCENT_OVERLAY`
  - `layout.ts`: `GRID_START_HOUR`, `GRID_END_HOUR`, `startOfWeek(date)`, `weekDays(weekStart)`, `toDateKey(date)`, `parseAllDayDate(value)`, `eventDayKeys(event)`, `interface PositionedEvent`, `layoutDayEvents(events)`, `minutesToPercent(minutes)`
  - `formatters.ts`: `formatHourLabel(hour)`, `formatDayHeader(date)`, `formatEventTime(event)`, `formatEventRange(event)`, `formatRelative(iso, now?)`

**Context for the implementer:** this task is pure functions with no React. It carries most of the phase's subtle-bug risk, which is why it is separated out.

The two traps, both about all-day events:
1. `new Date('2026-08-21')` parses as **UTC** midnight. In any timezone west of UTC that is the evening of the 20th, so an all-day event renders on the wrong day. `parseAllDayDate` must build the date from its parts in local time.
2. `date.toISOString().slice(0, 10)` yields the **UTC** date. For an 8pm local event in the US that is tomorrow's date, which puts the event in the wrong column. `toDateKey` must read local getters.

- [ ] **Step 1: Write the renderer types**

Create `src/renderer/src/calendar/types.ts`:

```ts
export interface CalendarStatus {
  clientConfigured: boolean;
  connected: boolean;
  accountEmail: string | null;
  lastSyncedAt: string | null;
  tokenInvalid: boolean;
}

export interface CalendarRow {
  id: string;
  summary: string;
  backgroundColor: string | null;
  isPrimary: boolean;
  enabled: boolean;
}

export interface CalendarEvent {
  calendarId: string;
  id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  /** RFC3339 for timed events, YYYY-MM-DD when isAllDay is true. */
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  htmlLink: string | null;
  hasGuests: boolean;
  guestCount: number;
  etag: string | null;
}

export interface AssignmentDue {
  id: number;
  courseId: number;
  courseName: string;
  name: string;
  dueAt: string;
}

export interface EventDraft {
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  attendees?: string[];
}

/** The calendar section's own accent, copied from nav/sectionThemes.ts. */
export const CALENDAR_ACCENT = '#FB923C';

/**
 * Canvas due dates are drawn in School's blue so they read unmistakably as
 * "from School", not as calendar events you can drag around.
 */
export const SCHOOL_ACCENT_OVERLAY = '#3B82F6';
```

- [ ] **Step 2: Write the failing layout test**

Create `src/renderer/src/calendar/layout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  GRID_END_HOUR,
  GRID_START_HOUR,
  eventDayKeys,
  layoutDayEvents,
  minutesToPercent,
  parseAllDayDate,
  startOfWeek,
  toDateKey,
  weekDays,
} from './layout';
import type { CalendarEvent } from './types';

function timed(id: string, start: string, end: string): CalendarEvent {
  return {
    calendarId: 'cal-1',
    id,
    summary: id,
    description: null,
    location: null,
    startAt: start,
    endAt: end,
    isAllDay: false,
    htmlLink: null,
    hasGuests: false,
    guestCount: 0,
    etag: null,
  };
}

function allDay(id: string, start: string, end: string): CalendarEvent {
  return { ...timed(id, start, end), isAllDay: true };
}

describe('toDateKey', () => {
  it('uses local date parts, not the UTC date', () => {
    // 8pm on the 21st in a US timezone is the 22nd in UTC. Reading the UTC
    // date would file this event under the wrong day column.
    const evening = new Date(2026, 7, 21, 20, 30);
    expect(toDateKey(evening)).toBe('2026-08-21');
  });

  it('zero-pads single-digit months and days', () => {
    expect(toDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('parseAllDayDate', () => {
  it('parses a bare date at local midnight, not UTC midnight', () => {
    const parsed = parseAllDayDate('2026-08-21');
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(7);
    // new Date('2026-08-21') would be UTC midnight, which reads back as the
    // 20th anywhere west of Greenwich.
    expect(parsed.getDate()).toBe(21);
    expect(parsed.getHours()).toBe(0);
  });

  it('round-trips through toDateKey', () => {
    expect(toDateKey(parseAllDayDate('2026-01-01'))).toBe('2026-01-01');
  });
});

describe('startOfWeek and weekDays', () => {
  it('returns the preceding Sunday at local midnight', () => {
    // 2026-08-20 is a Thursday.
    const start = startOfWeek(new Date(2026, 7, 20, 14, 0));
    expect(toDateKey(start)).toBe('2026-08-16');
    expect(start.getHours()).toBe(0);
  });

  it('returns the same day when already Sunday', () => {
    expect(toDateKey(startOfWeek(new Date(2026, 7, 16, 23, 0)))).toBe('2026-08-16');
  });

  it('produces seven consecutive days', () => {
    const days = weekDays(startOfWeek(new Date(2026, 7, 20)));
    expect(days).toHaveLength(7);
    expect(days.map(toDateKey)).toEqual([
      '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19',
      '2026-08-20', '2026-08-21', '2026-08-22',
    ]);
  });

  it('crosses a month boundary correctly', () => {
    const days = weekDays(startOfWeek(new Date(2026, 7, 31)));
    expect(days.map(toDateKey)).toContain('2026-09-05');
  });
});

describe('eventDayKeys', () => {
  it('returns one key for a single-day timed event', () => {
    const event = timed('a', '2026-08-21T14:00:00.000Z', '2026-08-21T15:00:00.000Z');
    expect(eventDayKeys(event)).toEqual([toDateKey(new Date(event.startAt))]);
  });

  it('spans every day of a multi-day all-day event, excluding Google exclusive end', () => {
    // Google stores a Mon-Wed all-day event with end = Thursday.
    const event = allDay('trip', '2026-08-17', '2026-08-20');
    expect(eventDayKeys(event)).toEqual(['2026-08-17', '2026-08-18', '2026-08-19']);
  });

  it('handles a single-day all-day event', () => {
    expect(eventDayKeys(allDay('h', '2026-08-21', '2026-08-22'))).toEqual(['2026-08-21']);
  });

  it('tolerates an all-day event whose end equals its start', () => {
    // Malformed but seen in the wild; must still render on one day.
    expect(eventDayKeys(allDay('h', '2026-08-21', '2026-08-21'))).toEqual(['2026-08-21']);
  });
});

describe('minutesToPercent', () => {
  it('maps the grid start to 0 and the grid end to 100', () => {
    expect(minutesToPercent(GRID_START_HOUR * 60)).toBe(0);
    expect(minutesToPercent(GRID_END_HOUR * 60)).toBe(100);
  });

  it('clamps times outside the visible grid', () => {
    // A 3am event must not render at a negative offset and escape the grid.
    expect(minutesToPercent(3 * 60)).toBe(0);
    expect(minutesToPercent(25 * 60)).toBe(100);
  });
});

describe('layoutDayEvents', () => {
  it('gives a lone event the full width', () => {
    const positioned = layoutDayEvents([
      timed('a', new Date(2026, 7, 21, 9, 0).toISOString(), new Date(2026, 7, 21, 10, 0).toISOString()),
    ]);

    expect(positioned).toHaveLength(1);
    expect(positioned[0].columnCount).toBe(1);
    expect(positioned[0].columnIndex).toBe(0);
    expect(positioned[0].heightPct).toBeGreaterThan(0);
  });

  it('splits two overlapping events into side-by-side columns', () => {
    const positioned = layoutDayEvents([
      timed('a', new Date(2026, 7, 21, 9, 0).toISOString(), new Date(2026, 7, 21, 11, 0).toISOString()),
      timed('b', new Date(2026, 7, 21, 10, 0).toISOString(), new Date(2026, 7, 21, 12, 0).toISOString()),
    ]);

    expect(positioned.every((p) => p.columnCount === 2)).toBe(true);
    expect(positioned.map((p) => p.columnIndex).sort()).toEqual([0, 1]);
  });

  it('keeps non-overlapping events full width', () => {
    const positioned = layoutDayEvents([
      timed('a', new Date(2026, 7, 21, 9, 0).toISOString(), new Date(2026, 7, 21, 10, 0).toISOString()),
      timed('b', new Date(2026, 7, 21, 11, 0).toISOString(), new Date(2026, 7, 21, 12, 0).toISOString()),
    ]);

    // Two meetings that do not overlap should not each be squeezed to half
    // width just because they share a day.
    expect(positioned.every((p) => p.columnCount === 1)).toBe(true);
  });

  it('treats back-to-back events as non-overlapping', () => {
    const positioned = layoutDayEvents([
      timed('a', new Date(2026, 7, 21, 9, 0).toISOString(), new Date(2026, 7, 21, 10, 0).toISOString()),
      timed('b', new Date(2026, 7, 21, 10, 0).toISOString(), new Date(2026, 7, 21, 11, 0).toISOString()),
    ]);

    expect(positioned.every((p) => p.columnCount === 1)).toBe(true);
  });

  it('chains a three-way overlap into three columns', () => {
    const positioned = layoutDayEvents([
      timed('a', new Date(2026, 7, 21, 9, 0).toISOString(), new Date(2026, 7, 21, 12, 0).toISOString()),
      timed('b', new Date(2026, 7, 21, 10, 0).toISOString(), new Date(2026, 7, 21, 11, 0).toISOString()),
      timed('c', new Date(2026, 7, 21, 10, 30).toISOString(), new Date(2026, 7, 21, 11, 30).toISOString()),
    ]);

    expect(positioned.every((p) => p.columnCount === 3)).toBe(true);
  });

  it('gives a zero-length event a visible minimum height', () => {
    const at = new Date(2026, 7, 21, 9, 0).toISOString();
    const positioned = layoutDayEvents([timed('a', at, at)]);

    // A zero-height block is invisible and unclickable.
    expect(positioned[0].heightPct).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test -- src/renderer/src/calendar/layout.test.ts`
Expected: FAIL with `Failed to resolve import "./layout"`.

- [ ] **Step 4: Implement the layout math**

Create `src/renderer/src/calendar/layout.ts`:

```ts
import type { CalendarEvent } from './types';

export const GRID_START_HOUR = 6;
export const GRID_END_HOUR = 23;

const GRID_MINUTES = (GRID_END_HOUR - GRID_START_HOUR) * 60;
/** Percent of grid height below which a block would be unclickable. */
const MIN_HEIGHT_PCT = 1.5;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The LOCAL calendar date of a Date, as YYYY-MM-DD.
 *
 * Deliberately not toISOString().slice(0, 10): that returns the UTC date, so
 * an 8pm event in the US would be filed under the next day's column.
 */
export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Parses a bare YYYY-MM-DD as LOCAL midnight.
 *
 * new Date('2026-08-21') is specified to parse as UTC midnight, which reads
 * back as the 20th anywhere west of Greenwich -- the single most common
 * all-day-event bug.
 */
export function parseAllDayDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** Local midnight on the Sunday of the containing week. */
export function startOfWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - start.getDay());
  return start;
}

export function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_unused, index) => {
    const day = new Date(weekStart);
    day.setDate(day.getDate() + index);
    return day;
  });
}

/** Every local date an event should appear under. */
export function eventDayKeys(event: CalendarEvent): string[] {
  if (!event.isAllDay) return [toDateKey(new Date(event.startAt))];

  const start = parseAllDayDate(event.startAt);
  const end = parseAllDayDate(event.endAt);
  const keys: string[] = [];
  const cursor = new Date(start);
  // Google's all-day end date is EXCLUSIVE: a one-day event on the 21st has
  // end = the 22nd, so the loop stops before it.
  while (cursor < end) {
    keys.push(toDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  // Defensive: a malformed event whose end equals its start still needs a day.
  if (keys.length === 0) keys.push(toDateKey(start));
  return keys;
}

/** Minutes past local midnight to a percentage of the visible grid height. */
export function minutesToPercent(minutes: number): number {
  const offset = minutes - GRID_START_HOUR * 60;
  // Clamped so an event outside the visible hours pins to an edge instead of
  // rendering off-grid at a negative offset.
  return Math.min(100, Math.max(0, (offset / GRID_MINUTES) * 100));
}

export interface PositionedEvent {
  event: CalendarEvent;
  topPct: number;
  heightPct: number;
  columnIndex: number;
  columnCount: number;
}

function minutesOf(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Positions one day's timed events, splitting overlapping ones into columns.
 *
 * Events are grouped into clusters of transitively-overlapping events, and
 * every event in a cluster gets the same columnCount so their widths line up.
 * Columns are assigned greedily to the first one whose last event has ended.
 */
export function layoutDayEvents(events: CalendarEvent[]): PositionedEvent[] {
  const sorted = [...events]
    .filter((event) => !event.isAllDay)
    .sort((a, b) => a.startAt.localeCompare(b.startAt));

  const positioned: PositionedEvent[] = [];
  let cluster: CalendarEvent[] = [];
  let clusterEnd = -1;

  function flush(): void {
    if (cluster.length === 0) return;
    // Greedy column packing: reuse a column as soon as its previous event ends.
    const columnEnds: number[] = [];
    const assignments = cluster.map((event) => {
      const start = minutesOf(new Date(event.startAt));
      const end = minutesOf(new Date(event.endAt));
      let column = columnEnds.findIndex((columnEnd) => columnEnd <= start);
      if (column === -1) {
        column = columnEnds.length;
        columnEnds.push(end);
      } else {
        columnEnds[column] = end;
      }
      return { event, start, end, column };
    });

    for (const item of assignments) {
      const topPct = minutesToPercent(item.start);
      const rawHeight = minutesToPercent(item.end) - topPct;
      positioned.push({
        event: item.event,
        topPct,
        heightPct: Math.max(MIN_HEIGHT_PCT, rawHeight),
        columnIndex: item.column,
        columnCount: columnEnds.length,
      });
    }

    cluster = [];
    clusterEnd = -1;
  }

  for (const event of sorted) {
    const start = minutesOf(new Date(event.startAt));
    const end = minutesOf(new Date(event.endAt));
    // Back-to-back events (previous end == this start) do not overlap, so the
    // comparison is strict.
    if (cluster.length > 0 && start >= clusterEnd) flush();
    cluster.push(event);
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();

  return positioned;
}
```

- [ ] **Step 5: Run the layout tests**

Run: `npm run test -- src/renderer/src/calendar/layout.test.ts`
Expected: PASS, 20/20.

- [ ] **Step 6: Write the failing formatters test**

Create `src/renderer/src/calendar/formatters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatDayHeader, formatEventRange, formatEventTime, formatHourLabel, formatRelative } from './formatters';
import type { CalendarEvent } from './types';

function event(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    calendarId: 'cal-1',
    id: 'e1',
    summary: 'Event',
    description: null,
    location: null,
    startAt: new Date(2026, 7, 21, 14, 0).toISOString(),
    endAt: new Date(2026, 7, 21, 15, 30).toISOString(),
    isAllDay: false,
    htmlLink: null,
    hasGuests: false,
    guestCount: 0,
    etag: null,
    ...overrides,
  };
}

describe('formatHourLabel', () => {
  it('formats midday and midnight without a zero hour', () => {
    expect(formatHourLabel(0)).toBe('12 AM');
    expect(formatHourLabel(9)).toBe('9 AM');
    expect(formatHourLabel(12)).toBe('12 PM');
    expect(formatHourLabel(18)).toBe('6 PM');
  });
});

describe('formatDayHeader', () => {
  it('shows the weekday and day number', () => {
    expect(formatDayHeader(new Date(2026, 7, 21))).toBe('Fri 21');
  });
});

describe('formatEventTime', () => {
  it('renders a timed range', () => {
    expect(formatEventTime(event({}))).toBe('2:00 – 3:30 PM');
  });

  it('renders a range that crosses noon with both meridiems', () => {
    const crossing = event({
      startAt: new Date(2026, 7, 21, 11, 0).toISOString(),
      endAt: new Date(2026, 7, 21, 13, 0).toISOString(),
    });
    expect(formatEventTime(crossing)).toBe('11:00 AM – 1:00 PM');
  });

  it('says All day for an all-day event', () => {
    expect(formatEventTime(event({ isAllDay: true, startAt: '2026-08-21', endAt: '2026-08-22' }))).toBe(
      'All day'
    );
  });
});

describe('formatEventRange', () => {
  it('includes the date for use in confirmation prompts', () => {
    expect(formatEventRange(event({}))).toBe('Fri Aug 21, 2:00 – 3:30 PM');
  });

  it('formats an all-day event by date without inventing a time', () => {
    const allDay = event({ isAllDay: true, startAt: '2026-08-21', endAt: '2026-08-22' });
    expect(formatEventRange(allDay)).toBe('Fri Aug 21, all day');
  });
});

describe('formatRelative', () => {
  it('describes recent syncs and never', () => {
    const now = new Date(2026, 7, 21, 12, 0);
    expect(formatRelative(null, now)).toBe('never');
    expect(formatRelative(new Date(2026, 7, 21, 11, 57).toISOString(), now)).toBe('3 min ago');
    expect(formatRelative(new Date(2026, 7, 21, 9, 0).toISOString(), now)).toBe('3 hr ago');
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm run test -- src/renderer/src/calendar/formatters.test.ts`
Expected: FAIL with `Failed to resolve import "./formatters"`.

- [ ] **Step 8: Implement the formatters**

Create `src/renderer/src/calendar/formatters.ts`:

```ts
import { parseAllDayDate } from './layout';
import type { CalendarEvent } from './types';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function meridiem(hour: number): 'AM' | 'PM' {
  return hour < 12 ? 'AM' : 'PM';
}

function hour12(hour: number): number {
  const value = hour % 12;
  return value === 0 ? 12 : value;
}

export function formatHourLabel(hour: number): string {
  return `${hour12(hour)} ${meridiem(hour)}`;
}

export function formatDayHeader(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()}`;
}

function clockTime(date: Date): string {
  return `${hour12(date.getHours())}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * "2:00 – 3:30 PM" when both ends share a meridiem, "11:00 AM – 1:00 PM" when
 * they do not. Repeating AM/PM on both sides of every range is noisy in a grid
 * where most events sit inside one half of the day.
 */
export function formatEventTime(event: CalendarEvent): string {
  if (event.isAllDay) return 'All day';
  const start = new Date(event.startAt);
  const end = new Date(event.endAt);
  const startMeridiem = meridiem(start.getHours());
  const endMeridiem = meridiem(end.getHours());
  if (startMeridiem === endMeridiem) {
    return `${clockTime(start)} – ${clockTime(end)} ${endMeridiem}`;
  }
  return `${clockTime(start)} ${startMeridiem} – ${clockTime(end)} ${endMeridiem}`;
}

/** Long form including the date, used in AI confirmation prompts. */
export function formatEventRange(event: CalendarEvent): string {
  if (event.isAllDay) {
    const date = parseAllDayDate(event.startAt);
    return `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()}, all day`;
  }
  const start = new Date(event.startAt);
  return `${WEEKDAYS[start.getDay()]} ${MONTHS[start.getMonth()]} ${start.getDate()}, ${formatEventTime(event)}`;
}

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
```

- [ ] **Step 9: Run the formatter tests**

Run: `npm run test -- src/renderer/src/calendar/formatters.test.ts`
Expected: PASS, 8/8.

- [ ] **Step 10: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/renderer/src/calendar/types.ts src/renderer/src/calendar/layout.ts src/renderer/src/calendar/layout.test.ts src/renderer/src/calendar/formatters.ts src/renderer/src/calendar/formatters.test.ts
git commit -m "Task 9: calendar renderer types, date math, and formatters"
```

---

### Task 10: Calendar route — week grid, all-day strip, agenda panel

**Files:**
- Create: `src/renderer/src/calendar/useCalendar.ts`
- Create: `src/renderer/src/calendar/ConnectBanner.tsx`
- Create: `src/renderer/src/calendar/AllDayStrip.tsx`
- Create: `src/renderer/src/calendar/WeekGrid.tsx`
- Create: `src/renderer/src/calendar/AgendaPanel.tsx`
- Create: `src/renderer/src/routes/Calendar.tsx`
- Create: `src/renderer/src/routes/Calendar.test.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/App.test.tsx` and `src/renderer/src/theme/ThemeProvider.test.tsx` (add a `calendar` stub to their `window.smartlife` mocks)

**Interfaces:**
- Consumes: Task 9's `layout.ts`, `formatters.ts`, `types.ts`; Task 8's `window.smartlife.calendar.*`.
- Produces: `useCalendar()` returning `{ status, calendars, events, assignments, weekStart, weekDates, syncing, error, shiftWeek(delta), goToToday(), refresh(), reload() }`; the four components; the `/calendar` route.

**Context for the implementer:** the empty state follows the pattern `School.tsx` established — `status === null` (still loading) and "not connected" render the *same* prompt, so there is no flash of an empty calendar before status resolves. Do not add a separate spinner state.

The event dialog is Task 11. This task's `onSelectEvent`/`onSelectSlot` callbacks are wired but the route passes no-ops for now — do not build the dialog here.

- [ ] **Step 1: Write the failing route test**

Create `src/renderer/src/routes/Calendar.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Calendar } from './Calendar';

const calendar = {
  getStatus: vi.fn(),
  listCalendars: vi.fn(),
  getEvents: vi.fn(),
  getAssignments: vi.fn(),
  syncNow: vi.fn(),
  setCalendarEnabled: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  onSyncChanged: vi.fn().mockReturnValue(() => {}),
};

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientConfigured: true,
    connected: true,
    accountEmail: 'me@example.com',
    lastSyncedAt: new Date().toISOString(),
    tokenInvalid: false,
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const start = new Date();
  start.setHours(10, 0, 0, 0);
  const end = new Date(start);
  end.setHours(11, 0, 0, 0);
  return {
    calendarId: 'cal-1',
    id: 'e1',
    summary: 'Physics lecture',
    description: null,
    location: null,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    isAllDay: false,
    htmlLink: null,
    hasGuests: false,
    guestCount: 0,
    etag: null,
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'smartlife', {
    value: { calendar },
    writable: true,
    configurable: true,
  });
  calendar.getStatus.mockResolvedValue(status());
  calendar.listCalendars.mockResolvedValue([]);
  calendar.getEvents.mockResolvedValue([]);
  calendar.getAssignments.mockResolvedValue([]);
});

function renderCalendar(): void {
  render(
    <MemoryRouter>
      <Calendar />
    </MemoryRouter>
  );
}

describe('Calendar', () => {
  it('shows the connect prompt while status is still loading', () => {
    renderCalendar();
    // Same prompt as the not-connected state, so there is no flash of an
    // empty grid before status resolves.
    expect(screen.getByText(/connect google calendar/i)).toBeInTheDocument();
  });

  it('shows the connect prompt when not connected', async () => {
    calendar.getStatus.mockResolvedValue(status({ connected: false }));
    renderCalendar();
    expect(await screen.findByText(/connect google calendar/i)).toBeInTheDocument();
  });

  it('renders the seven day columns once connected', async () => {
    renderCalendar();
    await screen.findByRole('button', { name: /today/i });
    expect(screen.getByTestId('week-grid').querySelectorAll('[data-day-column]')).toHaveLength(7);
  });

  it('renders a timed event in the grid', async () => {
    calendar.getEvents.mockResolvedValue([event()]);
    renderCalendar();
    expect(await screen.findByText('Physics lecture')).toBeInTheDocument();
  });

  it('renders an all-day event in the all-day strip, not the timed grid', async () => {
    const today = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const key = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const nextKey = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
    calendar.getEvents.mockResolvedValue([
      event({ id: 'a1', summary: 'Holiday', isAllDay: true, startAt: key, endAt: nextKey }),
    ]);

    renderCalendar();

    const strip = await screen.findByTestId('all-day-strip');
    expect(strip).toHaveTextContent('Holiday');
    expect(screen.getByTestId('week-grid')).not.toHaveTextContent('Holiday');
  });

  it('renders Canvas due dates as a distinct overlay', async () => {
    const due = new Date();
    due.setHours(23, 59, 0, 0);
    calendar.getAssignments.mockResolvedValue([
      { id: 5, courseId: 1, courseName: 'BIO 101', name: 'Lab 3', dueAt: due.toISOString() },
    ]);

    renderCalendar();

    const chip = await screen.findByTestId('assignment-chip-5');
    expect(chip).toHaveTextContent('Lab 3');
  });

  it('works with Canvas disconnected', async () => {
    calendar.getAssignments.mockResolvedValue([]);
    calendar.getEvents.mockResolvedValue([event()]);
    renderCalendar();
    // Calendar must not depend on Canvas at runtime.
    expect(await screen.findByText('Physics lecture')).toBeInTheDocument();
  });

  it('shows the reconnect banner when the token is invalid', async () => {
    calendar.getStatus.mockResolvedValue(status({ tokenInvalid: true }));
    calendar.getEvents.mockResolvedValue([event()]);
    renderCalendar();

    expect(await screen.findByRole('alert')).toHaveTextContent(/reconnect/i);
    // A dead token means stale data, never a blank screen.
    expect(screen.getByText('Physics lecture')).toBeInTheDocument();
  });

  it('lists upcoming items in the agenda panel', async () => {
    calendar.getEvents.mockResolvedValue([event()]);
    renderCalendar();

    const agenda = await screen.findByTestId('agenda-panel');
    expect(agenda).toHaveTextContent('Physics lecture');
  });

  it('refetches when the week changes', async () => {
    renderCalendar();
    await screen.findByRole('button', { name: /today/i });
    const before = calendar.getEvents.mock.calls.length;

    screen.getByRole('button', { name: /next week/i }).click();

    await vi.waitFor(() => {
      expect(calendar.getEvents.mock.calls.length).toBeGreaterThan(before);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/renderer/src/routes/Calendar.test.tsx`
Expected: FAIL with `Failed to resolve import "./Calendar"`.

- [ ] **Step 3: Implement the data hook**

Create `src/renderer/src/calendar/useCalendar.ts`:

```ts
import { useCallback, useEffect, useMemo, useState } from 'react';
import { startOfWeek, toDateKey, weekDays } from './layout';
import type { AssignmentDue, CalendarEvent, CalendarRow, CalendarStatus } from './types';

export function useCalendar(): {
  status: CalendarStatus | null;
  calendars: CalendarRow[];
  events: CalendarEvent[];
  assignments: AssignmentDue[];
  weekStart: Date;
  weekDates: Date[];
  syncing: boolean;
  shiftWeek: (delta: number) => void;
  goToToday: () => void;
  refresh: () => Promise<void>;
  reload: () => Promise<void>;
} {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [calendars, setCalendars] = useState<CalendarRow[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [assignments, setAssignments] = useState<AssignmentDue[]>([]);
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [syncing, setSyncing] = useState(false);

  const weekDates = useMemo(() => weekDays(weekStart), [weekStart]);
  const fromDate = toDateKey(weekDates[0]);
  const toDate = toDateKey(weekDates[6]);

  const load = useCallback(async (): Promise<void> => {
    // Promise.all is fine here: these are local IPC reads against SQLite, not
    // Google API calls.
    const [nextStatus, nextCalendars, nextEvents, nextAssignments] = await Promise.all([
      window.smartlife.calendar.getStatus(),
      window.smartlife.calendar.listCalendars(),
      window.smartlife.calendar.getEvents(fromDate, toDate),
      window.smartlife.calendar.getAssignments(fromDate, toDate),
    ]);
    setStatus(nextStatus as CalendarStatus);
    setCalendars(nextCalendars as CalendarRow[]);
    setEvents(nextEvents as CalendarEvent[]);
    setAssignments(nextAssignments as AssignmentDue[]);
  }, [fromDate, toDate]);

  useEffect(() => {
    void load().catch(() => {});
    return window.smartlife.calendar.onSyncChanged(() => {
      void load().catch(() => {});
    });
  }, [load]);

  const refresh = useCallback(async (): Promise<void> => {
    setSyncing(true);
    try {
      await window.smartlife.calendar.syncNow();
      await load();
    } catch {
      // The status line already surfaces staleness; a failed manual refresh
      // does not warrant a modal.
    } finally {
      setSyncing(false);
    }
  }, [load]);

  const shiftWeek = useCallback((delta: number): void => {
    setWeekStart((current) => {
      const next = new Date(current);
      next.setDate(next.getDate() + delta * 7);
      return next;
    });
  }, []);

  const goToToday = useCallback((): void => {
    setWeekStart(startOfWeek(new Date()));
  }, []);

  return {
    status,
    calendars,
    events,
    assignments,
    weekStart,
    weekDates,
    syncing,
    shiftWeek,
    goToToday,
    refresh,
    reload: load,
  };
}
```

- [ ] **Step 4: Implement the reconnect banner**

Create `src/renderer/src/calendar/ConnectBanner.tsx`:

```tsx
import { useNavigate } from 'react-router-dom';
import type { CalendarStatus } from './types';

export function ConnectBanner({ status }: { status: CalendarStatus }): React.JSX.Element | null {
  const navigate = useNavigate();
  if (!status.tokenInvalid) return null;

  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm"
      style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
    >
      <span style={{ color: 'var(--color-text)' }}>
        Google Calendar access expired. Events below are the last synced copy — reconnect to bring
        them up to date.
      </span>
      <button
        type="button"
        onClick={() => navigate('/settings')}
        className="shrink-0 rounded-md px-2.5 py-1 text-xs"
        style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)' }}
      >
        Reconnect
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Implement the all-day strip**

Create `src/renderer/src/calendar/AllDayStrip.tsx`:

```tsx
import { eventDayKeys, toDateKey } from './layout';
import { CALENDAR_ACCENT, type CalendarEvent } from './types';

export function AllDayStrip({
  days,
  events,
  onSelectEvent,
}: {
  days: Date[];
  events: CalendarEvent[];
  onSelectEvent: (event: CalendarEvent) => void;
}): React.JSX.Element {
  const allDay = events.filter((event) => event.isAllDay);

  return (
    <div
      data-testid="all-day-strip"
      className="grid border-b"
      style={{ gridTemplateColumns: '3.5rem repeat(7, minmax(0, 1fr))', borderColor: 'var(--color-border)' }}
    >
      <div className="px-1 py-1 text-right text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
        all day
      </div>
      {days.map((day) => {
        const key = toDateKey(day);
        // A multi-day event appears in every column it spans, which is why
        // eventDayKeys returns a list rather than a single day.
        const dayEvents = allDay.filter((event) => eventDayKeys(event).includes(key));
        return (
          <div key={key} className="min-h-[1.75rem] px-0.5 py-0.5">
            {dayEvents.map((event) => (
              <button
                key={`${event.calendarId}:${event.id}`}
                type="button"
                onClick={() => onSelectEvent(event)}
                className="mb-0.5 block w-full truncate rounded px-1 py-0.5 text-left text-[11px]"
                style={{ backgroundColor: CALENDAR_ACCENT, color: '#FFFFFF' }}
              >
                {event.summary ?? 'Untitled'}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 6: Implement the week grid**

Create `src/renderer/src/calendar/WeekGrid.tsx`:

```tsx
import { formatHourLabel } from './formatters';
import { GRID_END_HOUR, GRID_START_HOUR, layoutDayEvents, minutesToPercent, toDateKey } from './layout';
import { CALENDAR_ACCENT, SCHOOL_ACCENT_OVERLAY, type AssignmentDue, type CalendarEvent } from './types';

const HOURS = Array.from(
  { length: GRID_END_HOUR - GRID_START_HOUR },
  (_unused, index) => GRID_START_HOUR + index
);

export function WeekGrid({
  days,
  events,
  assignments,
  showAssignments,
  onSelectEvent,
  onSelectSlot,
  now = new Date(),
}: {
  days: Date[];
  events: CalendarEvent[];
  assignments: AssignmentDue[];
  showAssignments: boolean;
  onSelectEvent: (event: CalendarEvent) => void;
  onSelectSlot: (start: Date) => void;
  now?: Date;
}): React.JSX.Element {
  const todayKey = toDateKey(now);
  const nowPct = minutesToPercent(now.getHours() * 60 + now.getMinutes());

  return (
    <div
      data-testid="week-grid"
      className="grid flex-1 overflow-auto"
      style={{ gridTemplateColumns: '3.5rem repeat(7, minmax(0, 1fr))' }}
    >
      <div className="relative" style={{ height: `${HOURS.length * 3}rem` }}>
        {HOURS.map((hour, index) => (
          <div
            key={hour}
            className="absolute right-1 -translate-y-1/2 text-[10px]"
            style={{ top: `${(index / HOURS.length) * 100}%`, color: 'var(--color-text-muted)' }}
          >
            {formatHourLabel(hour)}
          </div>
        ))}
      </div>

      {days.map((day) => {
        const key = toDateKey(day);
        const dayEvents = events.filter(
          (event) => !event.isAllDay && toDateKey(new Date(event.startAt)) === key
        );
        const positioned = layoutDayEvents(dayEvents);
        const dayAssignments = showAssignments
          ? assignments.filter((item) => toDateKey(new Date(item.dueAt)) === key)
          : [];

        return (
          <div
            key={key}
            data-day-column={key}
            className="relative border-l"
            style={{ height: `${HOURS.length * 3}rem`, borderColor: 'var(--color-border)' }}
          >
            {HOURS.map((hour, index) => (
              <button
                key={hour}
                type="button"
                aria-label={`Add event ${key} ${formatHourLabel(hour)}`}
                onClick={() => {
                  const slot = new Date(day);
                  slot.setHours(hour, 0, 0, 0);
                  onSelectSlot(slot);
                }}
                className="absolute left-0 w-full border-t"
                style={{
                  top: `${(index / HOURS.length) * 100}%`,
                  height: `${(1 / HOURS.length) * 100}%`,
                  borderColor: 'var(--color-border)',
                }}
              />
            ))}

            {key === todayKey && (
              <div
                className="pointer-events-none absolute left-0 z-10 h-px w-full"
                style={{ top: `${nowPct}%`, backgroundColor: '#EF4444' }}
              />
            )}

            {positioned.map((item) => (
              <button
                key={`${item.event.calendarId}:${item.event.id}`}
                type="button"
                onClick={() => onSelectEvent(item.event)}
                className="absolute overflow-hidden rounded px-1 py-0.5 text-left text-[11px] leading-tight"
                style={{
                  top: `${item.topPct}%`,
                  height: `${item.heightPct}%`,
                  left: `${(item.columnIndex / item.columnCount) * 100}%`,
                  width: `${(1 / item.columnCount) * 100}%`,
                  backgroundColor: CALENDAR_ACCENT,
                  color: '#FFFFFF',
                }}
              >
                {item.event.summary ?? 'Untitled'}
              </button>
            ))}

            {dayAssignments.map((item) => (
              <div
                key={item.id}
                data-testid={`assignment-chip-${item.id}`}
                title={`${item.courseName}: ${item.name}`}
                className="absolute left-0 w-full truncate rounded px-1 text-[10px]"
                style={{
                  top: `${minutesToPercent(new Date(item.dueAt).getHours() * 60 + new Date(item.dueAt).getMinutes())}%`,
                  // Dashed and translucent so a due date never reads as a real
                  // calendar event you could drag or delete.
                  border: `1px dashed ${SCHOOL_ACCENT_OVERLAY}`,
                  color: SCHOOL_ACCENT_OVERLAY,
                  backgroundColor: 'var(--color-surface)',
                }}
              >
                {item.name}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 7: Implement the agenda panel**

Create `src/renderer/src/calendar/AgendaPanel.tsx`:

```tsx
import { formatDayHeader, formatEventTime } from './formatters';
import { toDateKey } from './layout';
import { SCHOOL_ACCENT_OVERLAY, type AssignmentDue, type CalendarEvent } from './types';

export function AgendaPanel({
  days,
  events,
  assignments,
  showAssignments,
  onSelectEvent,
}: {
  days: Date[];
  events: CalendarEvent[];
  assignments: AssignmentDue[];
  showAssignments: boolean;
  onSelectEvent: (event: CalendarEvent) => void;
}): React.JSX.Element {
  return (
    <aside
      data-testid="agenda-panel"
      className="flex w-64 shrink-0 flex-col gap-3 overflow-auto border-l p-3"
      style={{ borderColor: 'var(--color-border)' }}
    >
      {days.map((day) => {
        const key = toDateKey(day);
        const dayEvents = events.filter((event) =>
          event.isAllDay ? event.startAt <= key && key < event.endAt : toDateKey(new Date(event.startAt)) === key
        );
        const dayAssignments = showAssignments
          ? assignments.filter((item) => toDateKey(new Date(item.dueAt)) === key)
          : [];
        if (dayEvents.length === 0 && dayAssignments.length === 0) return null;

        return (
          <section key={key} className="flex flex-col gap-1">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
              {formatDayHeader(day)}
            </h3>
            {dayEvents.map((event) => (
              <button
                key={`${event.calendarId}:${event.id}`}
                type="button"
                onClick={() => onSelectEvent(event)}
                className="rounded-md px-2 py-1 text-left text-xs"
                style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
              >
                <span className="block truncate" style={{ color: 'var(--color-text)' }}>
                  {event.summary ?? 'Untitled'}
                </span>
                <span style={{ color: 'var(--color-text-muted)' }}>{formatEventTime(event)}</span>
              </button>
            ))}
            {dayAssignments.map((item) => (
              <div
                key={item.id}
                className="rounded-md px-2 py-1 text-xs"
                style={{ border: `1px dashed ${SCHOOL_ACCENT_OVERLAY}`, color: SCHOOL_ACCENT_OVERLAY }}
              >
                <span className="block truncate">{item.name}</span>
                <span className="opacity-80">{item.courseName} · due</span>
              </div>
            ))}
          </section>
        );
      })}
    </aside>
  );
}
```

- [ ] **Step 8: Implement the route**

Create `src/renderer/src/routes/Calendar.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCalendar } from '../calendar/useCalendar';
import { AgendaPanel } from '../calendar/AgendaPanel';
import { AllDayStrip } from '../calendar/AllDayStrip';
import { ConnectBanner } from '../calendar/ConnectBanner';
import { WeekGrid } from '../calendar/WeekGrid';
import { formatRelative } from '../calendar/formatters';
import { formatDayHeader } from '../calendar/formatters';

export function Calendar(): React.JSX.Element {
  const { status, events, assignments, weekDates, syncing, shiftWeek, goToToday, refresh } = useCalendar();
  const [showAssignments, setShowAssignments] = useState(true);
  const navigate = useNavigate();

  // null (loading) and "not connected" render the same prompt so there is no
  // flash of an empty grid before status resolves.
  const connected = status !== null && status.connected;

  if (!connected) {
    return (
      <div className="flex flex-col items-start gap-4 p-8">
        <h1 className="text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
          Calendar
        </h1>
        <p style={{ color: 'var(--color-text-muted)' }}>
          Connect Google Calendar to see your week, add events, and let the assistant schedule things
          for you.
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
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
          Calendar
        </h1>
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={showAssignments}
              onChange={(e) => setShowAssignments(e.target.checked)}
            />
            Canvas due dates
          </label>
          <span>Synced {formatRelative(status.lastSyncedAt)}</span>
          <button type="button" onClick={() => void refresh()} disabled={syncing} className="rounded px-2 py-1" style={{ border: '1px solid var(--color-border)' }}>
            {syncing ? 'Syncing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <ConnectBanner status={status} />

      <div className="flex items-center gap-2">
        <button type="button" aria-label="Previous week" onClick={() => shiftWeek(-1)} className="rounded px-2 py-1 text-sm" style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
          ‹
        </button>
        <button type="button" onClick={goToToday} className="rounded px-2 py-1 text-sm" style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
          Today
        </button>
        <button type="button" aria-label="Next week" onClick={() => shiftWeek(1)} className="rounded px-2 py-1 text-sm" style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
          ›
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            className="grid"
            style={{ gridTemplateColumns: '3.5rem repeat(7, minmax(0, 1fr))' }}
          >
            <div />
            {weekDates.map((day) => (
              <div key={day.toISOString()} className="px-1 pb-1 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {formatDayHeader(day)}
              </div>
            ))}
          </div>
          <AllDayStrip days={weekDates} events={events} onSelectEvent={() => {}} />
          <WeekGrid
            days={weekDates}
            events={events}
            assignments={assignments}
            showAssignments={showAssignments}
            onSelectEvent={() => {}}
            onSelectSlot={() => {}}
          />
        </div>
        <AgendaPanel
          days={weekDates}
          events={events}
          assignments={assignments}
          showAssignments={showAssignments}
          onSelectEvent={() => {}}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Register the route**

Modify `src/renderer/src/App.tsx`. Add the import beside the others:

```ts
import { Calendar } from './routes/Calendar';
```

Add the route beside `/school`:

```tsx
          <Route path="/calendar" element={<Calendar />} />
```

And add `/calendar` to the `ComingSoon` exclusion filter so it is not double-registered:

```tsx
          {NAV_SECTIONS.filter(
            (section) =>
              section.path !== '/' &&
              section.path !== '/settings' &&
              section.path !== '/ai' &&
              section.path !== '/school' &&
              section.path !== '/calendar'
          ).map((section) => (
```

- [ ] **Step 10: Add calendar stubs to the two shared test mocks**

`src/renderer/src/App.test.tsx` and `src/renderer/src/theme/ThemeProvider.test.tsx` define a `window.smartlife` mock. Add a `calendar` object to each with the same shape used in `Calendar.test.tsx`:

```ts
  calendar: {
    getStatus: vi.fn().mockResolvedValue({
      clientConfigured: false,
      connected: false,
      accountEmail: null,
      lastSyncedAt: null,
      tokenInvalid: false,
    }),
    listCalendars: vi.fn().mockResolvedValue([]),
    getEvents: vi.fn().mockResolvedValue([]),
    getAssignments: vi.fn().mockResolvedValue([]),
    syncNow: vi.fn(),
    setCalendarEnabled: vi.fn(),
    setClientConfig: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    createEvent: vi.fn(),
    updateEvent: vi.fn(),
    deleteEvent: vi.fn(),
    onSyncChanged: vi.fn().mockReturnValue(() => {}),
  },
```

- [ ] **Step 11: Run the route tests**

Run: `npm run test -- src/renderer/src/routes/Calendar.test.tsx`
Expected: PASS, 10/10.

- [ ] **Step 12: Run the full suite, lint, and typecheck**

Run: `npm run lint && npm run typecheck && npm run test`
Expected: all exit 0, every pre-existing test still passing.

- [ ] **Step 13: Commit**

```bash
git add src/renderer/src/calendar src/renderer/src/routes/Calendar.tsx src/renderer/src/routes/Calendar.test.tsx src/renderer/src/App.tsx src/renderer/src/App.test.tsx src/renderer/src/theme/ThemeProvider.test.tsx
git commit -m "Task 10: calendar week grid, all-day strip, and agenda panel"
```

---

### Task 11: Event dialog, calendar toggles, and the Settings block

**Files:**
- Create: `src/renderer/src/calendar/inputs.ts`
- Create: `src/renderer/src/calendar/inputs.test.ts`
- Create: `src/renderer/src/calendar/EventDialog.tsx`
- Create: `src/renderer/src/calendar/EventDialog.test.tsx`
- Create: `src/renderer/src/calendar/CalendarToggles.tsx`
- Modify: `src/renderer/src/routes/Calendar.tsx` (wire the dialog to the callbacks stubbed in Task 10)
- Modify: `src/renderer/src/routes/Settings.tsx`
- Modify: `src/renderer/src/routes/Settings.test.tsx`

**Interfaces:**
- Consumes: Task 9's types and layout helpers, Task 8's `window.smartlife.calendar.*`.
- Produces: `toDateTimeInputValue(iso)`, `fromDateTimeInputValue(value)`, `toDateInputValue(value)`, the `EventDialog` and `CalendarToggles` components, and the Settings Google block.

**Context for the implementer:** `Settings.tsx` already contains an API-key block and a Canvas block, both with a "Save" button and "— not connected" text. Phase 3 hit ambiguous-query failures for exactly this reason and solved it by giving the Canvas block `role="region" aria-label="Canvas settings"`. Do the same here with `aria-label="Google Calendar settings"` and scope the new tests through `within(...)`. Expect to have to disambiguate a pre-existing test or two; that is normal and not a regression.

`<input type="datetime-local">` values are **local wall-clock strings with no timezone**. Converting them with `toISOString()` after building a `Date` is correct — `new Date('2026-08-21T14:00')` parses as local time — but naively slicing an ISO string to build the input value is not, because that yields UTC. `inputs.ts` exists to make both directions testable.

- [ ] **Step 1: Write the failing input-conversion test**

Create `src/renderer/src/calendar/inputs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fromDateTimeInputValue, toDateInputValue, toDateTimeInputValue } from './inputs';

describe('toDateTimeInputValue', () => {
  it('renders local wall-clock time, not UTC', () => {
    const iso = new Date(2026, 7, 21, 14, 30).toISOString();
    // Slicing the ISO string would show the UTC hour and silently shift every
    // event the user opens for editing.
    expect(toDateTimeInputValue(iso)).toBe('2026-08-21T14:30');
  });

  it('zero-pads every component', () => {
    expect(toDateTimeInputValue(new Date(2026, 0, 5, 9, 5).toISOString())).toBe('2026-01-05T09:05');
  });
});

describe('fromDateTimeInputValue', () => {
  it('round-trips back to the same instant', () => {
    const iso = new Date(2026, 7, 21, 14, 30).toISOString();
    expect(fromDateTimeInputValue(toDateTimeInputValue(iso))).toBe(iso);
  });
});

describe('toDateInputValue', () => {
  it('passes a bare all-day date through untouched', () => {
    expect(toDateInputValue('2026-08-21')).toBe('2026-08-21');
  });

  it('reduces a timestamp to its local date', () => {
    expect(toDateInputValue(new Date(2026, 7, 21, 20, 0).toISOString())).toBe('2026-08-21');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails, then implement**

Run: `npm run test -- src/renderer/src/calendar/inputs.test.ts`
Expected: FAIL with `Failed to resolve import "./inputs"`.

Create `src/renderer/src/calendar/inputs.ts`:

```ts
import { toDateKey } from './layout';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * ISO timestamp -> the value an <input type="datetime-local"> expects, which
 * is LOCAL wall-clock with no zone. Slicing the ISO string instead would show
 * the UTC hour and shift every event the user opens.
 */
export function toDateTimeInputValue(iso: string): string {
  const date = new Date(iso);
  return `${toDateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** datetime-local value -> ISO. `new Date('...T14:30')` parses as local time. */
export function fromDateTimeInputValue(value: string): string {
  return new Date(value).toISOString();
}

/** Either an all-day date string or a timestamp -> a bare local YYYY-MM-DD. */
export function toDateInputValue(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return toDateKey(new Date(value));
}
```

Run: `npm run test -- src/renderer/src/calendar/inputs.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 3: Write the failing event-dialog test**

Create `src/renderer/src/calendar/EventDialog.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EventDialog } from './EventDialog';
import type { CalendarEvent, CalendarRow } from './types';

const calendar = {
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
};

const CALENDARS: CalendarRow[] = [
  { id: 'cal-1', summary: 'Personal', backgroundColor: null, isPrimary: true, enabled: true },
];

function existing(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    calendarId: 'cal-1',
    id: 'evt-1',
    summary: 'Standup',
    description: null,
    location: null,
    startAt: new Date(2026, 7, 21, 9, 0).toISOString(),
    endAt: new Date(2026, 7, 21, 9, 30).toISOString(),
    isAllDay: false,
    htmlLink: null,
    hasGuests: false,
    guestCount: 0,
    etag: '"tag"',
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'smartlife', {
    value: { calendar },
    writable: true,
    configurable: true,
  });
  calendar.createEvent.mockResolvedValue({ ok: true, eventId: 'new-1' });
  calendar.updateEvent.mockResolvedValue({ ok: true });
  calendar.deleteEvent.mockResolvedValue({ ok: true });
});

describe('EventDialog create mode', () => {
  it('creates an event from the form values', async () => {
    const onSaved = vi.fn();
    render(
      <EventDialog
        calendars={CALENDARS}
        slotStart={new Date(2026, 7, 21, 14, 0)}
        onClose={() => {}}
        onSaved={onSaved}
      />
    );

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Study block' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calendar.createEvent).toHaveBeenCalledTimes(1));
    const draft = calendar.createEvent.mock.calls[0][0];
    expect(draft.summary).toBe('Study block');
    expect(draft.calendarId).toBe('cal-1');
    expect(draft.isAllDay).toBe(false);
    expect(onSaved).toHaveBeenCalled();
  });

  it('switches to bare dates when all-day is checked', async () => {
    render(
      <EventDialog
        calendars={CALENDARS}
        slotStart={new Date(2026, 7, 21, 14, 0)}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Holiday' } });
    fireEvent.click(screen.getByLabelText('All day'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calendar.createEvent).toHaveBeenCalled());
    const draft = calendar.createEvent.mock.calls[0][0];
    expect(draft.isAllDay).toBe(true);
    // Sending a timestamp here would make Google store a midnight timed event.
    expect(draft.startAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('shows the error the main process returned instead of closing', async () => {
    calendar.createEvent.mockResolvedValue({ ok: false, error: "You're offline — this change wasn't saved." });
    const onSaved = vi.fn();
    render(
      <EventDialog calendars={CALENDARS} slotStart={new Date()} onClose={() => {}} onSaved={onSaved} />
    );

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/offline/i);
    // Closing on failure would make the user think the event saved.
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('EventDialog edit mode', () => {
  it('prefills from the event and updates it', async () => {
    render(
      <EventDialog calendars={CALENDARS} event={existing()} onClose={() => {}} onSaved={() => {}} />
    );

    expect(screen.getByLabelText('Title')).toHaveValue('Standup');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Standup (moved)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calendar.updateEvent).toHaveBeenCalledTimes(1));
    expect(calendar.updateEvent.mock.calls[0][0]).toBe('evt-1');
    expect(calendar.updateEvent.mock.calls[0][1].summary).toBe('Standup (moved)');
  });

  it('warns before deleting an event with guests', async () => {
    render(
      <EventDialog
        calendars={CALENDARS}
        event={existing({ hasGuests: true, guestCount: 3 })}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    // Deleting a shared event emails everyone on it; that has to be said out
    // loud before it happens.
    expect(screen.getByTestId('delete-confirm')).toHaveTextContent('3 guests');
    fireEvent.click(screen.getByRole('button', { name: 'Delete event' }));
    await waitFor(() => expect(calendar.deleteEvent).toHaveBeenCalledWith('cal-1', 'evt-1'));
  });

  it('does not offer delete in create mode', () => {
    render(
      <EventDialog calendars={CALENDARS} slotStart={new Date()} onClose={() => {}} onSaved={() => {}} />
    );
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm run test -- src/renderer/src/calendar/EventDialog.test.tsx`
Expected: FAIL with `Failed to resolve import "./EventDialog"`.

- [ ] **Step 5: Implement the event dialog**

Create `src/renderer/src/calendar/EventDialog.tsx`:

```tsx
import { useState } from 'react';
import { fromDateTimeInputValue, toDateInputValue, toDateTimeInputValue } from './inputs';
import type { CalendarEvent, CalendarRow, EventDraft } from './types';

const HOUR_MS = 3_600_000;

function nextDay(dateValue: string): string {
  const [year, month, day] = dateValue.split('-').map(Number);
  const date = new Date(year, month - 1, day + 1);
  return toDateInputValue(date.toISOString());
}

export function EventDialog({
  calendars,
  event,
  slotStart,
  onClose,
  onSaved,
}: {
  calendars: CalendarRow[];
  event?: CalendarEvent;
  slotStart?: Date;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const isEdit = event !== undefined;
  const defaultStart = slotStart ?? new Date();
  const defaultEnd = new Date(defaultStart.getTime() + HOUR_MS);

  const [calendarId, setCalendarId] = useState(
    event?.calendarId ?? calendars.find((c) => c.isPrimary)?.id ?? calendars[0]?.id ?? ''
  );
  const [summary, setSummary] = useState(event?.summary ?? '');
  const [location, setLocation] = useState(event?.location ?? '');
  const [isAllDay, setIsAllDay] = useState(event?.isAllDay ?? false);
  const [startValue, setStartValue] = useState(
    event ? toDateTimeInputValue(event.isAllDay ? `${event.startAt}T00:00` : event.startAt)
          : toDateTimeInputValue(defaultStart.toISOString())
  );
  const [endValue, setEndValue] = useState(
    event ? toDateTimeInputValue(event.isAllDay ? `${event.endAt}T00:00` : event.endAt)
          : toDateTimeInputValue(defaultEnd.toISOString())
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function buildDraft(): EventDraft {
    if (isAllDay) {
      const startDate = toDateInputValue(startValue);
      const endDate = toDateInputValue(endValue);
      return {
        calendarId,
        summary,
        location: location.length > 0 ? location : undefined,
        isAllDay: true,
        startAt: startDate,
        // Google's all-day end is exclusive, so a single-day event ends the
        // following day.
        endAt: endDate > startDate ? endDate : nextDay(startDate),
      };
    }
    return {
      calendarId,
      summary,
      location: location.length > 0 ? location : undefined,
      isAllDay: false,
      startAt: fromDateTimeInputValue(startValue),
      endAt: fromDateTimeInputValue(endValue),
    };
  }

  async function handleSave(): Promise<void> {
    setError('');
    setSaving(true);
    try {
      const draft = buildDraft();
      const result = isEdit
        ? await window.smartlife.calendar.updateEvent(event.id, draft)
        : await window.smartlife.calendar.createEvent(draft);
      if (!result.ok) {
        // Staying open on failure is deliberate: closing would read as success.
        setError(result.error ?? 'Could not save the event.');
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setError('');
    setSaving(true);
    try {
      const result = await window.smartlife.calendar.deleteEvent(event!.calendarId, event!.id);
      if (!result.ok) {
        setError(result.error ?? 'Could not delete the event.');
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  const fieldStyle = {
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-text)',
    border: '1px solid var(--color-border)',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
      <div
        role="dialog"
        aria-label={isEdit ? 'Edit event' : 'New event'}
        className="flex w-96 flex-col gap-3 rounded-lg p-4"
        style={{ backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
      >
        <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Title
          <input value={summary} onChange={(e) => setSummary(e.target.value)} className="rounded-md px-2 py-1 text-sm" style={fieldStyle} />
        </label>

        <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Calendar
          <select value={calendarId} onChange={(e) => setCalendarId(e.target.value)} className="rounded-md px-2 py-1 text-sm" style={fieldStyle}>
            {calendars.map((row) => (
              <option key={row.id} value={row.id}>{row.summary}</option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <input type="checkbox" checked={isAllDay} onChange={(e) => setIsAllDay(e.target.checked)} />
          All day
        </label>

        <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Starts
          <input type={isAllDay ? 'date' : 'datetime-local'} value={isAllDay ? toDateInputValue(startValue) : startValue} onChange={(e) => setStartValue(e.target.value)} className="rounded-md px-2 py-1 text-sm" style={fieldStyle} />
        </label>

        <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Ends
          <input type={isAllDay ? 'date' : 'datetime-local'} value={isAllDay ? toDateInputValue(endValue) : endValue} onChange={(e) => setEndValue(e.target.value)} className="rounded-md px-2 py-1 text-sm" style={fieldStyle} />
        </label>

        <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Location
          <input value={location} onChange={(e) => setLocation(e.target.value)} className="rounded-md px-2 py-1 text-sm" style={fieldStyle} />
        </label>

        {error.length > 0 && (
          <p role="alert" className="text-xs" style={{ color: '#EF4444' }}>{error}</p>
        )}

        {confirmingDelete && (
          <div data-testid="delete-confirm" className="rounded-md px-2 py-1.5 text-xs" style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
            {event!.hasGuests
              ? `Delete this event? ${event!.guestCount} guests will be notified.`
              : 'Delete this event?'}
            <div className="mt-1.5 flex gap-2">
              <button type="button" onClick={() => void handleDelete()} className="rounded px-2 py-1" style={{ backgroundColor: '#EF4444', color: '#FFFFFF' }}>
                Delete event
              </button>
              <button type="button" onClick={() => setConfirmingDelete(false)} className="rounded px-2 py-1" style={{ border: '1px solid var(--color-border)' }}>
                Keep it
              </button>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          {isEdit && !confirmingDelete ? (
            <button type="button" onClick={() => setConfirmingDelete(true)} className="rounded px-2 py-1 text-sm" style={{ color: '#EF4444', border: '1px solid var(--color-border)' }}>
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded px-2 py-1 text-sm" style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
              Cancel
            </button>
            <button type="button" disabled={saving} onClick={() => void handleSave()} className="rounded px-3 py-1 text-sm" style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)' }}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run the dialog tests**

Run: `npm run test -- src/renderer/src/calendar/EventDialog.test.tsx`
Expected: PASS, 6/6.

- [ ] **Step 7: Implement the calendar toggles**

Create `src/renderer/src/calendar/CalendarToggles.tsx`:

```tsx
import type { CalendarRow } from './types';

export function CalendarToggles({
  calendars,
  onToggle,
}: {
  calendars: CalendarRow[];
  onToggle: (calendarId: string, enabled: boolean) => void;
}): React.JSX.Element {
  if (calendars.length === 0) {
    return <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No calendars synced yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-1">
      {calendars.map((row) => (
        <li key={row.id}>
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--color-text)' }}>
            <input
              type="checkbox"
              checked={row.enabled}
              onChange={(e) => onToggle(row.id, e.target.checked)}
            />
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: row.backgroundColor ?? 'var(--color-border)' }}
            />
            {row.summary}
          </label>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 8: Wire the dialog into the Calendar route**

Modify `src/renderer/src/routes/Calendar.tsx`:

Add the imports and state:

```tsx
import { EventDialog } from '../calendar/EventDialog';
import type { CalendarEvent } from '../calendar/types';
```

```tsx
  const [dialog, setDialog] = useState<
    { mode: 'create'; slotStart: Date } | { mode: 'edit'; event: CalendarEvent } | null
  >(null);
```

Pull `calendars` and `reload` out of the hook (they are already returned):

```tsx
  const { status, calendars, events, assignments, weekDates, syncing, shiftWeek, goToToday, refresh, reload } = useCalendar();
```

Replace the three `onSelectEvent={() => {}}` props with `onSelectEvent={(event) => setDialog({ mode: 'edit', event })}`, and `onSelectSlot={() => {}}` with `onSelectSlot={(slotStart) => setDialog({ mode: 'create', slotStart })}`.

Render the dialog just before the closing `</div>` of the route:

```tsx
      {dialog !== null && (
        <EventDialog
          calendars={calendars}
          event={dialog.mode === 'edit' ? dialog.event : undefined}
          slotStart={dialog.mode === 'create' ? dialog.slotStart : undefined}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void reload();
          }}
        />
      )}
```

- [ ] **Step 9: Add the Settings Google Calendar block**

Modify `src/renderer/src/routes/Settings.tsx`. Add state and handlers alongside the existing Canvas ones:

```tsx
  const [calendarStatus, setCalendarStatus] = useState<{
    clientConfigured: boolean;
    connected: boolean;
    accountEmail: string | null;
  } | null>(null);
  const [googleCalendars, setGoogleCalendars] = useState<
    Array<{ id: string; summary: string; backgroundColor: string | null; isPrimary: boolean; enabled: boolean }>
  >([]);
  const [clientIdInput, setClientIdInput] = useState('');
  const [clientSecretInput, setClientSecretInput] = useState('');
  const [calendarMessage, setCalendarMessage] = useState('');
  const [calendarError, setCalendarError] = useState('');

  async function refreshCalendarState(): Promise<void> {
    setCalendarStatus((await window.smartlife.calendar.getStatus()) as never);
    setGoogleCalendars((await window.smartlife.calendar.listCalendars()) as never);
  }

  async function handleSaveGoogleClient(): Promise<void> {
    setCalendarError('');
    const result = await window.smartlife.calendar.setClientConfig(clientIdInput, clientSecretInput);
    if (!result.ok) {
      setCalendarError(result.error ?? 'Could not save the client credentials.');
      return;
    }
    setClientSecretInput('');
    setCalendarMessage('Client credentials saved.');
    await refreshCalendarState();
  }

  async function handleConnectGoogle(): Promise<void> {
    setCalendarError('');
    setCalendarMessage('Finish signing in in your browser…');
    const result = await window.smartlife.calendar.connect();
    if (!result.ok) {
      setCalendarMessage('');
      setCalendarError(result.error ?? 'Could not connect to Google.');
      return;
    }
    setCalendarMessage('Connected.');
    await refreshCalendarState();
  }

  async function handleDisconnectGoogle(): Promise<void> {
    await window.smartlife.calendar.disconnect();
    setCalendarMessage('Disconnected.');
    await refreshCalendarState();
  }

  async function handleToggleCalendar(calendarId: string, enabled: boolean): Promise<void> {
    setGoogleCalendars((await window.smartlife.calendar.setCalendarEnabled(calendarId, enabled)) as never);
  }
```

Call `void refreshCalendarState();` from the same `useEffect` that already loads the Canvas status.

Add the block after the Canvas block, mirroring its structure:

```tsx
      <div className="flex flex-col gap-2" role="region" aria-label="Google Calendar settings">
        <span style={{ color: 'var(--color-text-muted)' }}>
          Google Calendar{' '}
          {calendarStatus?.connected
            ? `— connected as ${calendarStatus.accountEmail ?? 'your account'}`
            : calendarStatus
              ? '— not connected'
              : ''}
        </span>
        <input
          type="text"
          value={clientIdInput}
          onChange={(e) => setClientIdInput(e.target.value)}
          placeholder="123-abc.apps.googleusercontent.com"
          aria-label="Google Client ID"
          className="rounded-md px-3 py-1.5 text-sm"
          style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
        />
        <input
          type="password"
          value={clientSecretInput}
          onChange={(e) => setClientSecretInput(e.target.value)}
          placeholder="Client secret"
          aria-label="Google Client Secret"
          className="rounded-md px-3 py-1.5 text-sm"
          style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
        />
        <div className="flex gap-2">
          <button type="button" onClick={() => void handleSaveGoogleClient()} className="rounded-md px-3 py-1.5 text-sm" style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)' }}>
            Save
          </button>
          <button type="button" onClick={() => void handleConnectGoogle()} className="rounded-md px-3 py-1.5 text-sm" style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
            Connect
          </button>
          <button type="button" onClick={() => void handleDisconnectGoogle()} className="rounded-md px-3 py-1.5 text-sm" style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
            Disconnect
          </button>
        </div>
        {calendarMessage.length > 0 && <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{calendarMessage}</span>}
        {calendarError.length > 0 && <span role="alert" className="text-xs" style={{ color: '#EF4444' }}>{calendarError}</span>}
        {calendarStatus?.connected === true && (
          <CalendarToggles calendars={googleCalendars} onToggle={(id, enabled) => void handleToggleCalendar(id, enabled)} />
        )}
      </div>
```

Import `CalendarToggles` at the top: `import { CalendarToggles } from '../calendar/CalendarToggles';`

- [ ] **Step 10: Add Settings tests for the Google block**

Add to `src/renderer/src/routes/Settings.test.tsx`, extending its `window.smartlife` mock with the `calendar` object from Task 10 Step 10 plus `setClientConfig`, `connect`, and `disconnect`:

```tsx
describe('Settings — Google Calendar', () => {
  function region(): HTMLElement {
    return screen.getByRole('region', { name: 'Google Calendar settings' });
  }

  it('saves the client credentials', async () => {
    render(<Settings />);
    await screen.findByRole('heading', { name: 'Settings' });

    fireEvent.change(screen.getByLabelText('Google Client ID'), { target: { value: 'id-1' } });
    fireEvent.change(screen.getByLabelText('Google Client Secret'), { target: { value: 'secret-1' } });
    fireEvent.click(within(region()).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(window.smartlife.calendar.setClientConfig).toHaveBeenCalledWith('id-1', 'secret-1')
    );
  });

  it('clears the secret field after saving', async () => {
    render(<Settings />);
    await screen.findByRole('heading', { name: 'Settings' });

    fireEvent.change(screen.getByLabelText('Google Client ID'), { target: { value: 'id-1' } });
    fireEvent.change(screen.getByLabelText('Google Client Secret'), { target: { value: 'secret-1' } });
    fireEvent.click(within(region()).getByRole('button', { name: 'Save' }));

    // Leaving a secret sitting in a visible form field is careless even when
    // it is not strictly confidential.
    await waitFor(() => expect(screen.getByLabelText('Google Client Secret')).toHaveValue(''));
  });

  it('surfaces a connect failure instead of claiming success', async () => {
    vi.mocked(window.smartlife.calendar.connect).mockResolvedValue({
      ok: false,
      error: 'Google did not return a refresh token.',
    } as never);
    render(<Settings />);
    await screen.findByRole('heading', { name: 'Settings' });

    fireEvent.click(within(region()).getByRole('button', { name: 'Connect' }));

    expect(await within(region()).findByRole('alert')).toHaveTextContent(/refresh token/i);
  });
});
```

- [ ] **Step 11: Run the full suite, lint, and typecheck**

Run: `npm run lint && npm run typecheck && npm run test`
Expected: all exit 0. If a pre-existing Settings test now fails on an ambiguous "Save" button, scope its query with `within(...)` — that is the same disambiguation Phase 3 applied, not a regression.

- [ ] **Step 12: Commit**

```bash
git add src/renderer/src/calendar src/renderer/src/routes/Calendar.tsx src/renderer/src/routes/Settings.tsx src/renderer/src/routes/Settings.test.tsx
git commit -m "Task 11: event dialog, calendar toggles, and Settings Google block"
```

---

### Task 12: Calendar AI tools

**Files:**
- Create: `src/main/ai/tools/calendarListEvents.ts`
- Create: `src/main/ai/tools/calendarCreateEvent.ts`
- Create: `src/main/ai/tools/calendarUpdateEvent.ts`
- Create: `src/main/ai/tools/calendarDeleteEvent.ts`
- Create: `src/main/ai/tools/calendarTools.test.ts`
- Modify: `src/main/ai/tools/registry.ts`

**Interfaces:**
- Consumes: `ToolDefinition`/`ToolContext` from `./types`, `gate` from `../permissions`, Task 6's `getEventsInRange`/`getEvent`/`listCalendarRows`, Task 7's `createCalendarEvent`/`updateCalendarEvent`/`deleteCalendarEvent`.
- Produces: `calendarListEventsTool`, `calendarCreateEventTool`, `calendarUpdateEventTool`, `calendarDeleteEventTool`, all appended to `TOOLS`.

**Context for the implementer:** this is the phase's central safety boundary. Each tool calls `gate()` itself, passing a tier computed **at call time**:

- `calendar_list_events` — READ, no gate needed (READ never pauses in any mode). Follow `canvasUpcoming.ts`, which omits the gate call for the same reason.
- `calendar_create_event` — `SAFE_WRITE`, escalating to `CONSEQUENTIAL` when the input names attendees.
- `calendar_update_event` — `SAFE_WRITE`, escalating to `CONSEQUENTIAL` when the **stored** event has guests or the input adds them.
- `calendar_delete_event` — `CONSEQUENTIAL` unconditionally.

The escalation exists because touching an event with attendees emails real people, which cannot be unsent. The `description` passed to `gate()` is what the user actually sees in the confirmation prompt, so it must state the real consequence including the guest count — a prompt that only names the tool is a rubber stamp.

The `tier` field on each `ToolDefinition` is display metadata; it should carry the *baseline* tier. The gate call is what enforces.

- [ ] **Step 1: Write the failing tools test**

Create `src/main/ai/tools/calendarTools.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

vi.mock('../../calendar/writes', () => ({
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
}));

import { createCalendarEvent, deleteCalendarEvent, updateCalendarEvent } from '../../calendar/writes';
import { calendarCreateEventTool } from './calendarCreateEvent';
import { calendarDeleteEventTool } from './calendarDeleteEvent';
import { calendarListEventsTool } from './calendarListEvents';
import { calendarUpdateEventTool } from './calendarUpdateEvent';
import type { AiMode } from '../permissions';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    create table settings (key text primary key, value text not null);
    create table google_calendars (
      id text primary key, summary text not null, time_zone text, background_color text,
      access_role text, is_primary integer not null default 0, enabled integer not null default 1,
      synced_at text not null default (datetime('now'))
    );
    create table google_events (
      calendar_id text not null references google_calendars(id) on delete cascade,
      id text not null, summary text, description text, location text,
      start_at text not null, end_at text not null, is_all_day integer not null default 0,
      status text, html_link text, organizer_email text,
      has_guests integer not null default 0, guest_count integer not null default 0,
      recurring_event_id text, etag text, updated_at text,
      synced_at text not null default (datetime('now')),
      primary key (calendar_id, id)
    );
    create table calendar_sync_state (key text primary key, value text not null);
  `);
  db.prepare("insert into google_calendars (id, summary, is_primary) values ('cal-1','Personal',1)").run();
  return db;
}

function seedEvent(db: Database.Database, overrides: Record<string, unknown> = {}): void {
  db.prepare(
    `insert into google_events (calendar_id, id, summary, start_at, end_at, has_guests, guest_count)
     values (@calendar_id, @id, @summary, @start_at, @end_at, @has_guests, @guest_count)`
  ).run({
    calendar_id: 'cal-1',
    id: 'evt-1',
    summary: 'Group project sync',
    start_at: '2026-08-27T18:00:00.000Z',
    end_at: '2026-08-27T19:00:00.000Z',
    has_guests: 0,
    guest_count: 0,
    ...overrides,
  });
}

function ctx(db: Database.Database, mode: AiMode, requestConfirmation = vi.fn().mockResolvedValue(true)) {
  return { db, conversationId: 'c1', mode, requestConfirmation };
}

beforeEach(() => {
  vi.mocked(createCalendarEvent).mockReset().mockResolvedValue({ ok: true, eventId: 'new-1' } as never);
  vi.mocked(updateCalendarEvent).mockReset().mockResolvedValue({ ok: true } as never);
  vi.mocked(deleteCalendarEvent).mockReset().mockResolvedValue({ ok: true } as never);
});

describe('calendar_list_events', () => {
  it('is READ tier', () => {
    expect(calendarListEventsTool.tier).toBe('READ');
  });

  it('reads local data without ever asking for confirmation', async () => {
    const db = makeDb();
    seedEvent(db);
    const requestConfirmation = vi.fn();

    const output = await calendarListEventsTool.run(
      { start: '2026-08-24', end: '2026-08-30' },
      ctx(db, 'ask', requestConfirmation)
    );

    expect(output).toContain('Group project sync');
    // READ tools must never pause, even in ask mode.
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('says so plainly when nothing is scheduled', async () => {
    const output = await calendarListEventsTool.run(
      { start: '2026-08-24', end: '2026-08-30' },
      ctx(makeDb(), 'ask')
    );
    expect(output).toMatch(/nothing/i);
  });
});

describe('calendar_create_event', () => {
  it('does not pause in assist mode for a solo event', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    await calendarCreateEventTool.run(
      {
        calendarId: 'cal-1',
        summary: 'Study block',
        start: '2026-08-27T18:00:00.000Z',
        end: '2026-08-27T20:00:00.000Z',
      },
      ctx(makeDb(), 'assist', requestConfirmation)
    );

    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(createCalendarEvent).toHaveBeenCalledTimes(1);
  });

  it('pauses in assist mode when attendees are named', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    await calendarCreateEventTool.run(
      {
        calendarId: 'cal-1',
        summary: 'Group sync',
        start: '2026-08-27T18:00:00.000Z',
        end: '2026-08-27T19:00:00.000Z',
        attendees: ['a@example.com', 'b@example.com'],
      },
      ctx(makeDb(), 'assist', requestConfirmation)
    );

    // Inviting real people is outward-facing and cannot be unsent.
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    const description = requestConfirmation.mock.calls[0][1] as string;
    expect(description).toContain('Group sync');
    expect(description).toContain('2 guests');
  });

  it('pauses in ask mode even for a solo event', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    await calendarCreateEventTool.run(
      { calendarId: 'cal-1', summary: 'Study block', start: '2026-08-27T18:00:00.000Z', end: '2026-08-27T20:00:00.000Z' },
      ctx(makeDb(), 'ask', requestConfirmation)
    );

    expect(requestConfirmation).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the user declines', async () => {
    const output = await calendarCreateEventTool.run(
      { calendarId: 'cal-1', summary: 'Study block', start: '2026-08-27T18:00:00.000Z', end: '2026-08-27T20:00:00.000Z' },
      ctx(makeDb(), 'ask', vi.fn().mockResolvedValue(false))
    );

    expect(createCalendarEvent).not.toHaveBeenCalled();
    expect(output).toMatch(/declin|cancel/i);
  });

  it('reports a write failure back to the model', async () => {
    vi.mocked(createCalendarEvent).mockResolvedValue({ ok: false, error: "You're offline — this change wasn't saved." } as never);

    const output = await calendarCreateEventTool.run(
      { calendarId: 'cal-1', summary: 'x', start: '2026-08-27T18:00:00.000Z', end: '2026-08-27T19:00:00.000Z' },
      ctx(makeDb(), 'auto')
    );

    expect(output).toContain('offline');
  });
});

describe('calendar_update_event', () => {
  it('escalates when the STORED event has guests, even if the input does not', async () => {
    const db = makeDb();
    seedEvent(db, { has_guests: 1, guest_count: 3 });
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    await calendarUpdateEventTool.run(
      {
        calendarId: 'cal-1',
        eventId: 'evt-1',
        summary: 'Group project sync',
        start: '2026-08-28T18:00:00.000Z',
        end: '2026-08-28T19:00:00.000Z',
      },
      ctx(db, 'assist', requestConfirmation)
    );

    // Moving an existing meeting emails its attendees whether or not the tool
    // input mentions them.
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(requestConfirmation.mock.calls[0][1]).toContain('3 guests');
  });

  it('does not pause in assist mode for a solo event', async () => {
    const db = makeDb();
    seedEvent(db);
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    await calendarUpdateEventTool.run(
      { calendarId: 'cal-1', eventId: 'evt-1', summary: 'Renamed', start: '2026-08-28T18:00:00.000Z', end: '2026-08-28T19:00:00.000Z' },
      ctx(db, 'assist', requestConfirmation)
    );

    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('fails cleanly when the event is unknown', async () => {
    const output = await calendarUpdateEventTool.run(
      { calendarId: 'cal-1', eventId: 'ghost', summary: 'x', start: '2026-08-28T18:00:00.000Z', end: '2026-08-28T19:00:00.000Z' },
      ctx(makeDb(), 'auto')
    );

    expect(output).toMatch(/not found|no event/i);
    expect(updateCalendarEvent).not.toHaveBeenCalled();
  });
});

describe('calendar_delete_event', () => {
  it('is CONSEQUENTIAL and pauses even in assist mode for a solo event', async () => {
    const db = makeDb();
    seedEvent(db);
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    expect(calendarDeleteEventTool.tier).toBe('CONSEQUENTIAL');
    await calendarDeleteEventTool.run({ calendarId: 'cal-1', eventId: 'evt-1' }, ctx(db, 'assist', requestConfirmation));

    expect(requestConfirmation).toHaveBeenCalledTimes(1);
  });

  it('names the event and its guests in the confirmation', async () => {
    const db = makeDb();
    seedEvent(db, { has_guests: 1, guest_count: 3 });
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    await calendarDeleteEventTool.run({ calendarId: 'cal-1', eventId: 'evt-1' }, ctx(db, 'ask', requestConfirmation));

    const description = requestConfirmation.mock.calls[0][1] as string;
    // A confirmation that does not say what will happen is a rubber stamp.
    expect(description).toContain('Group project sync');
    expect(description).toContain('3 guests');
  });

  it('deletes nothing when declined', async () => {
    const db = makeDb();
    seedEvent(db);

    await calendarDeleteEventTool.run(
      { calendarId: 'cal-1', eventId: 'evt-1' },
      ctx(db, 'ask', vi.fn().mockResolvedValue(false))
    );

    expect(deleteCalendarEvent).not.toHaveBeenCalled();
  });
});

describe('registry', () => {
  it('registers all four calendar tools', async () => {
    const { TOOLS } = await import('./registry');
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toContain('calendar_list_events');
    expect(names).toContain('calendar_create_event');
    expect(names).toContain('calendar_update_event');
    expect(names).toContain('calendar_delete_event');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/main/ai/tools/calendarTools.test.ts`
Expected: FAIL with unresolved imports for the four tool modules.

- [ ] **Step 3: Implement the read tool**

Create `src/main/ai/tools/calendarListEvents.ts`:

```ts
import type { ToolDefinition } from './types';
import { getEventsInRange } from '../../calendar/queries';

export const calendarListEventsTool: ToolDefinition = {
  name: 'calendar_list_events',
  tier: 'READ',
  label: 'Read calendar events',
  schema: {
    name: 'calendar_list_events',
    description:
      "List the user's Google Calendar events between two dates. Reads locally synced data, so it is instant, works offline, and consumes no Google quota. Use this to answer questions about the schedule and to find free time before proposing a new event.",
    input_schema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'Start date, YYYY-MM-DD (inclusive).' },
        end: { type: 'string', description: 'End date, YYYY-MM-DD (inclusive).' },
      },
      required: ['start', 'end'],
    },
  },
  async run(input, ctx) {
    const start = String(input.start ?? '');
    const end = String(input.end ?? '');
    const events = getEventsInRange(ctx.db, start, end);
    if (events.length === 0) return `Nothing is scheduled between ${start} and ${end}.`;

    const lines = events.map((event) => {
      const when = event.isAllDay ? `${event.startAt} (all day)` : `${event.startAt} – ${event.endAt}`;
      const guests = event.hasGuests ? ` — ${event.guestCount} guests` : '';
      const where = event.location === null ? '' : ` @ ${event.location}`;
      // The calendarId/eventId pair is what the write tools need, so it has to
      // be in the output the model reads.
      return `- ${event.summary ?? 'Untitled'} — ${when}${where}${guests} [calendarId=${event.calendarId} eventId=${event.id}]`;
    });
    return `Events between ${start} and ${end}:\n${lines.join('\n')}`;
  },
};
```

- [ ] **Step 4: Implement the create tool**

Create `src/main/ai/tools/calendarCreateEvent.ts`:

```ts
import type { ToolDefinition } from './types';
import { gate } from '../permissions';
import { createCalendarEvent } from '../../calendar/writes';

export const calendarCreateEventTool: ToolDefinition = {
  name: 'calendar_create_event',
  // Baseline tier for display. The gate call below is what enforces, and it
  // escalates to CONSEQUENTIAL when other people are invited.
  tier: 'SAFE_WRITE',
  label: 'Create a calendar event',
  schema: {
    name: 'calendar_create_event',
    description:
      "Create an event on one of the user's Google Calendars. Use calendar_list_events first to check for conflicts. Times are RFC3339 timestamps for timed events, or YYYY-MM-DD dates when allDay is true.",
    input_schema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar to add to. Use the primary calendar unless told otherwise.' },
        summary: { type: 'string', description: 'Event title.' },
        start: { type: 'string', description: 'RFC3339 start, or YYYY-MM-DD when allDay is true.' },
        end: { type: 'string', description: 'RFC3339 end, or the exclusive YYYY-MM-DD end date when allDay is true.' },
        allDay: { type: 'boolean', description: 'True for an all-day event. Defaults to false.' },
        location: { type: 'string', description: 'Optional location.' },
        description: { type: 'string', description: 'Optional notes.' },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional guest email addresses. Adding any will email those people.',
        },
      },
      required: ['calendarId', 'summary', 'start', 'end'],
    },
  },
  async run(input, ctx) {
    const attendees = Array.isArray(input.attendees) ? (input.attendees as string[]) : [];
    const summary = String(input.summary ?? '');
    const start = String(input.start ?? '');

    // Escalation happens at call time: inviting real people is outward-facing
    // and cannot be unsent, unlike adding a solo block to your own calendar.
    const tier = attendees.length > 0 ? 'CONSEQUENTIAL' : 'SAFE_WRITE';
    const guestNote = attendees.length > 0 ? ` ${attendees.length} guests will be invited by email.` : '';
    const approved = await gate(
      tier,
      ctx.mode,
      'calendar_create_event',
      `Create "${summary}" starting ${start}.${guestNote}`,
      ctx.requestConfirmation
    );
    if (!approved) return 'The user declined, so no event was created.';

    const result = await createCalendarEvent(ctx.db, {
      calendarId: String(input.calendarId ?? ''),
      summary,
      startAt: start,
      endAt: String(input.end ?? ''),
      isAllDay: input.allDay === true,
      location: typeof input.location === 'string' ? input.location : undefined,
      description: typeof input.description === 'string' ? input.description : undefined,
      attendees: attendees.length > 0 ? attendees : undefined,
    });

    return result.ok ? `Created "${summary}".` : `Could not create the event: ${result.error ?? 'unknown error'}`;
  },
};
```

- [ ] **Step 5: Implement the update tool**

Create `src/main/ai/tools/calendarUpdateEvent.ts`:

```ts
import type { ToolDefinition } from './types';
import { gate } from '../permissions';
import { getEvent } from '../../calendar/queries';
import { updateCalendarEvent } from '../../calendar/writes';

export const calendarUpdateEventTool: ToolDefinition = {
  name: 'calendar_update_event',
  tier: 'SAFE_WRITE',
  label: 'Update a calendar event',
  schema: {
    name: 'calendar_update_event',
    description:
      'Change an existing calendar event — its title, time, location, or notes. Get calendarId and eventId from calendar_list_events. This replaces the event, so pass every field you want kept.',
    input_schema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar the event lives on.' },
        eventId: { type: 'string', description: 'Event to change.' },
        summary: { type: 'string', description: 'Event title.' },
        start: { type: 'string', description: 'RFC3339 start, or YYYY-MM-DD when allDay is true.' },
        end: { type: 'string', description: 'RFC3339 end, or the exclusive YYYY-MM-DD end date when allDay is true.' },
        allDay: { type: 'boolean', description: 'True for an all-day event. Defaults to false.' },
        location: { type: 'string', description: 'Optional location.' },
        description: { type: 'string', description: 'Optional notes.' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Optional guest email addresses.' },
      },
      required: ['calendarId', 'eventId', 'summary', 'start', 'end'],
    },
  },
  async run(input, ctx) {
    const calendarId = String(input.calendarId ?? '');
    const eventId = String(input.eventId ?? '');
    const existing = getEvent(ctx.db, calendarId, eventId);
    if (existing === null) {
      return `No event found with id ${eventId} on calendar ${calendarId}. Use calendar_list_events to find it.`;
    }

    const attendees = Array.isArray(input.attendees) ? (input.attendees as string[]) : [];
    const summary = String(input.summary ?? '');
    const start = String(input.start ?? '');

    // The STORED event's guests matter as much as the input's: moving an
    // existing meeting emails its attendees whether or not this call mentions
    // them.
    const guestCount = Math.max(existing.guestCount, attendees.length);
    const hasGuests = existing.hasGuests || attendees.length > 0;
    const tier = hasGuests ? 'CONSEQUENTIAL' : 'SAFE_WRITE';
    const guestNote = hasGuests ? ` ${guestCount} guests will be notified by email.` : '';

    const approved = await gate(
      tier,
      ctx.mode,
      'calendar_update_event',
      `Change "${existing.summary ?? 'Untitled'}" to "${summary}" starting ${start}.${guestNote}`,
      ctx.requestConfirmation
    );
    if (!approved) return 'The user declined, so the event was left unchanged.';

    const result = await updateCalendarEvent(ctx.db, eventId, {
      calendarId,
      summary,
      startAt: start,
      endAt: String(input.end ?? ''),
      isAllDay: input.allDay === true,
      location: typeof input.location === 'string' ? input.location : undefined,
      description: typeof input.description === 'string' ? input.description : undefined,
      attendees: attendees.length > 0 ? attendees : undefined,
    });

    return result.ok ? `Updated "${summary}".` : `Could not update the event: ${result.error ?? 'unknown error'}`;
  },
};
```

- [ ] **Step 6: Implement the delete tool**

Create `src/main/ai/tools/calendarDeleteEvent.ts`:

```ts
import type { ToolDefinition } from './types';
import { gate } from '../permissions';
import { getEvent } from '../../calendar/queries';
import { deleteCalendarEvent } from '../../calendar/writes';

export const calendarDeleteEventTool: ToolDefinition = {
  name: 'calendar_delete_event',
  // Always CONSEQUENTIAL: a deletion destroys data and, when the event has
  // attendees, sends everyone a cancellation.
  tier: 'CONSEQUENTIAL',
  label: 'Delete a calendar event',
  schema: {
    name: 'calendar_delete_event',
    description:
      'Delete a calendar event. Get calendarId and eventId from calendar_list_events. This cannot be undone from within SmartLife.',
    input_schema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar the event lives on.' },
        eventId: { type: 'string', description: 'Event to delete.' },
      },
      required: ['calendarId', 'eventId'],
    },
  },
  async run(input, ctx) {
    const calendarId = String(input.calendarId ?? '');
    const eventId = String(input.eventId ?? '');
    const existing = getEvent(ctx.db, calendarId, eventId);
    if (existing === null) {
      return `No event found with id ${eventId} on calendar ${calendarId}. Nothing was deleted.`;
    }

    const guestNote = existing.hasGuests
      ? ` ${existing.guestCount} guests will be notified by email.`
      : '';
    const approved = await gate(
      'CONSEQUENTIAL',
      ctx.mode,
      'calendar_delete_event',
      `Delete "${existing.summary ?? 'Untitled'}" — ${existing.startAt}.${guestNote}`,
      ctx.requestConfirmation
    );
    if (!approved) return 'The user declined, so nothing was deleted.';

    const result = await deleteCalendarEvent(ctx.db, calendarId, eventId);
    return result.ok
      ? `Deleted "${existing.summary ?? 'Untitled'}".`
      : `Could not delete the event: ${result.error ?? 'unknown error'}`;
  },
};
```

- [ ] **Step 7: Register the tools**

Modify `src/main/ai/tools/registry.ts` — add the imports and append the four entries to `TOOLS`:

```ts
import { calendarListEventsTool } from './calendarListEvents';
import { calendarCreateEventTool } from './calendarCreateEvent';
import { calendarUpdateEventTool } from './calendarUpdateEvent';
import { calendarDeleteEventTool } from './calendarDeleteEvent';
```

```ts
export const TOOLS: ToolDefinition[] = [
  getSettingsTool,
  setThemeTool,
  clearConversationHistoryTool,
  canvasUpcomingTool,
  canvasGradesTool,
  canvasSearchMaterialsTool,
  calendarListEventsTool,
  calendarCreateEventTool,
  calendarUpdateEventTool,
  calendarDeleteEventTool,
];
```

- [ ] **Step 8: Run the tools tests**

Run: `npm run test -- src/main/ai/tools/calendarTools.test.ts`
Expected: PASS, 15/15.

- [ ] **Step 9: Run the full suite, lint, and typecheck**

Run: `npm run lint && npm run typecheck && npm run test`
Expected: all exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/main/ai/tools
git commit -m "Task 12: four calendar AI tools with runtime tier escalation for guests"
```

---

### Task 13: Packaging and final verification

**Files:** none created. This task verifies and packages Tasks 1–12, matching the closing task of Phases 1–3.

**Interfaces:** consumes everything; produces nothing further.

- [ ] **Step 1: Run the complete pipeline**

Run: `npm run lint && npm run typecheck && npm run test && npm run build`
Expected: every command exits 0. Note the total test count for the report — Phase 3 finished at 243, and Tasks 1–12 add roughly 130.

- [ ] **Step 2: Confirm no new runtime dependency crept in**

Run: `node -e "const p=require('./package.json');console.log(Object.keys(p.dependencies).join(','))"`
Expected: exactly `@anthropic-ai/sdk,better-sqlite3`. Anything else — an RRULE library in particular — violates a Global Constraint. Stop and report rather than proceeding.

- [ ] **Step 3: Confirm the sync engine never fans out**

Run: `grep -rn "Promise.all" src/main/calendar/`
Expected: no output. (`useCalendar.ts` in the renderer does use `Promise.all`, but over local IPC reads, not network calls — this grep is deliberately scoped to `src/main/calendar/`.)

- [ ] **Step 4: Confirm the recurrence expansion is still server-side**

Run: `grep -rn "singleEvents" src/main/calendar/api.ts`
Expected: one hit, `singleEvents: true`, inside `listEvents`. If this is gone, Google is returning master recurring events and every repeating event is being dropped or mis-rendered.

- [ ] **Step 5: Confirm access tokens are never persisted**

Run: `grep -rn "access_token\|accessToken" src/main/calendar/token.ts`
Expected: hits only inside the in-memory cache functions (`setCachedAccessToken`, `getCachedAccessToken`, `clearCachedAccessToken`) — never inside `writeSetting`/`writeEncrypted`.

- [ ] **Step 6: Confirm the CSP was not widened**

Run: `git diff $(git merge-base main HEAD) HEAD -- src/main/csp.ts`
Expected: no output. All Google traffic is main-process; a CSP change here would be a silent security regression.

- [ ] **Step 7: Confirm the Canvas scheduler tests were not edited**

Run: `git diff $(git merge-base main HEAD) HEAD -- src/main/canvas/scheduler.test.ts`
Expected: no output. Those 10 tests are the acceptance criteria for Task 4's extraction; editing them to pass would defeat the check.

- [ ] **Step 8: Package the app**

Run: `npm run package`
Expected: exits 0.

- [ ] **Step 9: Verify the packaged artifact exists**

Run: `find release -maxdepth 3 -name "SmartLife.app"`
Expected: prints one path.

- [ ] **Step 10: Verify the built main process boots**

Run with `ELECTRON_RUN_AS_NODE=1` set: `npx electron -e "require('./out/main/index.js')" 2>&1 | head -20`
Expected: no `ERR_REQUIRE_ESM`, no module-resolution error. Phase 2 shipped a boot-crashing import that every unit test passed straight through; this is the check that catches that class of bug.

- [ ] **Step 11: Confirm no secrets were committed**

Run: `git log --all -p -- '*.ts' '*.tsx' | grep -iE "(sk-ant-|GOCSPX-|[0-9]{4}~[A-Za-z0-9]{40,})" | grep -v "sk-ant-test"`
Expected: no output. `GOCSPX-` is the prefix of a Google OAuth client secret. **If this finds something, stop and report it — do not attempt to rewrite git history yourself.**

- [ ] **Step 12: Confirm the working tree is clean**

Run: `git status`
Expected: `release/` and `out/` untracked or ignored, matching Phases 1–3. Nothing to commit for this task if clean.

---

## After this plan

Once all 13 tasks are reviewed and approved, the controller runs a whole-branch review (`git merge-base main HEAD` → HEAD), then a real visual pass the same way as Phases 1–3.

**The user performs the Google Cloud setup themselves, and enters the credentials themselves.** Walk them through it at that point: create or reuse a Google Cloud project, enable the Calendar API, configure the OAuth consent screen and **publish it to "In production"** (this is what avoids 7-day refresh-token expiry), then create an OAuth client of type **Desktop app**. Never ask them to paste a client secret into a chat message, a file, or a test fixture — it goes into the Settings field, where safeStorage encrypts it into the Keychain.

Manual verification once connected: open Calendar and confirm the "Connect Google Calendar" empty state renders; paste the Client ID and Secret in Settings and hit Connect; approve in the browser (clicking through the unverified-app warning) and confirm Settings shows the account email and calendar list. Confirm the week grid populates, that an all-day event renders in the strip on the correct day, and that Canvas due dates appear. Create an event, move it, and delete it, confirming each round-trips to Google. Toggle a calendar off and confirm its events disappear and reappear. Finally, ask the assistant "schedule a 2-hour study block Thursday afternoon" and confirm it asks once before creating, then ask it to move an event that has guests and confirm it still asks in **assist** mode.

Update `../../../ROADMAP.md`'s status checklist once Phase 4 ships, and move on to brainstorming Phase 4b (Microsoft/Outlook) when the user is ready.
