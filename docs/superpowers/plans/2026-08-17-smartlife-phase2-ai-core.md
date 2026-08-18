# SmartLife Phase 2: AI Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real Claude-backed chat assistant — streaming, a three-tier tool-permission system, persistent history — reachable from a dedicated AI section, a Cmd+J overlay, and a separate Cmd+K command palette.

**Architecture:** All Anthropic API access and the API key live in the main process only. The renderer sends a message over IPC and receives streamed events back. The SDK's beta Tool Runner (raw-JSON-Schema form) drives the tool-calling loop; each tool's own `run()` function performs its own permission-tier check and pauses for confirmation via a dedicated IPC round-trip when required.

**Tech Stack:** `@anthropic-ai/sdk` (new), Electron `safeStorage`, everything already in place from Phase 1 (better-sqlite3, React Router, ThemeProvider, IPC bridge).

See `../../../ROADMAP.md` and `../specs/2026-08-17-smartlife-phase2-ai-core-design.md` for the approved design this plan implements.

## Global Constraints

- macOS only, no network calls outside the Anthropic API itself.
- No dependency beyond `@anthropic-ai/sdk` plus everything already installed in Phase 1. No Zod — use the Tool Runner's raw-JSON-Schema form (`betaTool()` from `@anthropic-ai/sdk/helpers/beta/json-schema`), not `betaZodTool()`.
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` remain intact — this phase adds no new `BrowserWindow`; the AI overlay is in-window UI.
- The Anthropic API key never leaves the main process in plaintext, is never logged, and is never sent to the renderer in any IPC payload — only a boolean "configured" status is exposed.
- `ai_mode` defaults to `'ask'` (most conservative) when unset.
- Model id: `claude-sonnet-5`.
- Exactly one conversation exists in Phase 2 — no `getConversations`/`createConversation` IPC methods, no conversation switcher UI.

---

### Task 1: Anthropic SDK dependency + API key storage (safeStorage)

**Files:**
- Modify: `package.json`
- Create: `src/main/ai/apiKey.ts`
- Test: `src/main/ai/apiKey.test.ts`
- Create: `src/main/ai/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts` (no change needed — `SmartlifeApi` type is inferred from `index.ts`'s exported const; verify this still holds, see Step 6)
- Modify: `src/renderer/src/routes/Settings.tsx`
- Test: `src/renderer/src/routes/Settings.test.tsx` (new)
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `settings` table shape from Phase 1 Task 2 (`key text primary key, value text not null`); `openDb()`, `registerIpcHandlers` wiring pattern from Phase 1 Task 4's `main/index.ts`.
- Produces: `getStoredApiKey(db): string | null`, `setStoredApiKey(db, apiKey): void`, `hasStoredApiKey(db): boolean` from `src/main/ai/apiKey.ts` — Task 5's `chatController` calls `getStoredApiKey`. `registerAiIpcHandlers(db, getWindow): void` from `src/main/ai/ipc.ts` — this file is extended (not replaced) in Tasks 3 and 5; call it once from `main/index.ts` alongside Phase 1's `registerIpcHandlers`. `window.smartlife.ai.getApiKeyStatus(): Promise<boolean>` and `window.smartlife.ai.setApiKey(key: string): Promise<void>` (rejects with a plain `Error` on failure, e.g. `safeStorage` unavailable).

- [ ] **Step 1: Install the Anthropic SDK**

Run: `cd /Users/alexanderbogert/Projects/smartlife && npm install @anthropic-ai/sdk@latest`
Expected: exits 0, adds one entry to `package.json`'s `dependencies` (not `devDependencies` — this is a real runtime dependency of the main process) with a `^`-prefixed version, and to `package-lock.json`.

- [ ] **Step 2: Write the failing API-key-storage tests**

`src/main/ai/apiKey.test.ts`:

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

describe('API key storage', () => {
  it('reports no key stored by default', async () => {
    const { hasStoredApiKey, getStoredApiKey } = await import('./apiKey');
    const db = makeDb();
    expect(hasStoredApiKey(db)).toBe(false);
    expect(getStoredApiKey(db)).toBeNull();
  });

  it('round-trips a stored key through encryption', async () => {
    const { setStoredApiKey, getStoredApiKey, hasStoredApiKey } = await import('./apiKey');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test-key');
    expect(hasStoredApiKey(db)).toBe(true);
    expect(getStoredApiKey(db)).toBe('sk-ant-test-key');
  });

  it('overwrites a previously stored key', async () => {
    const { setStoredApiKey, getStoredApiKey } = await import('./apiKey');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-first');
    setStoredApiKey(db, 'sk-ant-second');
    expect(getStoredApiKey(db)).toBe('sk-ant-second');
  });

  it('throws when encryption is unavailable', async () => {
    vi.doMock('electron', () => ({
      safeStorage: { isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() },
    }));
    vi.resetModules();
    const { setStoredApiKey } = await import('./apiKey');
    const db = makeDb();
    expect(() => setStoredApiKey(db, 'sk-ant-test')).toThrow('Secure storage is not available');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -- src/main/ai/apiKey.test.ts`
Expected: FAIL — `./apiKey` doesn't exist yet.

- [ ] **Step 4: Implement `apiKey.ts`**

```ts
import { safeStorage } from 'electron';
import type Database from 'better-sqlite3';

const SETTINGS_KEY = 'anthropic_api_key_encrypted';

export function hasStoredApiKey(db: Database.Database): boolean {
  const row = db.prepare('select 1 from settings where key = ?').get(SETTINGS_KEY);
  return !!row;
}

export function getStoredApiKey(db: Database.Database): string | null {
  const row = db.prepare('select value from settings where key = ?').get(SETTINGS_KEY) as
    | { value: string }
    | undefined;
  if (!row || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(row.value, 'base64'));
  } catch {
    return null;
  }
}

export function setStoredApiKey(db: Database.Database, apiKey: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system.');
  }
  const encrypted = safeStorage.encryptString(apiKey).toString('base64');
  db.prepare(
    'insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
  ).run(SETTINGS_KEY, encrypted);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- src/main/ai/apiKey.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 6: Write the AI IPC handler file (API key handlers only for now)**

`src/main/ai/ipc.ts`:

```ts
import { ipcMain, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { setStoredApiKey, hasStoredApiKey } from './apiKey';

export function registerAiIpcHandlers(db: Database.Database, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('ai:get-api-key-status', () => hasStoredApiKey(db));
  ipcMain.handle('ai:set-api-key', (_event, apiKey: string) => {
    setStoredApiKey(db, apiKey);
  });
  void getWindow; // unused until Task 5 wires ai:send-message, which needs it — keeps the parameter's purpose visible now
}
```

This file grows across later tasks: Task 3 adds two handlers into this same function body (an incremental edit — add the import and handler lines, nothing here is deleted yet); Task 5 then replaces the whole file with its final version (given in full in that task's own step), which is the point the `void getWindow;` line above finally gets removed, once `getWindow` is genuinely used by the `ai:send-message` handler.

- [ ] **Step 7: Wire the preload bridge**

Add to `src/preload/index.ts`, inside the `smartlife` object literal (alongside the existing `theme`/`app`/`navigation` keys):

```ts
  ai: {
    getApiKeyStatus: (): Promise<boolean> => ipcRenderer.invoke('ai:get-api-key-status'),
    setApiKey: (apiKey: string): Promise<void> => ipcRenderer.invoke('ai:set-api-key', apiKey),
  },
```

`src/preload/index.d.ts` needs no change — it already does `import type { SmartlifeApi } from './index'` and `SmartlifeApi = typeof smartlife`, so the new `ai` key is picked up automatically. Confirm this by running the typecheck in Step 10.

- [ ] **Step 8: Wire `registerAiIpcHandlers` into `main/index.ts`**

In `src/main/index.ts`, add the import:

```ts
import { registerAiIpcHandlers } from './ai/ipc';
```

Inside `loadContent`'s `if (!handlersRegistered)` block, immediately after the existing `registerIpcHandlers(dbConnection, () => mainWindow);` line, add:

```ts
      registerAiIpcHandlers(dbConnection, () => mainWindow);
```

- [ ] **Step 9: Add the API key field to Settings**

In `src/renderer/src/routes/Settings.tsx`, add these imports if not already present (`useEffect`, `useState` should already be imported):

Add this state and effect inside the `Settings` component, after the existing `version` state/effect:

```tsx
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);
  const [apiKeyError, setApiKeyError] = useState('');

  useEffect(() => {
    window.smartlife.ai.getApiKeyStatus().then(setApiKeyConfigured);
  }, []);

  async function handleSaveApiKey(): Promise<void> {
    setApiKeyError('');
    try {
      await window.smartlife.ai.setApiKey(apiKeyInput);
      setApiKeyInput('');
      setApiKeyConfigured(true);
    } catch (err) {
      setApiKeyError(err instanceof Error ? err.message : 'Failed to save key.');
    }
  }
```

Add this JSX block to the component's returned markup, after the existing theme `<div>` block and before the `<p>SmartLife v{version}</p>` line:

```tsx
      <div className="flex flex-col gap-2">
        <span style={{ color: 'var(--color-text-muted)' }}>
          Claude API key {apiKeyConfigured === true ? '— connected' : apiKeyConfigured === false ? '— not connected' : ''}
        </span>
        <div className="flex gap-2">
          <input
            type="password"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder="sk-ant-..."
            className="rounded-md px-3 py-1.5 text-sm"
            style={{
              backgroundColor: 'var(--color-surface)',
              color: 'var(--color-text)',
              border: '1px solid var(--color-border)',
            }}
          />
          <button
            type="button"
            onClick={handleSaveApiKey}
            disabled={apiKeyInput.length === 0}
            className="rounded-md px-3 py-1.5 text-sm"
            style={{
              backgroundColor: 'var(--color-text)',
              color: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
            }}
          >
            Save
          </button>
        </div>
        {apiKeyError && <span style={{ color: '#F87171' }}>{apiKeyError}</span>}
      </div>
```

- [ ] **Step 10: Write the failing Settings API-key test**

`src/renderer/src/routes/Settings.test.tsx` (new file — Settings.tsx currently has no dedicated test file; it was only exercised indirectly via `App.test.tsx` in Phase 1):

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '../theme/ThemeProvider';
import { Settings } from './Settings';

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  (window as unknown as { smartlife: typeof window.smartlife }).smartlife = {
    theme: {
      get: vi.fn().mockResolvedValue('light'),
      set: vi.fn().mockResolvedValue(undefined),
      onSystemChange: vi.fn(() => () => {}),
    },
    app: { getVersion: vi.fn().mockResolvedValue('0.1.0') },
    navigation: { onNavigate: vi.fn(() => () => {}) },
    ai: {
      getApiKeyStatus: vi.fn().mockResolvedValue(false),
      setApiKey: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as typeof window.smartlife;
});

describe('Settings — API key', () => {
  it('shows not-connected status, saves a key, and shows connected', async () => {
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    );

    expect(await screen.findByText(/not connected/)).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('sk-ant-...'), 'sk-ant-test-123');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(window.smartlife.ai.setApiKey).toHaveBeenCalledWith('sk-ant-test-123'));
    expect(await screen.findByText(/— connected/)).toBeInTheDocument();
  });

  it('shows an error message when saving fails', async () => {
    (window.smartlife.ai.setApiKey as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Secure storage is not available on this system.')
    );
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    );

    await screen.findByText(/not connected/);
    await userEvent.type(screen.getByPlaceholderText('sk-ant-...'), 'sk-ant-test-123');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Secure storage is not available on this system.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 11: Run test to verify it passes**

Run: `npm run test -- src/renderer/src/routes/Settings.test.tsx`
Expected: PASS, 2/2.

Note: `App.test.tsx`'s existing mock of `window.smartlife` (from Phase 1 Task 6) does not include an `ai` key. Since that test navigates to Settings and only asserts on the theme buttons, it will still pass — but `Settings.tsx`'s `useEffect` calling `window.smartlife.ai.getApiKeyStatus()` will throw when `ai` is undefined on that mock. Fix this now:

- [ ] **Step 12: Extend `App.test.tsx`'s mock**

In `src/renderer/src/App.test.tsx`, add to the `window.smartlife` mock object (inside `beforeEach`), alongside the existing `theme`/`app`/`navigation` keys:

```ts
    ai: {
      getApiKeyStatus: vi.fn().mockResolvedValue(false),
      setApiKey: vi.fn().mockResolvedValue(undefined),
    },
```

- [ ] **Step 13: Run the full check**

Run: `npm run typecheck && npm run lint && npm run test && npm run build`
Expected: all exit 0.

- [ ] **Step 14: Commit**

```bash
git add package.json package-lock.json src/main/ai/ src/main/index.ts src/preload/index.ts src/renderer/src/routes/Settings.tsx src/renderer/src/routes/Settings.test.tsx src/renderer/src/App.test.tsx
git commit -m "Task 1: Anthropic SDK dependency and API key storage via safeStorage"
```

---

### Task 2: Database migration — conversations, messages, ai_mode

**Files:**
- Create: `src/main/db/migrations/0002_ai_core.sql`
- Modify: `src/main/db/index.ts`
- Create: `src/main/ai/conversation.ts`
- Test: `src/main/ai/conversation.test.ts`

**Interfaces:**
- Consumes: `runMigrations`/`Migration` from Phase 1 Task 2's `src/main/db/migrate.ts` (unchanged); `openDb()`'s existing single-migration-array pattern.
- Produces: `StoredMessage` type, `getOrCreateConversationId(db): string`, `appendMessage(db, conversationId, role, content): void`, `getMessages(db, conversationId): StoredMessage[]`, `clearMessages(db, conversationId): void` from `src/main/ai/conversation.ts` — Task 4's `clear_conversation_history` tool calls `clearMessages`; Task 5's `chatController` calls all four.

- [ ] **Step 1: Write the migration file**

`src/main/db/migrations/0002_ai_core.sql`:

```sql
create table ai_conversations (
  id text primary key,
  title text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

create table ai_messages (
  id text primary key,
  conversation_id text not null references ai_conversations(id) on delete cascade,
  role text not null,
  content text not null,
  created_at text not null default (datetime('now'))
);

create index ai_messages_conversation_idx on ai_messages(conversation_id, created_at);
```

- [ ] **Step 2: Register the migration in `db/index.ts`**

In `src/main/db/index.ts`, add the import:

```ts
import migration0002 from './migrations/0002_ai_core.sql?raw';
```

Change the `runMigrations` call inside `openDb()` from:

```ts
  runMigrations(db, [{ filename: '0001_init.sql', sql: migration0001 }]);
```

to:

```ts
  runMigrations(db, [
    { filename: '0001_init.sql', sql: migration0001 },
    { filename: '0002_ai_core.sql', sql: migration0002 },
  ]);
```

- [ ] **Step 3: Write the failing conversation-helpers test**

`src/main/ai/conversation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';

const INIT_SQL = `create table settings (key text primary key, value text not null);`;
const AI_CORE_SQL = `
create table ai_conversations (
  id text primary key,
  title text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);
create table ai_messages (
  id text primary key,
  conversation_id text not null references ai_conversations(id) on delete cascade,
  role text not null,
  content text not null,
  created_at text not null default (datetime('now'))
);
create index ai_messages_conversation_idx on ai_messages(conversation_id, created_at);
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, [
    { filename: '0001_init.sql', sql: INIT_SQL },
    { filename: '0002_ai_core.sql', sql: AI_CORE_SQL },
  ]);
  return db;
}

describe('conversation helpers', () => {
  it('creates a conversation on first call and reuses it on later calls', async () => {
    const { getOrCreateConversationId } = await import('./conversation');
    const db = makeDb();
    const first = getOrCreateConversationId(db);
    const second = getOrCreateConversationId(db);
    expect(first).toBe(second);
    const count = db.prepare('select count(*) as count from ai_conversations').get() as { count: number };
    expect(count.count).toBe(1);
  });

  it('appends and retrieves messages in order', async () => {
    const { getOrCreateConversationId, appendMessage, getMessages } = await import('./conversation');
    const db = makeDb();
    const conversationId = getOrCreateConversationId(db);
    appendMessage(db, conversationId, 'user', [{ type: 'text', text: 'hello' }]);
    appendMessage(db, conversationId, 'assistant', [{ type: 'text', text: 'hi there' }]);
    const messages = getMessages(db, conversationId);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(JSON.parse(messages[0].content)).toEqual([{ type: 'text', text: 'hello' }]);
    expect(messages[1].role).toBe('assistant');
  });

  it('clears all messages for a conversation', async () => {
    const { getOrCreateConversationId, appendMessage, getMessages, clearMessages } = await import('./conversation');
    const db = makeDb();
    const conversationId = getOrCreateConversationId(db);
    appendMessage(db, conversationId, 'user', [{ type: 'text', text: 'hello' }]);
    clearMessages(db, conversationId);
    expect(getMessages(db, conversationId)).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm run test -- src/main/ai/conversation.test.ts`
Expected: FAIL — `./conversation` doesn't exist yet.

- [ ] **Step 5: Implement `conversation.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export function getOrCreateConversationId(db: Database.Database): string {
  const existing = db.prepare('select id from ai_conversations order by created_at limit 1').get() as
    | { id: string }
    | undefined;
  if (existing) return existing.id;

  const id = randomUUID();
  db.prepare('insert into ai_conversations (id) values (?)').run(id);
  return id;
}

export function appendMessage(
  db: Database.Database,
  conversationId: string,
  role: 'user' | 'assistant',
  content: unknown[]
): void {
  db.prepare('insert into ai_messages (id, conversation_id, role, content) values (?, ?, ?, ?)').run(
    randomUUID(),
    conversationId,
    role,
    JSON.stringify(content)
  );
  db.prepare("update ai_conversations set updated_at = datetime('now') where id = ?").run(conversationId);
}

export function getMessages(db: Database.Database, conversationId: string): StoredMessage[] {
  const rows = db
    .prepare('select id, conversation_id, role, content, created_at from ai_messages where conversation_id = ? order by created_at')
    .all(conversationId) as Array<{ id: string; conversation_id: string; role: string; content: string; created_at: string }>;
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as 'user' | 'assistant',
    content: row.content,
    createdAt: row.created_at,
  }));
}

export function clearMessages(db: Database.Database, conversationId: string): void {
  db.prepare('delete from ai_messages where conversation_id = ?').run(conversationId);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test -- src/main/ai/conversation.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 7: Run the full check**

Run: `npm run typecheck && npm run test`
Expected: both exit 0. This also exercises `db/index.test.ts` from Phase 1, which calls `openDb()` end-to-end — confirm it still passes with the second migration now registered (it doesn't assert on `ai_conversations` specifically, just that `settings` exists, so it should be unaffected, but run it to be sure).

- [ ] **Step 8: Commit**

```bash
git add src/main/db/migrations/0002_ai_core.sql src/main/db/index.ts src/main/ai/conversation.ts src/main/ai/conversation.test.ts
git commit -m "Task 2: ai_conversations/ai_messages migration and conversation helpers"
```

---

### Task 3: Permission tier logic + ai_mode setting + Settings UI

**Files:**
- Create: `src/main/ai/permissions.ts`
- Test: `src/main/ai/permissions.test.ts`
- Create: `src/main/ai/mode.ts`
- Test: `src/main/ai/mode.test.ts`
- Modify: `src/main/ai/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/routes/Settings.tsx`
- Modify: `src/renderer/src/routes/Settings.test.tsx`
- Modify: `src/renderer/src/App.test.tsx`

**Interfaces:**
- Consumes: `settings` table; `registerAiIpcHandlers` from Task 1 (extended, not replaced).
- Produces: `ToolTier = 'READ' | 'SAFE_WRITE' | 'CONSEQUENTIAL'`, `AiMode = 'ask' | 'assist' | 'auto'`, `resolveExecutionMode(tier: ToolTier, mode: AiMode): 'auto' | 'pause'`, `gate(tier, mode, toolName, description, requestConfirmation): Promise<boolean>` from `src/main/ai/permissions.ts` — Task 4's tool `run()` functions call `gate` directly. `getAiMode(db): AiMode`, `setAiMode(db, mode: AiMode): void` from `src/main/ai/mode.ts` — Task 5's `chatController` calls `getAiMode` once per turn. `window.smartlife.ai.getMode(): Promise<AiMode>`, `window.smartlife.ai.setMode(mode: AiMode): Promise<void>`.

- [ ] **Step 1: Write the failing permission-tier tests**

`src/main/ai/permissions.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { resolveExecutionMode, gate } from './permissions';
import type { AiMode, ToolTier } from './permissions';

describe('resolveExecutionMode', () => {
  const cases: Array<[ToolTier, AiMode, 'auto' | 'pause']> = [
    ['READ', 'ask', 'auto'],
    ['READ', 'assist', 'auto'],
    ['READ', 'auto', 'auto'],
    ['SAFE_WRITE', 'ask', 'pause'],
    ['SAFE_WRITE', 'assist', 'auto'],
    ['SAFE_WRITE', 'auto', 'auto'],
    ['CONSEQUENTIAL', 'ask', 'pause'],
    ['CONSEQUENTIAL', 'assist', 'pause'],
    ['CONSEQUENTIAL', 'auto', 'auto'],
  ];

  it.each(cases)('tier=%s mode=%s -> %s', (tier, mode, expected) => {
    expect(resolveExecutionMode(tier, mode)).toBe(expected);
  });
});

describe('gate', () => {
  it('resolves true immediately without confirming when the tier auto-executes', async () => {
    const requestConfirmation = vi.fn();
    const approved = await gate('READ', 'ask', 'get_settings', 'Read settings', requestConfirmation);
    expect(approved).toBe(true);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('calls requestConfirmation and returns its result when the tier requires a pause', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(true);
    const approved = await gate('SAFE_WRITE', 'ask', 'set_theme', 'Set theme to dark', requestConfirmation);
    expect(approved).toBe(true);
    expect(requestConfirmation).toHaveBeenCalledWith('set_theme', 'Set theme to dark');
  });

  it('propagates a denial from requestConfirmation', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(false);
    const approved = await gate('CONSEQUENTIAL', 'assist', 'clear_conversation_history', 'Clear all history', requestConfirmation);
    expect(approved).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/main/ai/permissions.test.ts`
Expected: FAIL — `./permissions` doesn't exist yet.

- [ ] **Step 3: Implement `permissions.ts`**

```ts
export type ToolTier = 'READ' | 'SAFE_WRITE' | 'CONSEQUENTIAL';
export type AiMode = 'ask' | 'assist' | 'auto';

const PAUSE_TIERS: Record<AiMode, ToolTier[]> = {
  ask: ['SAFE_WRITE', 'CONSEQUENTIAL'],
  assist: ['CONSEQUENTIAL'],
  auto: [],
};

export function resolveExecutionMode(tier: ToolTier, mode: AiMode): 'auto' | 'pause' {
  return PAUSE_TIERS[mode].includes(tier) ? 'pause' : 'auto';
}

export async function gate(
  tier: ToolTier,
  mode: AiMode,
  toolName: string,
  description: string,
  requestConfirmation: (toolName: string, description: string) => Promise<boolean>
): Promise<boolean> {
  if (resolveExecutionMode(tier, mode) === 'auto') return true;
  return requestConfirmation(toolName, description);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/main/ai/permissions.test.ts`
Expected: PASS, 12/12 (9 `it.each` cases + 3 `gate` tests).

- [ ] **Step 5: Write the failing `ai_mode` setting tests**

`src/main/ai/mode.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getAiMode, setAiMode } from './mode';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null)');
  return db;
}

describe('ai_mode setting', () => {
  it('defaults to "ask" when unset', () => {
    const db = makeDb();
    expect(getAiMode(db)).toBe('ask');
  });

  it('round-trips a set value', () => {
    const db = makeDb();
    setAiMode(db, 'auto');
    expect(getAiMode(db)).toBe('auto');
  });

  it('falls back to "ask" for a corrupted stored value', () => {
    const db = makeDb();
    db.prepare('insert into settings (key, value) values (?, ?)').run('ai_mode', 'not-a-real-mode');
    expect(getAiMode(db)).toBe('ask');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm run test -- src/main/ai/mode.test.ts`
Expected: FAIL — `./mode` doesn't exist yet.

- [ ] **Step 7: Implement `mode.ts`**

```ts
import type Database from 'better-sqlite3';
import type { AiMode } from './permissions';

const VALID_MODES: AiMode[] = ['ask', 'assist', 'auto'];

export function getAiMode(db: Database.Database): AiMode {
  const row = db.prepare('select value from settings where key = ?').get('ai_mode') as { value: string } | undefined;
  if (row && VALID_MODES.includes(row.value as AiMode)) {
    return row.value as AiMode;
  }
  return 'ask';
}

export function setAiMode(db: Database.Database, mode: AiMode): void {
  db.prepare(
    'insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
  ).run('ai_mode', mode);
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm run test -- src/main/ai/mode.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 9: Extend `ai/ipc.ts` with mode handlers**

In `src/main/ai/ipc.ts`, add the import:

```ts
import { getAiMode, setAiMode } from './mode';
import type { AiMode } from './permissions';
```

Inside `registerAiIpcHandlers`, add these two lines right before the closing `void getWindow;` line (leave that line in place — `getWindow` is still unused by this task; Task 5 removes it once `ai:send-message` finally references `getWindow`):

```ts
  ipcMain.handle('ai:get-mode', () => getAiMode(db));
  ipcMain.handle('ai:set-mode', (_event, mode: AiMode) => {
    setAiMode(db, mode);
  });
```

- [ ] **Step 10: Extend the preload bridge**

In `src/preload/index.ts`, add to the `ai` object inside `smartlife`:

```ts
    getMode: (): Promise<'ask' | 'assist' | 'auto'> => ipcRenderer.invoke('ai:get-mode'),
    setMode: (mode: 'ask' | 'assist' | 'auto'): Promise<void> => ipcRenderer.invoke('ai:set-mode', mode),
```

- [ ] **Step 11: Add the mode selector to Settings**

In `src/renderer/src/routes/Settings.tsx`, add state and an effect alongside the API-key state added in Task 1:

```tsx
  const [aiMode, setAiModeState] = useState<'ask' | 'assist' | 'auto' | null>(null);

  useEffect(() => {
    window.smartlife.ai.getMode().then(setAiModeState);
  }, []);

  async function handleSetAiMode(mode: 'ask' | 'assist' | 'auto'): Promise<void> {
    setAiModeState(mode);
    await window.smartlife.ai.setMode(mode);
  }
```

Add this JSX block after the API key block from Task 1, before `<p>SmartLife v{version}</p>`:

```tsx
      <div className="flex flex-col gap-2">
        <span style={{ color: 'var(--color-text-muted)' }}>AI permission mode</span>
        <div className="flex gap-2">
          {(['ask', 'assist', 'auto'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => handleSetAiMode(mode)}
              className="rounded-md px-3 py-1.5 text-sm capitalize"
              style={{
                backgroundColor: aiMode === mode ? 'var(--color-text)' : 'var(--color-surface)',
                color: aiMode === mode ? 'var(--color-bg)' : 'var(--color-text)',
                border: '1px solid var(--color-border)',
              }}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>
```

- [ ] **Step 12: Update the Settings and App test mocks**

In `src/renderer/src/routes/Settings.test.tsx` and `src/renderer/src/App.test.tsx`, add to the `ai` object in the `window.smartlife` mock (alongside `getApiKeyStatus`/`setApiKey` from Task 1):

```ts
      getMode: vi.fn().mockResolvedValue('ask'),
      setMode: vi.fn().mockResolvedValue(undefined),
```

- [ ] **Step 13: Run the full check**

Run: `npm run typecheck && npm run lint && npm run test && npm run build`
Expected: all exit 0.

- [ ] **Step 14: Commit**

```bash
git add src/main/ai/permissions.ts src/main/ai/permissions.test.ts src/main/ai/mode.ts src/main/ai/mode.test.ts src/main/ai/ipc.ts src/preload/index.ts src/renderer/src/routes/Settings.tsx src/renderer/src/routes/Settings.test.tsx src/renderer/src/App.test.tsx
git commit -m "Task 3: permission-tier logic, ai_mode setting, and Settings UI"
```

---

### Task 4: Confirmation round-trip plumbing + the three tools

**Files:**
- Create: `src/main/ai/confirmations.ts`
- Test: `src/main/ai/confirmations.test.ts`
- Create: `src/main/ai/tools/types.ts`
- Create: `src/main/ai/tools/getSettings.ts`
- Test: `src/main/ai/tools/getSettings.test.ts`
- Create: `src/main/ai/tools/setTheme.ts`
- Test: `src/main/ai/tools/setTheme.test.ts`
- Create: `src/main/ai/tools/clearConversationHistory.ts`
- Test: `src/main/ai/tools/clearConversationHistory.test.ts`
- Create: `src/main/ai/tools/registry.ts`

**Interfaces:**
- Consumes: `gate` from Task 3's `permissions.ts`; `getThemePreference`/`setThemePreference` from Phase 1 Task 3's `src/main/ipc.ts`; `clearMessages` from Task 2's `conversation.ts`.
- Produces: `requestConfirmation(send, toolName, description): Promise<boolean>` and `resolveConfirmation(id, approved): void` from `confirmations.ts` — Task 5's `chatController` calls both (`requestConfirmation` is passed into `ToolContext`, `resolveConfirmation` is called from the `ai:confirm-response` IPC handler). `ToolContext`, `ToolSchema`, `ToolDefinition` types from `tools/types.ts`. `TOOLS: ToolDefinition[]` from `tools/registry.ts` — Task 5's `ClaudeProvider` passes each tool's `schema` to the Tool Runner and calls `run` on tool use.

- [ ] **Step 1: Write the failing confirmation-plumbing tests**

`src/main/ai/confirmations.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { requestConfirmation, resolveConfirmation } from './confirmations';

describe('confirmation round-trip', () => {
  it('resolves true when resolveConfirmation is called with approved=true', async () => {
    const sent: Array<{ id: string; toolName: string; description: string }> = [];
    const promise = requestConfirmation((payload) => sent.push(payload), 'set_theme', 'Set theme to dark');
    expect(sent).toHaveLength(1);
    expect(sent[0].toolName).toBe('set_theme');
    resolveConfirmation(sent[0].id, true);
    await expect(promise).resolves.toBe(true);
  });

  it('resolves false when resolveConfirmation is called with approved=false', async () => {
    const sent: Array<{ id: string; toolName: string; description: string }> = [];
    const promise = requestConfirmation((payload) => sent.push(payload), 'clear_conversation_history', 'Clear history');
    resolveConfirmation(sent[0].id, false);
    await expect(promise).resolves.toBe(false);
  });

  it('ignores resolveConfirmation for an unknown id without throwing', () => {
    expect(() => resolveConfirmation('unknown-id', true)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/main/ai/confirmations.test.ts`
Expected: FAIL — `./confirmations` doesn't exist yet.

- [ ] **Step 3: Implement `confirmations.ts`**

```ts
import { randomUUID } from 'node:crypto';

type PendingResolver = (approved: boolean) => void;

const pending = new Map<string, PendingResolver>();

export function requestConfirmation(
  send: (payload: { id: string; toolName: string; description: string }) => void,
  toolName: string,
  description: string
): Promise<boolean> {
  const id = randomUUID();
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, toolName, description });
  });
}

export function resolveConfirmation(id: string, approved: boolean): void {
  const resolver = pending.get(id);
  if (!resolver) return;
  pending.delete(id);
  resolver(approved);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/main/ai/confirmations.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Write the shared tool types**

`src/main/ai/tools/types.ts`:

```ts
import type Database from 'better-sqlite3';
import type { AiMode, ToolTier } from '../permissions';

export interface ToolContext {
  db: Database.Database;
  conversationId: string;
  mode: AiMode;
  requestConfirmation: (toolName: string, description: string) => Promise<boolean>;
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  tier: ToolTier;
  label: string;
  schema: ToolSchema;
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}
```

- [ ] **Step 6: Write the failing `get_settings` test**

`src/main/ai/tools/getSettings.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { getSettingsTool } from './getSettings';

vi.mock('electron', () => ({ app: { getVersion: () => '0.1.0' } }));

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null)');
  return db;
}

describe('get_settings tool', () => {
  it('returns the theme and version without ever requesting confirmation (READ tier)', async () => {
    const db = makeDb();
    const requestConfirmation = vi.fn();
    const result = await getSettingsTool.run({}, { db, conversationId: 'c1', mode: 'ask', requestConfirmation });
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(JSON.parse(result)).toEqual({ theme: 'system', version: '0.1.0' });
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm run test -- src/main/ai/tools/getSettings.test.ts`
Expected: FAIL — `./getSettings` doesn't exist yet.

- [ ] **Step 8: Implement `getSettings.ts`**

```ts
import { app } from 'electron';
import { getThemePreference } from '../../ipc';
import { gate } from '../permissions';
import type { ToolDefinition } from './types';

export const getSettingsTool: ToolDefinition = {
  name: 'get_settings',
  tier: 'READ',
  label: 'Reading settings',
  schema: {
    name: 'get_settings',
    description: 'Read the current app settings: theme preference and app version.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async run(_input, ctx) {
    const approved = await gate('READ', ctx.mode, 'get_settings', 'Read app settings', ctx.requestConfirmation);
    if (!approved) return 'User declined this action.';
    const theme = getThemePreference(ctx.db);
    return JSON.stringify({ theme, version: app.getVersion() });
  },
};
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npm run test -- src/main/ai/tools/getSettings.test.ts`
Expected: PASS, 1/1.

- [ ] **Step 10: Write the failing `set_theme` tests**

`src/main/ai/tools/setTheme.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { setThemeTool } from './setTheme';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null)');
  return db;
}

describe('set_theme tool', () => {
  it('sets the theme directly when the mode auto-executes SAFE_WRITE', async () => {
    const db = makeDb();
    const result = await setThemeTool.run(
      { theme: 'dark' },
      { db, conversationId: 'c1', mode: 'assist', requestConfirmation: vi.fn() }
    );
    expect(result).toBe('Theme set to "dark".');
    const row = db.prepare('select value from settings where key = ?').get('theme') as { value: string };
    expect(row.value).toBe('dark');
  });

  it('pauses for confirmation in ask mode and applies the change on approval', async () => {
    const db = makeDb();
    const requestConfirmation = vi.fn().mockResolvedValue(true);
    const result = await setThemeTool.run({ theme: 'light' }, { db, conversationId: 'c1', mode: 'ask', requestConfirmation });
    expect(requestConfirmation).toHaveBeenCalledWith('set_theme', 'Change theme to "light"');
    expect(result).toBe('Theme set to "light".');
  });

  it('does not apply the change when the user declines', async () => {
    const db = makeDb();
    const result = await setThemeTool.run(
      { theme: 'dark' },
      { db, conversationId: 'c1', mode: 'ask', requestConfirmation: vi.fn().mockResolvedValue(false) }
    );
    expect(result).toBe('User declined this action.');
    expect(db.prepare('select value from settings where key = ?').get('theme')).toBeUndefined();
  });

  it('rejects an invalid theme value without touching the database or asking for confirmation', async () => {
    const db = makeDb();
    const requestConfirmation = vi.fn();
    const result = await setThemeTool.run({ theme: 'rainbow' }, { db, conversationId: 'c1', mode: 'ask', requestConfirmation });
    expect(result).toContain('Invalid theme');
    expect(requestConfirmation).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 11: Run test to verify it fails**

Run: `npm run test -- src/main/ai/tools/setTheme.test.ts`
Expected: FAIL — `./setTheme` doesn't exist yet.

- [ ] **Step 12: Implement `setTheme.ts`**

```ts
import { setThemePreference } from '../../ipc';
import { gate } from '../permissions';
import type { ToolDefinition } from './types';

const VALID_THEMES = ['light', 'dark', 'system'] as const;
type Theme = (typeof VALID_THEMES)[number];

export const setThemeTool: ToolDefinition = {
  name: 'set_theme',
  tier: 'SAFE_WRITE',
  label: 'Changing theme',
  schema: {
    name: 'set_theme',
    description: 'Change the app theme preference.',
    input_schema: {
      type: 'object',
      properties: {
        theme: { type: 'string', enum: ['light', 'dark', 'system'], description: 'The theme to switch to.' },
      },
      required: ['theme'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const theme = input.theme as string;
    if (!VALID_THEMES.includes(theme as Theme)) {
      return `Invalid theme "${theme}". Must be one of: light, dark, system.`;
    }
    const approved = await gate('SAFE_WRITE', ctx.mode, 'set_theme', `Change theme to "${theme}"`, ctx.requestConfirmation);
    if (!approved) return 'User declined this action.';
    setThemePreference(ctx.db, theme as Theme);
    return `Theme set to "${theme}".`;
  },
};
```

- [ ] **Step 13: Run test to verify it passes**

Run: `npm run test -- src/main/ai/tools/setTheme.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 14: Write the failing `clear_conversation_history` tests**

`src/main/ai/tools/clearConversationHistory.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrate';
import { getOrCreateConversationId, appendMessage, getMessages } from '../conversation';
import { clearConversationHistoryTool } from './clearConversationHistory';

const AI_CORE_SQL = `
create table ai_conversations (
  id text primary key, title text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);
create table ai_messages (
  id text primary key,
  conversation_id text not null references ai_conversations(id) on delete cascade,
  role text not null, content text not null,
  created_at text not null default (datetime('now'))
);
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db, [{ filename: '0002_ai_core.sql', sql: AI_CORE_SQL }]);
  return db;
}

describe('clear_conversation_history tool', () => {
  it('pauses for confirmation (CONSEQUENTIAL) and clears history on approval', async () => {
    const db = makeDb();
    const conversationId = getOrCreateConversationId(db);
    appendMessage(db, conversationId, 'user', [{ type: 'text', text: 'hi' }]);
    const requestConfirmation = vi.fn().mockResolvedValue(true);
    const result = await clearConversationHistoryTool.run({}, { db, conversationId, mode: 'assist', requestConfirmation });
    expect(requestConfirmation).toHaveBeenCalled();
    expect(result).toBe('Conversation history cleared.');
    expect(getMessages(db, conversationId)).toHaveLength(0);
  });

  it('leaves history intact when the user declines', async () => {
    const db = makeDb();
    const conversationId = getOrCreateConversationId(db);
    appendMessage(db, conversationId, 'user', [{ type: 'text', text: 'hi' }]);
    const result = await clearConversationHistoryTool.run(
      {},
      { db, conversationId, mode: 'assist', requestConfirmation: vi.fn().mockResolvedValue(false) }
    );
    expect(result).toBe('User declined this action.');
    expect(getMessages(db, conversationId)).toHaveLength(1);
  });

  it('does not request confirmation in auto mode', async () => {
    const db = makeDb();
    const conversationId = getOrCreateConversationId(db);
    appendMessage(db, conversationId, 'user', [{ type: 'text', text: 'hi' }]);
    const requestConfirmation = vi.fn();
    const result = await clearConversationHistoryTool.run({}, { db, conversationId, mode: 'auto', requestConfirmation });
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(result).toBe('Conversation history cleared.');
  });
});
```

- [ ] **Step 15: Run test to verify it fails**

Run: `npm run test -- src/main/ai/tools/clearConversationHistory.test.ts`
Expected: FAIL — `./clearConversationHistory` doesn't exist yet.

- [ ] **Step 16: Implement `clearConversationHistory.ts`**

```ts
import { clearMessages } from '../conversation';
import { gate } from '../permissions';
import type { ToolDefinition } from './types';

export const clearConversationHistoryTool: ToolDefinition = {
  name: 'clear_conversation_history',
  tier: 'CONSEQUENTIAL',
  label: 'Clearing conversation history',
  schema: {
    name: 'clear_conversation_history',
    description: 'Permanently delete every message in the current conversation. This cannot be undone.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async run(_input, ctx) {
    const approved = await gate(
      'CONSEQUENTIAL',
      ctx.mode,
      'clear_conversation_history',
      'Permanently delete all conversation history. This cannot be undone.',
      ctx.requestConfirmation
    );
    if (!approved) return 'User declined this action.';
    clearMessages(ctx.db, ctx.conversationId);
    return 'Conversation history cleared.';
  },
};
```

- [ ] **Step 17: Run test to verify it passes**

Run: `npm run test -- src/main/ai/tools/clearConversationHistory.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 18: Write the tool registry**

`src/main/ai/tools/registry.ts`:

```ts
import type { ToolDefinition } from './types';
import { getSettingsTool } from './getSettings';
import { setThemeTool } from './setTheme';
import { clearConversationHistoryTool } from './clearConversationHistory';

export const TOOLS: ToolDefinition[] = [getSettingsTool, setThemeTool, clearConversationHistoryTool];
```

- [ ] **Step 19: Run the full check**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all exit 0.

- [ ] **Step 20: Commit**

```bash
git add src/main/ai/confirmations.ts src/main/ai/confirmations.test.ts src/main/ai/tools/
git commit -m "Task 4: confirmation round-trip plumbing and the three starter tools"
```

---

### Task 5: Claude provider, router, chat controller, and full IPC wiring

**Files:**
- Create: `src/main/ai/providers/types.ts`
- Create: `src/main/ai/providers/claude.ts`
- Create: `src/main/ai/router.ts`
- Create: `src/main/ai/chatController.ts`
- Test: `src/main/ai/chatController.test.ts`
- Modify: `src/main/ai/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: `getStoredApiKey` (Task 1), `getAiMode` (Task 3), `getOrCreateConversationId`/`appendMessage`/`getMessages` (Task 2), `requestConfirmation`/`resolveConfirmation` (Task 4), `TOOLS`/`ToolContext` (Task 4).
- Produces: `AIProvider`, `StreamEvent`, `TurnMessage` types from `providers/types.ts`. `claudeProvider: AIProvider` from `providers/claude.ts`. `getProvider(): AIProvider` from `router.ts`. `handleSendMessage(db, getWindow, userText, provider?): Promise<void>` from `chatController.ts` — this is the last task that needs a new main-process export; Task 6/7 only consume the renderer-side `window.smartlife.ai.*` bridge this task finishes wiring.

**A note on SDK surface uncertainty:** this task uses the Anthropic SDK's beta Tool Runner (`client.beta.messages.toolRunner`) and its raw-JSON-Schema helper (`betaTool` from `@anthropic-ai/sdk/helpers/beta/json-schema`). These are real, documented APIs, but exact parameter names on the *helper* functions (as opposed to the wire-level request fields, which are stable) can drift slightly between SDK versions. If a line below doesn't typecheck as written, open `node_modules/@anthropic-ai/sdk/helpers/beta/json-schema.d.ts` (and `.../beta/tool-runner.d.ts` if present) to find the exact exported signature and adjust the call to match — this is expected, not a sign the plan is wrong, and it's a compile-error-driven fix, not a research project.

- [ ] **Step 1: Write the provider types**

`src/main/ai/providers/types.ts`:

```ts
import type { ToolContext, ToolDefinition } from '../tools/types';

export interface StreamEvent {
  type: 'text-delta' | 'tool-status' | 'turn-complete';
  text?: string;
  toolName?: string;
  toolLabel?: string;
}

export interface TurnMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

export interface AIProvider {
  streamTurn(params: {
    apiKey: string;
    history: TurnMessage[];
    userText: string;
    tools: ToolDefinition[];
    ctx: ToolContext;
    onEvent: (event: StreamEvent) => void;
  }): Promise<unknown>; // resolves to the final assistant message's content blocks
}
```

- [ ] **Step 2: Implement the Claude provider**

`src/main/ai/providers/claude.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import type { ToolContext, ToolDefinition } from '../tools/types';
import type { AIProvider, StreamEvent } from './types';

const MODEL = 'claude-sonnet-5';

function toBetaTools(tools: ToolDefinition[], ctx: ToolContext) {
  return tools.map((tool) =>
    betaTool({
      name: tool.schema.name,
      description: tool.schema.description,
      inputSchema: tool.schema.input_schema,
      run: async (input: Record<string, unknown>) => tool.run(input, ctx),
    })
  );
}

export const claudeProvider: AIProvider = {
  async streamTurn({ apiKey, history, userText, tools, ctx, onEvent }) {
    const client = new Anthropic({ apiKey });
    const toolLabels = new Map(tools.map((tool) => [tool.schema.name, tool.label]));

    const messages = [...history, { role: 'user' as const, content: userText }];

    const runner = client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 4096,
      tools: toBetaTools(tools, ctx),
      messages,
      stream: true,
    });

    let finalContent: unknown = [{ type: 'text', text: '' }];

    for await (const messageStream of runner) {
      for await (const event of messageStream) {
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          const toolName = event.content_block.name;
          const toolLabel = toolLabels.get(toolName) ?? toolName;
          onEvent({ type: 'tool-status', toolName, toolLabel } satisfies StreamEvent);
        }
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          onEvent({ type: 'text-delta', text: event.delta.text } satisfies StreamEvent);
        }
      }
      const finalMessage = await messageStream.finalMessage();
      finalContent = finalMessage.content;
    }

    onEvent({ type: 'turn-complete' } satisfies StreamEvent);
    return finalContent;
  },
};
```

- [ ] **Step 3: Write the trivial router**

`src/main/ai/router.ts`:

```ts
import { claudeProvider } from './providers/claude';
import type { AIProvider } from './providers/types';

export function getProvider(): AIProvider {
  return claudeProvider;
}
```

- [ ] **Step 4: Write the failing `chatController` tests**

`src/main/ai/chatController.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { setStoredApiKey } from './apiKey';
import type { AIProvider } from './providers/types';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

const INIT_SQL = `create table settings (key text primary key, value text not null);`;
const AI_CORE_SQL = `
create table ai_conversations (id text primary key, title text, created_at text not null default (datetime('now')), updated_at text not null default (datetime('now')));
create table ai_messages (id text primary key, conversation_id text not null references ai_conversations(id) on delete cascade, role text not null, content text not null, created_at text not null default (datetime('now')));
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db, [
    { filename: '0001_init.sql', sql: INIT_SQL },
    { filename: '0002_ai_core.sql', sql: AI_CORE_SQL },
  ]);
  return db;
}

function fakeWindow() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return { sent, webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } };
}

describe('handleSendMessage', () => {
  it('shows a configuration prompt and never calls the provider when no API key is stored', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    const window = fakeWindow();
    const provider: AIProvider = { streamTurn: vi.fn() };
    await handleSendMessage(db, () => window as never, 'hello', provider);
    expect(provider.streamTurn).not.toHaveBeenCalled();
    expect(window.sent.some((s) => JSON.stringify(s.payload).includes('Settings'))).toBe(true);
  });

  it('persists the user message and the final assistant message on success', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const window = fakeWindow();
    const provider: AIProvider = { streamTurn: vi.fn().mockResolvedValue([{ type: 'text', text: 'Hi there!' }]) };
    await handleSendMessage(db, () => window as never, 'hello', provider);
    const rows = db.prepare('select role, content from ai_messages order by created_at').all() as Array<{
      role: string;
      content: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].role).toBe('user');
    expect(JSON.parse(rows[0].content)).toEqual([{ type: 'text', text: 'hello' }]);
    expect(rows[1].role).toBe('assistant');
    expect(JSON.parse(rows[1].content)).toEqual([{ type: 'text', text: 'Hi there!' }]);
  });

  it('does not persist anything and emits an error when the provider throws', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const window = fakeWindow();
    const provider: AIProvider = { streamTurn: vi.fn().mockRejectedValue(new Error('network down')) };
    await handleSendMessage(db, () => window as never, 'hello', provider);
    const count = db.prepare('select count(*) as count from ai_messages').get() as { count: number };
    expect(count.count).toBe(0);
    expect(window.sent.some((s) => JSON.stringify(s.payload).includes('went wrong'))).toBe(true);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npm run test -- src/main/ai/chatController.test.ts`
Expected: FAIL — `./chatController` doesn't exist yet.

- [ ] **Step 6: Implement `chatController.ts`**

```ts
import type { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { getStoredApiKey } from './apiKey';
import { getAiMode } from './mode';
import { getOrCreateConversationId, appendMessage, getMessages } from './conversation';
import { requestConfirmation as requestToolConfirmation } from './confirmations';
import { TOOLS } from './tools/registry';
import { getProvider } from './router';
import type { ToolContext } from './tools/types';
import type { AIProvider, StreamEvent } from './providers/types';

export async function handleSendMessage(
  db: Database.Database,
  getWindow: () => BrowserWindow | null,
  userText: string,
  provider: AIProvider = getProvider()
): Promise<void> {
  const send = (event: StreamEvent): void => getWindow()?.webContents.send('ai:stream-event', event);

  const apiKey = getStoredApiKey(db);
  if (!apiKey) {
    send({ type: 'text-delta', text: 'No API key configured — add one in Settings.' });
    send({ type: 'turn-complete' });
    return;
  }

  const conversationId = getOrCreateConversationId(db);
  const mode = getAiMode(db);
  const history = getMessages(db, conversationId).map((m) => ({
    role: m.role,
    content: JSON.parse(m.content) as unknown,
  }));

  const ctx: ToolContext = {
    db,
    conversationId,
    mode,
    requestConfirmation: (toolName, description) =>
      requestToolConfirmation((payload) => getWindow()?.webContents.send('ai:confirm-request', payload), toolName, description),
  };

  try {
    const finalContent = await provider.streamTurn({ apiKey, history, userText, tools: TOOLS, ctx, onEvent: send });
    appendMessage(db, conversationId, 'user', [{ type: 'text', text: userText }]);
    appendMessage(db, conversationId, 'assistant', finalContent as unknown[]);
  } catch (error) {
    console.error('AI turn failed:', error);
    send({ type: 'text-delta', text: 'Something went wrong — try again.' });
    send({ type: 'turn-complete' });
  }
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm run test -- src/main/ai/chatController.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 8: Finish wiring `ai/ipc.ts`**

Replace the entire contents of `src/main/ai/ipc.ts` with:

```ts
import { ipcMain, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { setStoredApiKey, hasStoredApiKey } from './apiKey';
import { getAiMode, setAiMode } from './mode';
import type { AiMode } from './permissions';
import { getOrCreateConversationId, getMessages } from './conversation';
import { resolveConfirmation } from './confirmations';
import { handleSendMessage } from './chatController';

export function registerAiIpcHandlers(db: Database.Database, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('ai:get-api-key-status', () => hasStoredApiKey(db));
  ipcMain.handle('ai:set-api-key', (_event, apiKey: string) => {
    setStoredApiKey(db, apiKey);
  });

  ipcMain.handle('ai:get-mode', () => getAiMode(db));
  ipcMain.handle('ai:set-mode', (_event, mode: AiMode) => {
    setAiMode(db, mode);
  });

  ipcMain.handle('ai:send-message', (_event, text: string) => handleSendMessage(db, getWindow, text));
  ipcMain.handle('ai:confirm-response', (_event, id: string, approved: boolean) => {
    resolveConfirmation(id, approved);
  });
  ipcMain.handle('ai:get-history', () => {
    const conversationId = getOrCreateConversationId(db);
    return getMessages(db, conversationId).map((m) => ({ role: m.role, content: JSON.parse(m.content) }));
  });
}
```

Note: `getStoredApiKey` (imported in Task 1's version of this file) is dropped from the import list here — it's only ever called from `chatController.ts` (Step 6, via its own import), never from `ipc.ts` directly, so keeping it here would be an unused import.

- [ ] **Step 9: Finish wiring the preload bridge**

Replace the entire contents of `src/preload/index.ts` with:

```ts
import { contextBridge, ipcRenderer } from 'electron';

interface StreamEvent {
  type: 'text-delta' | 'tool-status' | 'turn-complete';
  text?: string;
  toolName?: string;
  toolLabel?: string;
}

interface ConfirmRequest {
  id: string;
  toolName: string;
  description: string;
}

interface AiMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

const smartlife = {
  theme: {
    get: (): Promise<'light' | 'dark' | 'system'> => ipcRenderer.invoke('theme:get'),
    set: (value: 'light' | 'dark' | 'system'): Promise<void> => ipcRenderer.invoke('theme:set', value),
    onSystemChange: (cb: (isDark: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, isDark: boolean) => cb(isDark);
      ipcRenderer.on('theme:system-changed', listener);
      return () => ipcRenderer.removeListener('theme:system-changed', listener);
    },
  },
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  },
  navigation: {
    onNavigate: (cb: (path: string) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, path: string) => cb(path);
      ipcRenderer.on('navigate', listener);
      return () => ipcRenderer.removeListener('navigate', listener);
    },
  },
  ai: {
    getApiKeyStatus: (): Promise<boolean> => ipcRenderer.invoke('ai:get-api-key-status'),
    setApiKey: (apiKey: string): Promise<void> => ipcRenderer.invoke('ai:set-api-key', apiKey),
    getMode: (): Promise<'ask' | 'assist' | 'auto'> => ipcRenderer.invoke('ai:get-mode'),
    setMode: (mode: 'ask' | 'assist' | 'auto'): Promise<void> => ipcRenderer.invoke('ai:set-mode', mode),
    sendMessage: (text: string): Promise<void> => ipcRenderer.invoke('ai:send-message', text),
    onStreamEvent: (cb: (event: StreamEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, streamEvent: StreamEvent) => cb(streamEvent);
      ipcRenderer.on('ai:stream-event', listener);
      return () => ipcRenderer.removeListener('ai:stream-event', listener);
    },
    onConfirmRequest: (cb: (req: ConfirmRequest) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, req: ConfirmRequest) => cb(req);
      ipcRenderer.on('ai:confirm-request', listener);
      return () => ipcRenderer.removeListener('ai:confirm-request', listener);
    },
    respondToConfirm: (id: string, approved: boolean): Promise<void> => ipcRenderer.invoke('ai:confirm-response', id, approved),
    getHistory: (): Promise<AiMessage[]> => ipcRenderer.invoke('ai:get-history'),
  },
};

contextBridge.exposeInMainWorld('smartlife', smartlife);

export type SmartlifeApi = typeof smartlife;
```

- [ ] **Step 10: Run the full check**

Run: `npm run typecheck && npm run lint && npm run test && npm run build`
Expected: all exit 0. Do **not** run `npm run dev` and send a real chat message in this task — there's no real API key available in the plan-execution environment, and Step 4's tests already cover `chatController`'s logic without touching the network. Live end-to-end verification (a real streamed response) happens once the user adds their own key, after this whole plan is implemented.

- [ ] **Step 11: Commit**

```bash
git add src/main/ai/providers/ src/main/ai/router.ts src/main/ai/chatController.ts src/main/ai/chatController.test.ts src/main/ai/ipc.ts src/preload/index.ts
git commit -m "Task 5: Claude provider, router, chat controller, and full IPC wiring"
```

---

### Task 6: Renderer chat hook and the AI nav section

**Files:**
- Create: `src/renderer/src/ai/useConversation.ts`
- Modify: `src/renderer/src/routes/AI.tsx` (replaces the `ComingSoon` placeholder Phase 1 rendered for this route)
- Test: `src/renderer/src/routes/AI.test.tsx`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `window.smartlife.ai.*` from Task 5.
- Produces: `useConversation()` hook (`{ messages, statusLabel, pendingConfirm, sending, sendMessage, respondToConfirm }`) from `src/renderer/src/ai/useConversation.ts` — Task 7's `AIOverlay` imports and uses this same hook, so both surfaces share state derived from the same IPC calls (not a shared React context — each surface's own hook instance independently loads history and subscribes to the same main-process events, which is correct because the main process is the single source of truth here, not the renderer).

- [ ] **Step 1: Write the conversation hook**

`src/renderer/src/ai/useConversation.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface PendingConfirm {
  id: string;
  toolName: string;
  description: string;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text: string } => {
      return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text';
    })
    .map((block) => block.text)
    .join('');
}

export function useConversation() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [sending, setSending] = useState(false);
  const streamingIdRef = useRef<string | null>(null);

  useEffect(() => {
    window.smartlife.ai.getHistory().then((history) => {
      setMessages(history.map((m, index) => ({ id: `history-${index}`, role: m.role, text: extractText(m.content) })));
    });
  }, []);

  useEffect(() => {
    const unsubscribeStream = window.smartlife.ai.onStreamEvent((event) => {
      if (event.type === 'text-delta') {
        setStatusLabel(null);
        setMessages((prev) => {
          if (streamingIdRef.current) {
            return prev.map((m) => (m.id === streamingIdRef.current ? { ...m, text: m.text + (event.text ?? '') } : m));
          }
          const id = `assistant-${Date.now()}-${Math.random()}`;
          streamingIdRef.current = id;
          return [...prev, { id, role: 'assistant', text: event.text ?? '' }];
        });
      } else if (event.type === 'tool-status') {
        setStatusLabel(event.toolLabel ?? null);
      } else if (event.type === 'turn-complete') {
        setStatusLabel(null);
        streamingIdRef.current = null;
        setSending(false);
      }
    });

    const unsubscribeConfirm = window.smartlife.ai.onConfirmRequest((req) => {
      setPendingConfirm(req);
    });

    return () => {
      unsubscribeStream();
      unsubscribeConfirm();
    };
  }, []);

  const sendMessage = useCallback((text: string) => {
    const id = `user-${Date.now()}-${Math.random()}`;
    setMessages((prev) => [...prev, { id, role: 'user', text }]);
    setSending(true);
    streamingIdRef.current = null;
    window.smartlife.ai.sendMessage(text);
  }, []);

  const respondToConfirm = useCallback(
    async (approved: boolean) => {
      if (!pendingConfirm) return;
      await window.smartlife.ai.respondToConfirm(pendingConfirm.id, approved);
      setPendingConfirm(null);
    },
    [pendingConfirm]
  );

  return { messages, statusLabel, pendingConfirm, sending, sendMessage, respondToConfirm };
}
```

- [ ] **Step 2: Write the failing AI chat view test**

`src/renderer/src/routes/AI.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AI } from './AI';

type StreamCb = (event: { type: string; text?: string; toolLabel?: string }) => void;
type ConfirmCb = (req: { id: string; toolName: string; description: string }) => void;

function mockAi() {
  let streamCb: StreamCb | null = null;
  let confirmCb: ConfirmCb | null = null;
  return {
    getHistory: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockImplementation(() => {
      queueMicrotask(() => {
        streamCb?.({ type: 'text-delta', text: 'Hello ' });
        streamCb?.({ type: 'text-delta', text: 'there!' });
        streamCb?.({ type: 'turn-complete' });
      });
      return Promise.resolve();
    }),
    onStreamEvent: vi.fn((cb: StreamCb) => {
      streamCb = cb;
      return () => {
        streamCb = null;
      };
    }),
    onConfirmRequest: vi.fn((cb: ConfirmCb) => {
      confirmCb = cb;
      return () => {
        confirmCb = null;
      };
    }),
    respondToConfirm: vi.fn().mockResolvedValue(undefined),
    triggerConfirm: (req: { id: string; toolName: string; description: string }) => confirmCb?.(req),
  };
}

beforeEach(() => {
  (window as unknown as { smartlife: { ai: ReturnType<typeof mockAi> } }).smartlife = { ai: mockAi() };
});

describe('AI chat view', () => {
  it('sends a message and renders the streamed assistant reply', async () => {
    render(<AI />);
    const input = await screen.findByPlaceholderText('Ask SmartLife…');
    await userEvent.type(input, 'hi there');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    const ai = (window as unknown as { smartlife: { ai: ReturnType<typeof mockAi> } }).smartlife.ai;
    expect(ai.sendMessage).toHaveBeenCalledWith('hi there');
    expect(await screen.findByText('hi there')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Hello there!')).toBeInTheDocument());
  });

  it('shows a confirmation card and calls respondToConfirm on approve', async () => {
    render(<AI />);
    const ai = (window as unknown as { smartlife: { ai: ReturnType<typeof mockAi> } }).smartlife.ai;
    ai.triggerConfirm({ id: 'conf-1', toolName: 'set_theme', description: 'Change theme to "dark"' });

    expect(await screen.findByText('Change theme to "dark"')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(ai.respondToConfirm).toHaveBeenCalledWith('conf-1', true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -- src/renderer/src/routes/AI.test.tsx`
Expected: FAIL — `AI` still renders `ComingSoon` content (Phase 1 Task 6's placeholder), no `Ask SmartLife…` placeholder text found.

- [ ] **Step 4: Implement the AI chat view**

`src/renderer/src/routes/AI.tsx` (replaces its Phase 1 route mapping — see Step 5):

```tsx
import { useState, type FormEvent } from 'react';
import { useConversation } from '../ai/useConversation';

export function AI() {
  const { messages, statusLabel, pendingConfirm, sending, sendMessage, respondToConfirm } = useConversation();
  const [input, setInput] = useState('');

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!input.trim() || sending) return;
    sendMessage(input.trim());
    setInput('');
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col gap-3 overflow-auto p-6">
        {messages.map((message) => (
          <div
            key={message.id}
            style={{
              alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '70%',
              padding: '8px 12px',
              borderRadius: 8,
              whiteSpace: 'pre-wrap',
              backgroundColor: message.role === 'user' ? '#22D3EE' : 'var(--color-surface)',
              color: message.role === 'user' ? '#ffffff' : 'var(--color-text)',
              border: message.role === 'assistant' ? '1px solid var(--color-border)' : undefined,
            }}
          >
            {message.text}
          </div>
        ))}
        {statusLabel && <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>{statusLabel}…</div>}
        {pendingConfirm && (
          <div
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              padding: 12,
              backgroundColor: 'var(--color-surface)',
            }}
          >
            <p style={{ color: 'var(--color-text)', marginBottom: 8 }}>{pendingConfirm.description}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => respondToConfirm(true)}
                className="rounded-md px-3 py-1.5 text-sm"
                style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => respondToConfirm(false)}
                className="rounded-md px-3 py-1.5 text-sm"
                style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
              >
                Deny
              </button>
            </div>
          </div>
        )}
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2 p-4" style={{ borderTop: '1px solid var(--color-border)' }}>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
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
    </div>
  );
}
```

- [ ] **Step 5: Wire the `/ai` route in `App.tsx`**

In `src/renderer/src/App.tsx`, add the import:

```ts
import { AI } from './routes/AI';
```

Change the `<Routes>` block: add `<Route path="/ai" element={<AI />} />` alongside the existing `/` and `/settings` routes, and change the `NAV_SECTIONS.filter(...)` line that generates the `ComingSoon` routes from:

```tsx
          {NAV_SECTIONS.filter((section) => section.path !== '/' && section.path !== '/settings').map((section) => (
```

to:

```tsx
          {NAV_SECTIONS.filter((section) => section.path !== '/' && section.path !== '/settings' && section.path !== '/ai').map((section) => (
```

- [ ] **Step 6: Update `App.test.tsx`'s mock to support the AI route**

`App.test.tsx`'s existing test navigates to "Tasks" to check a `ComingSoon` route still works — that's unaffected. But its `window.smartlife` mock now needs the fuller `ai` shape (`getHistory`, `sendMessage`, `onStreamEvent`, `onConfirmRequest`, `respondToConfirm`) or a click into `/ai` from this test suite would throw. Add these to the existing `ai` object in `App.test.tsx`'s mock (alongside `getApiKeyStatus`/`setApiKey`/`getMode`/`setMode` from Tasks 1 and 3):

```ts
      getHistory: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onStreamEvent: vi.fn(() => () => {}),
      onConfirmRequest: vi.fn(() => () => {}),
      respondToConfirm: vi.fn().mockResolvedValue(undefined),
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm run test -- src/renderer/src/routes/AI.test.tsx`
Expected: PASS, 2/2.

- [ ] **Step 8: Run the full check**

Run: `npm run typecheck && npm run lint && npm run test && npm run build`
Expected: all exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/ai/ src/renderer/src/routes/AI.tsx src/renderer/src/routes/AI.test.tsx src/renderer/src/App.tsx src/renderer/src/App.test.tsx
git commit -m "Task 6: conversation hook and the AI nav section chat view"
```

---

### Task 7: Shared ChatPanel, global overlay (Cmd+J), command palette (Cmd+K)

**Files:**
- Create: `src/renderer/src/ai/ChatPanel.tsx`
- Modify: `src/renderer/src/routes/AI.tsx` (extract its JSX into `ChatPanel`)
- Create: `src/renderer/src/ai/AIOverlay.tsx`
- Create: `src/renderer/src/command-palette/CommandPalette.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/App.test.tsx`

**Interfaces:**
- Consumes: `useConversation()` from Task 6 (`ChatMessage`, `PendingConfirm` types); `NAV_SECTIONS` from Phase 1 Task 6's `nav/sections.ts`; `useTheme()` from Phase 1 Task 5's `ThemeProvider`.
- Produces: `ChatPanel` (presentational component, props-driven — both `AI.tsx` and `AIOverlay.tsx` call `useConversation()` themselves and pass its return value down, so there are two independent hook instances, not shared React state; that's correct because the main process is the actual source of truth). `AIOverlay({ onClose })`. `CommandPalette({ onClose, onOpenAI })`. Nothing here is consumed by a later task — this is the last content task before packaging.

- [ ] **Step 1: Extract `ChatPanel` from `AI.tsx`**

`src/renderer/src/ai/ChatPanel.tsx` — this is `AI.tsx`'s current JSX (from Task 6), turned into a props-driven component:

```tsx
import type { FormEvent } from 'react';
import type { ChatMessage, PendingConfirm } from './useConversation';

export interface ChatPanelProps {
  messages: ChatMessage[];
  statusLabel: string | null;
  pendingConfirm: PendingConfirm | null;
  sending: boolean;
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onRespondToConfirm: (approved: boolean) => void;
}

export function ChatPanel({
  messages,
  statusLabel,
  pendingConfirm,
  sending,
  input,
  onInputChange,
  onSubmit,
  onRespondToConfirm,
}: ChatPanelProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col gap-3 overflow-auto p-6">
        {messages.map((message) => (
          <div
            key={message.id}
            style={{
              alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '70%',
              padding: '8px 12px',
              borderRadius: 8,
              whiteSpace: 'pre-wrap',
              backgroundColor: message.role === 'user' ? '#22D3EE' : 'var(--color-surface)',
              color: message.role === 'user' ? '#ffffff' : 'var(--color-text)',
              border: message.role === 'assistant' ? '1px solid var(--color-border)' : undefined,
            }}
          >
            {message.text}
          </div>
        ))}
        {statusLabel && <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>{statusLabel}…</div>}
        {pendingConfirm && (
          <div
            style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: 12, backgroundColor: 'var(--color-surface)' }}
          >
            <p style={{ color: 'var(--color-text)', marginBottom: 8 }}>{pendingConfirm.description}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onRespondToConfirm(true)}
                className="rounded-md px-3 py-1.5 text-sm"
                style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => onRespondToConfirm(false)}
                className="rounded-md px-3 py-1.5 text-sm"
                style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
              >
                Deny
              </button>
            </div>
          </div>
        )}
      </div>
      <form onSubmit={onSubmit} className="flex gap-2 p-4" style={{ borderTop: '1px solid var(--color-border)' }}>
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
    </div>
  );
}
```

- [ ] **Step 2: Shrink `AI.tsx` to use `ChatPanel`**

Replace the entire contents of `src/renderer/src/routes/AI.tsx` with:

```tsx
import { useState, type FormEvent } from 'react';
import { useConversation } from '../ai/useConversation';
import { ChatPanel } from '../ai/ChatPanel';

export function AI() {
  const conversation = useConversation();
  const [input, setInput] = useState('');

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!input.trim() || conversation.sending) return;
    conversation.sendMessage(input.trim());
    setInput('');
  }

  return (
    <ChatPanel
      messages={conversation.messages}
      statusLabel={conversation.statusLabel}
      pendingConfirm={conversation.pendingConfirm}
      sending={conversation.sending}
      input={input}
      onInputChange={setInput}
      onSubmit={handleSubmit}
      onRespondToConfirm={conversation.respondToConfirm}
    />
  );
}
```

- [ ] **Step 3: Run `AI.test.tsx` to confirm the refactor didn't break it**

Run: `npm run test -- src/renderer/src/routes/AI.test.tsx`
Expected: PASS, 2/2 — the tests from Task 6 assert on rendered text/roles, not on `AI.tsx`'s internal structure, so this refactor should be transparent to them.

- [ ] **Step 4: Write the AI overlay**

`src/renderer/src/ai/AIOverlay.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useConversation } from './useConversation';
import { ChatPanel } from './ChatPanel';

export function AIOverlay({ onClose }: { onClose: () => void }) {
  const conversation = useConversation();
  const [input, setInput] = useState('');

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!input.trim() || conversation.sending) return;
    conversation.sendMessage(input.trim());
    setInput('');
  }

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div
        role="dialog"
        aria-label="Ask AI"
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 480,
          height: 560,
          backgroundColor: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        <ChatPanel
          messages={conversation.messages}
          statusLabel={conversation.statusLabel}
          pendingConfirm={conversation.pendingConfirm}
          sending={conversation.sending}
          input={input}
          onInputChange={setInput}
          onSubmit={handleSubmit}
          onRespondToConfirm={conversation.respondToConfirm}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Write the command palette**

`src/renderer/src/command-palette/CommandPalette.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NAV_SECTIONS } from '../nav/sections';
import { useTheme } from '../theme/ThemeProvider';

interface PaletteAction {
  id: string;
  label: string;
  run: () => void;
}

const THEME_ORDER = ['light', 'dark', 'system'] as const;

export function CommandPalette({ onClose, onOpenAI }: { onClose: () => void; onOpenAI: () => void }) {
  const navigate = useNavigate();
  const { preference, setPreference } = useTheme();
  const [query, setQuery] = useState('');

  const actions: PaletteAction[] = useMemo(() => {
    const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(preference) + 1) % THEME_ORDER.length];
    const sectionActions = NAV_SECTIONS.map((section) => ({
      id: `nav-${section.slug}`,
      label: `Go to ${section.label}`,
      run: () => navigate(section.path),
    }));
    return [
      { id: 'ask-ai', label: 'Ask AI', run: onOpenAI },
      { id: 'toggle-theme', label: `Switch theme to ${nextTheme}`, run: () => setPreference(nextTheme) },
      ...sectionActions,
    ];
  }, [navigate, onOpenAI, preference, setPreference]);

  const filtered = actions.filter((action) => action.label.toLowerCase().includes(query.toLowerCase()));

  function runAndClose(action: PaletteAction): void {
    action.run();
    onClose();
  }

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        justifyContent: 'center',
        paddingTop: 120,
        zIndex: 50,
      }}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 480,
          maxHeight: 360,
          backgroundColor: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Type a command…"
          className="px-4 py-3 text-sm"
          style={{
            backgroundColor: 'transparent',
            color: 'var(--color-text)',
            border: 'none',
            borderBottom: '1px solid var(--color-border)',
            outline: 'none',
          }}
        />
        <div style={{ overflow: 'auto' }}>
          {filtered.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={() => runAndClose(action)}
              className="w-full px-4 py-2 text-left text-sm"
              style={{ backgroundColor: 'transparent', color: 'var(--color-text)', border: 'none' }}
            >
              {action.label}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="px-4 py-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>
              No matching commands.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Wire keyboard shortcuts and both overlays into `App.tsx`**

In `src/renderer/src/App.tsx`, change the React import line from:

```ts
import { useEffect } from 'react';
```

to:

```ts
import { useEffect, useState } from 'react';
```

Add these imports alongside the existing ones:

```ts
import { AIOverlay } from './ai/AIOverlay';
import { CommandPalette } from './command-palette/CommandPalette';
```

Inside the `Shell` component, add this state and effect before the `return`:

```tsx
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.metaKey && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setOverlayOpen((open) => !open);
      } else if (event.metaKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (event.key === 'Escape') {
        setOverlayOpen(false);
        setPaletteOpen(false);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
```

Change the `Shell` component's returned JSX from:

```tsx
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <NavigationBridge />
        <Routes>
          ...
        </Routes>
      </main>
    </div>
```

to (only the closing structure changes — keep the existing `<Sidebar />`, `<NavigationBridge />`, and `<Routes>...</Routes>` exactly as they are, just add the two conditional overlays as siblings of `<main>`):

```tsx
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <NavigationBridge />
        <Routes>
          {/* ...unchanged... */}
        </Routes>
      </main>
      {overlayOpen && <AIOverlay onClose={() => setOverlayOpen(false)} />}
      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onOpenAI={() => {
            setPaletteOpen(false);
            setOverlayOpen(true);
          }}
        />
      )}
    </div>
```

- [ ] **Step 7: Write the failing keyboard-shortcut tests**

Add to `src/renderer/src/App.test.tsx`, inside the existing `describe('App', ...)` block:

```tsx
  it('opens the AI overlay with Cmd+J and closes it with Escape', async () => {
    render(<App />);
    await screen.findByText(/good (morning|afternoon|evening)/i);

    await userEvent.keyboard('{Meta>}j{/Meta}');
    expect(await screen.findByRole('dialog', { name: 'Ask AI' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask AI' })).not.toBeInTheDocument());
  });

  it('opens the command palette with Cmd+K and jumps to a section', async () => {
    render(<App />);
    await screen.findByText(/good (morning|afternoon|evening)/i);

    await userEvent.keyboard('{Meta>}k{/Meta}');
    const input = await screen.findByPlaceholderText('Type a command…');
    await userEvent.type(input, 'Tasks');
    await userEvent.click(screen.getByRole('button', { name: 'Go to Tasks' }));

    expect(await screen.findByText('Coming in a later phase.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
  });
```

`waitFor` needs to be imported in `App.test.tsx` if it isn't already — check the existing import line from `@testing-library/react` and add it if missing:

```ts
import { render, screen, waitFor } from '@testing-library/react';
```

- [ ] **Step 8: Run test to verify it passes**

Step 6 (wiring `App.tsx`) already landed before these tests were written, so there is no separate RED run for this pair — `ChatPanel`/`AIOverlay`/`CommandPalette` are new files exercised through `AI.test.tsx` and `App.test.tsx` rather than their own dedicated test files, and the TDD discipline for their *logic* was already applied in Tasks 6 and 7's earlier steps (the `ChatPanel` extraction is a pure refactor verified by Step 3's re-run, not new behavior). This step is the real verification.

Run: `npm run test -- src/renderer/src/App.test.tsx`
Expected: PASS, all tests in this file (the 2 from Phase 1 Task 6 + the 2 new ones here).

- [ ] **Step 10: Run the full check**

Run: `npm run typecheck && npm run lint && npm run test && npm run build`
Expected: all exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/renderer/src/ai/ src/renderer/src/routes/AI.tsx src/renderer/src/command-palette/ src/renderer/src/App.tsx src/renderer/src/App.test.tsx
git commit -m "Task 7: shared ChatPanel, AI overlay (Cmd+J), and command palette (Cmd+K)"
```

---

### Task 8: Packaging and final verification

**Files:**
- No new files — this task packages and verifies everything from Tasks 1-7 together, same shape as Phase 1's closing task.

**Interfaces:**
- Consumes: everything. Produces: nothing further — this is the last task in the plan.

- [ ] **Step 1: Run the complete pipeline**

Run: `npm run lint && npm run typecheck && npm run test && npm run build`
Expected: every command exits 0. Note the total test count in the final `npm run test` output for the task report — expect roughly 20 (Phase 1's baseline) plus everything added in Tasks 1-7 (API key storage, conversation helpers, permission tiers, confirmations, three tools, chatController, Settings additions, AI chat view, App keyboard shortcuts).

- [ ] **Step 2: Package the app**

Run: `npm run package`
Expected: exits 0.

- [ ] **Step 3: Verify the packaged app artifact exists**

Run: `find release -maxdepth 3 -name "SmartLife.app"`
Expected: prints one path.

- [ ] **Step 4: Confirm the packaged app's entry points**

Run: `ls out/main/index.js out/preload/index.js out/renderer/index.html`
Expected: all three exist.

- [ ] **Step 5: Confirm no secrets are anywhere they shouldn't be**

Run: `git log --all -p -- '*.ts' '*.tsx' | grep -i "sk-ant-" | grep -v "sk-ant-test"`
Expected: no output. This is a real check, not a formality — Task 1's tests use literal strings like `'sk-ant-test-key'`, which is fine (never a real key), but this confirms nothing that looks like a genuine Anthropic key ever got committed. If this finds something, stop and report it rather than proceeding — do not attempt to rewrite git history yourself.

- [ ] **Step 6: Commit if `npm run package` produced any tracked file changes**

Run: `git status`
Expected: `release/` and `out/` are untracked/ignored, matching Phase 1. Nothing to commit for this task if clean.

---

## After this plan

Once all 8 tasks are reviewed and approved, the controller does a real visual pass the same way as Phase 1: launch the packaged app, click into the AI section, confirm the "no API key" empty state renders correctly (no key will be configured yet in a fresh build), open the Cmd+J overlay and Cmd+K palette, and confirm the permission-mode buttons in Settings work. **Genuine end-to-end verification of a real streamed Claude response requires a real API key entered into Settings** — that's a live network call this plan's automated tests deliberately don't make (see Task 5's note). Whether to do that live check now (the user already has a key ready, mentioned earlier in this project) or leave it for the user to enter themselves is a call for whoever is running this plan to make with the user in the moment, not something to decide unilaterally mid-implementation.

Update `../../../ROADMAP.md`'s status checklist once Phase 2 ships, and move on to brainstorming Phase 3 (Canvas) when the user is ready.
