# SmartLife Phase 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A launchable `SmartLife.app` — Electron shell, ported design system, persistent 11-section nav, a local SQLite database with migrations, and secure IPC — with nothing in it yet that talks to a network.

**Architecture:** Electron's three-process model scaffolded via `electron-vite` (Vite for main/preload/renderer, real HMR). Main process owns the one `BrowserWindow`, the `better-sqlite3` connection, and all `ipcMain` handlers. Preload exposes a narrow typed `window.smartlife` API via `contextBridge`. Renderer is React 19 + TypeScript + Tailwind v4, routed with `react-router-dom`'s `MemoryRouter`, no Node access.

**Tech Stack:** Electron, electron-vite, electron-builder, React 19, TypeScript, Tailwind CSS v4, react-router-dom v6, framer-motion, better-sqlite3, vitest, @testing-library/react.

See `../../../ROADMAP.md` for how this phase fits the full 9-phase plan and `../specs/2026-08-17-smartlife-phase1-foundation-design.md` for the approved design this plan implements.

## Global Constraints

- macOS only — no Windows/Linux build target in `electron-builder.yml`.
- No network request anywhere in this phase's code.
- No dependency beyond: `electron`, `electron-vite`, `electron-builder`, `react`, `react-dom`, `react-router-dom`, `framer-motion`, `better-sqlite3`, `tailwindcss` v4 (+ `@tailwindcss/vite`), plus dev tooling (`vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, `eslint`, `typescript-eslint`, `typescript`, `@vitejs/plugin-react`, `jsdom`, `vite`). Anything else needed gets flagged to the user, not silently added.
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` on every `BrowserWindow` created, in this phase and every future one.
- Content-Security-Policy is set from the main process via `session.defaultSession.webRequest.onHeadersReceived`, never a static `<meta>` tag (a static tag would also gate the Vite dev server's own HMR client and break it). Production policy: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`.
- No AI, no Canvas, no Google, no embedded browser, no tasks/notes/goals/files data model, no universal search, no command palette in this phase. 9 of the 11 nav sections render a placeholder only.

---

### Task 1: Project scaffold and minimal boot

**Files:**
- Create: `package.json`
- Create: `electron.vite.config.ts`
- Create: `electron-builder.yml`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `tsconfig.web.json`
- Create: `vitest.config.ts`
- Create: `vitest.setup.ts`
- Create: `eslint.config.mjs`
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/preload/index.d.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/src/main.tsx`
- Create: `src/renderer/src/App.tsx`
- Create: `src/renderer/src/env.d.ts`

**Interfaces:**
- Produces: a launchable (but empty) Electron window; `npm run dev`, `npm run build`, `npm run test`, `npm run lint`, `npm run typecheck` all work from this task on. Every later task's `npm run typecheck`/`npm run test` depends on this task's config files being correct.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "smartlife",
  "version": "0.1.0",
  "private": true,
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "package": "electron-vite build && electron-builder",
    "test": "vitest run",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json"
  },
  "dependencies": {
    "better-sqlite3": "^11.5.0",
    "framer-motion": "^11.11.17",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.16.0",
    "@tailwindcss/vite": "^4.0.0",
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.0.1",
    "@testing-library/user-event": "^14.5.2",
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.10.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "electron": "^33.2.0",
    "electron-builder": "^25.1.8",
    "electron-vite": "^2.3.0",
    "eslint": "^9.16.0",
    "eslint-plugin-react-hooks": "^5.0.0",
    "jsdom": "^25.0.1",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.2",
    "typescript-eslint": "^8.18.0",
    "vite": "^5.4.11",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: completes with no errors. `better-sqlite3` compiles its native module during install — if this fails, `npm rebuild better-sqlite3` after checking Xcode Command Line Tools are installed (`xcode-select -p`).

- [ ] **Step 3: Write the TypeScript project references**

`tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
```

`tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["node", "vite/client"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src/main/**/*", "src/preload/**/*"]
}
```

`tsconfig.web.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src/renderer/src/**/*", "src/preload/index.d.ts"]
}
```

- [ ] **Step 4: Write `electron.vite.config.ts`**

```ts
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
```

- [ ] **Step 5: Write `electron-builder.yml`**

```yaml
appId: com.smartlife.app
productName: SmartLife
directories:
  output: release
  buildResources: build
files:
  - out/**/*
  - package.json
mac:
  category: public.app-category.productivity
  target:
    - target: dir
```

- [ ] **Step 6: Write the minimal main process**

`src/main/index.ts`:

```ts
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
```

This is deliberately minimal — no DB, no IPC, no menu, no single-instance lock yet. Task 4 replaces this file with the full version. Getting a window on screen first, before any of that, keeps this task's own verification trivial.

- [ ] **Step 7: Write the empty preload bridge**

`src/preload/index.ts`:

```ts
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('smartlife', {});
```

`src/preload/index.d.ts`:

```ts
export {};

declare global {
  interface Window {
    smartlife: Record<string, never>;
  }
}
```

Task 3 replaces both files with the real typed bridge.

- [ ] **Step 8: Write the renderer entry**

`src/renderer/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SmartLife</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/renderer/src/App.tsx`:

```tsx
export function App() {
  return <div style={{ padding: 24, fontFamily: 'sans-serif' }}>SmartLife</div>;
}
```

`src/renderer/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

`src/renderer/src/env.d.ts`:

```ts
/// <reference types="vite/client" />
```

- [ ] **Step 9: Write the test and lint config**

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

`vitest.setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

`eslint.config.mjs`:

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['out/**', 'release/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  }
);
```

- [ ] **Step 10: Verify typecheck, lint, and build all pass**

Run: `npm run typecheck`
Expected: exits 0, no errors.

Run: `npm run lint`
Expected: exits 0, no errors.

Run: `npm run build`
Expected: exits 0, produces `out/main/index.js`, `out/preload/index.js`, `out/renderer/index.html`.

- [ ] **Step 11: Manually verify the window launches**

Run: `npm run dev` in the background, wait ~5 seconds, then check the process is still running (`electron-vite dev` does not exit on its own — that's expected, it's a long-running dev server). Kill it once confirmed running without a crash in its output. A crash-free start with no error output is sufficient for this task; visual confirmation of "SmartLife" on screen happens once the controller does a full visual pass after Task 7.

- [ ] **Step 12: Commit**

```bash
git add package.json electron.vite.config.ts electron-builder.yml tsconfig*.json vitest.config.ts vitest.setup.ts eslint.config.mjs src/
git commit -m "Task 1: project scaffold and minimal boot"
```

---

### Task 2: Local database — migrations and settings table

**Files:**
- Create: `src/main/db/migrate.ts`
- Test: `src/main/db/migrate.test.ts`
- Create: `src/main/db/migrations/0001_init.sql`
- Create: `src/main/db/index.ts`
- Test: `src/main/db/index.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 beyond the project config.
- Produces: `openDb(): Database.Database` from `src/main/db/index.ts` — Task 4's `main/index.ts` calls it once at startup and passes the returned connection directly to Task 3's `registerIpcHandlers`. `settings` table shape: `(key text primary key, value text not null)`.

- [ ] **Step 1: Write the failing migration-runner test**

`src/main/db/migrate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate';

const INIT_SQL = `create table settings (
  key text primary key,
  value text not null
);`;

describe('runMigrations', () => {
  it('creates tables from a pending migration', () => {
    const db = new Database(':memory:');
    runMigrations(db, [{ filename: '0001_init.sql', sql: INIT_SQL }]);

    const tables = db
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toContain('settings');
    expect(tables).toContain('schema_migrations');
  });

  it('is idempotent — re-running does not re-apply an already-applied migration', () => {
    const db = new Database(':memory:');
    const migration = { filename: '0001_init.sql', sql: INIT_SQL };

    runMigrations(db, [migration]);
    expect(() => runMigrations(db, [migration])).not.toThrow();

    const applied = db.prepare('select count(*) as count from schema_migrations').get() as { count: number };
    expect(applied.count).toBe(1);
  });

  it('applies multiple pending migrations in filename order', () => {
    const db = new Database(':memory:');
    runMigrations(db, [
      { filename: '0002_second.sql', sql: 'create table second (id integer primary key);' },
      { filename: '0001_init.sql', sql: INIT_SQL },
    ]);

    // Ordered by rowid, not applied_at: two migrations applied in the same test can get the
    // same second-resolution `datetime('now')` timestamp, which would make an applied_at sort
    // nondeterministic. rowid reflects true insertion order regardless of timestamp ties.
    const order = db.prepare('select filename from schema_migrations order by rowid').all() as Array<{ filename: string }>;
    expect(order.map((r) => r.filename)).toEqual(['0001_init.sql', '0002_second.sql']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/main/db/migrate.test.ts`
Expected: FAIL — `./migrate` has no exported member `runMigrations` (module doesn't exist yet).

- [ ] **Step 3: Implement the migration runner**

`src/main/db/migrate.ts`:

```ts
import type Database from 'better-sqlite3';

export interface Migration {
  filename: string;
  sql: string;
}

export function runMigrations(db: Database.Database, migrations: Migration[]): void {
  db.exec(
    `create table if not exists schema_migrations (
      filename text primary key,
      applied_at text not null default (datetime('now'))
    )`
  );

  const applied = new Set(
    (db.prepare('select filename from schema_migrations').all() as Array<{ filename: string }>).map(
      (row) => row.filename
    )
  );

  const pending = migrations
    .filter((m) => !applied.has(m.filename))
    .sort((a, b) => a.filename.localeCompare(b.filename));

  for (const migration of pending) {
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('insert into schema_migrations (filename) values (?)').run(migration.filename);
    });
    apply();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/main/db/migrate.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Write the migration file**

`src/main/db/migrations/0001_init.sql`:

```sql
create table settings (
  key text primary key,
  value text not null
);
```

- [ ] **Step 6: Write the failing `openDb` test**

`src/main/db/index.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testUserDataDir = join(tmpdir(), `smartlife-test-${Date.now()}`);

vi.mock('electron', () => ({
  app: { getPath: () => testUserDataDir },
}));

afterEach(() => {
  rmSync(testUserDataDir, { recursive: true, force: true });
});

describe('openDb', () => {
  it('creates the database file and applies migrations', async () => {
    const { openDb } = await import('./index');
    const db = openDb();

    expect(existsSync(join(testUserDataDir, 'smartlife.db'))).toBe(true);

    const tables = db
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toContain('settings');

    db.close();
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm run test -- src/main/db/index.test.ts`
Expected: FAIL — `./index` doesn't exist yet.

- [ ] **Step 8: Implement `openDb`/`getDb`**

`src/main/db/index.ts`:

```ts
import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate';
import migration0001 from './migrations/0001_init.sql?raw';

export function openDb(): Database.Database {
  const dbPath = join(app.getPath('userData'), 'smartlife.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  runMigrations(db, [{ filename: '0001_init.sql', sql: migration0001 }]);
  return db;
}
```

No module-level singleton here — `openDb()` returns the connection once and every consumer (Task 3's `registerIpcHandlers`, Task 4's `main/index.ts`) receives it as an explicit parameter. Nothing in Phase 1 needs a second way to reach the same connection from elsewhere; add a `getDb()` accessor only when a real caller needs one.

- [ ] **Step 9: Run test to verify it passes**

Run: `npm run test -- src/main/db/index.test.ts`
Expected: PASS, 1/1.

- [ ] **Step 10: Run full check**

Run: `npm run typecheck && npm run test`
Expected: both exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/main/db/
git commit -m "Task 2: local database with migration runner and settings table"
```

---

### Task 3: Secure IPC — preload bridge and main-process handlers

**Files:**
- Modify: `src/preload/index.ts` (replaces Task 1's empty version)
- Modify: `src/preload/index.d.ts` (replaces Task 1's empty version)
- Create: `src/main/ipc.ts`
- Test: `src/main/ipc.test.ts`

**Interfaces:**
- Consumes: `settings` table shape from Task 2 (`key text primary key, value text not null`).
- Produces: `window.smartlife.theme.{get,set,onSystemChange}`, `window.smartlife.app.getVersion`, `window.smartlife.navigation.onNavigate` in the renderer — Task 5 (`ThemeProvider`) and Task 6 (`Sidebar`, `Settings`, `App`) both call these directly. `registerIpcHandlers(db, getWindow): void` from `src/main/ipc.ts` — Task 4's `main/index.ts` calls this once at startup with the `openDb()` result and a `() => mainWindow` accessor.

- [ ] **Step 1: Write the failing IPC-handler-logic test**

These test the plain exported functions the `ipcMain.handle` callbacks wrap — not real Electron IPC, which can't run outside an actual Electron process.

`src/main/ipc.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getThemePreference, setThemePreference } from './ipc';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null)');
  return db;
}

describe('theme preference persistence', () => {
  it('defaults to "system" when unset', () => {
    const db = makeDb();
    expect(getThemePreference(db)).toBe('system');
  });

  it('round-trips a set value', () => {
    const db = makeDb();
    setThemePreference(db, 'dark');
    expect(getThemePreference(db)).toBe('dark');
  });

  it('overwrites a previously set value', () => {
    const db = makeDb();
    setThemePreference(db, 'dark');
    setThemePreference(db, 'light');
    expect(getThemePreference(db)).toBe('light');
  });

  it('falls back to "system" for a corrupted/unexpected stored value', () => {
    const db = makeDb();
    db.prepare('insert into settings (key, value) values (?, ?)').run('theme', 'not-a-real-theme');
    expect(getThemePreference(db)).toBe('system');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/main/ipc.test.ts`
Expected: FAIL — `./ipc` doesn't exist yet.

- [ ] **Step 3: Implement `main/ipc.ts`**

```ts
import { app, ipcMain, nativeTheme, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';

export type ThemePreference = 'light' | 'dark' | 'system';

const VALID_THEMES: ThemePreference[] = ['light', 'dark', 'system'];

export function getThemePreference(db: Database.Database): ThemePreference {
  const row = db.prepare('select value from settings where key = ?').get('theme') as
    | { value: string }
    | undefined;
  if (row && VALID_THEMES.includes(row.value as ThemePreference)) {
    return row.value as ThemePreference;
  }
  return 'system';
}

export function setThemePreference(db: Database.Database, value: ThemePreference): void {
  db.prepare(
    'insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
  ).run('theme', value);
}

export function registerIpcHandlers(db: Database.Database, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('theme:get', () => getThemePreference(db));
  ipcMain.handle('theme:set', (_event, value: ThemePreference) => {
    setThemePreference(db, value);
  });
  ipcMain.handle('app:getVersion', () => app.getVersion());

  nativeTheme.on('updated', () => {
    getWindow()?.webContents.send('theme:system-changed', nativeTheme.shouldUseDarkColors);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/main/ipc.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Write the real preload bridge**

`src/preload/index.ts`:

```ts
import { contextBridge, ipcRenderer } from 'electron';

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
};

contextBridge.exposeInMainWorld('smartlife', smartlife);

export type SmartlifeApi = typeof smartlife;
```

`src/preload/index.d.ts`:

```ts
import type { SmartlifeApi } from './index';

declare global {
  interface Window {
    smartlife: SmartlifeApi;
  }
}

export {};
```

- [ ] **Step 6: Run full check**

Run: `npm run typecheck && npm run test`
Expected: both exit 0. (`main/index.ts` still uses Task 1's minimal version and does not yet call `registerIpcHandlers` — that's Task 4. This task's job is the bridge and handler logic existing and being correctly typed, not wiring it into the app yet.)

- [ ] **Step 7: Commit**

```bash
git add src/preload/ src/main/ipc.ts src/main/ipc.test.ts
git commit -m "Task 3: secure IPC bridge and theme/version handlers"
```

---

### Task 4: App lifecycle — single-instance lock, menu, CSP, error handling

**Files:**
- Create: `src/main/csp.ts`
- Test: `src/main/csp.test.ts`
- Create: `src/main/log.ts`
- Test: `src/main/log.test.ts`
- Create: `src/main/menu.ts`
- Modify: `src/main/index.ts` (replaces Task 1's minimal version)

**Interfaces:**
- Consumes: `openDb` from Task 2, `registerIpcHandlers` from Task 3.
- Produces: the finished `main/index.ts` every later task's manual verification runs against. No new exports later tasks depend on — this task assembles, it doesn't hand off an API.

- [ ] **Step 1: Write the failing CSP test**

`src/main/csp.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildCsp } from './csp';

describe('buildCsp', () => {
  it('allows eval and localhost websockets in dev, for Vite HMR', () => {
    const csp = buildCsp(true);
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(csp).toContain('connect-src \'self\' ws://localhost:*');
  });

  it('is strict in production — no eval, no inline scripts', () => {
    const csp = buildCsp(false);
    expect(csp).toBe("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/main/csp.test.ts`
Expected: FAIL — `./csp` doesn't exist yet.

- [ ] **Step 3: Implement `csp.ts`**

```ts
export function buildCsp(isDev: boolean): string {
  if (isDev) {
    return (
      "default-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self' ws://localhost:*"
    );
  }
  return "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/main/csp.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 5: Write the failing log test**

`src/main/log.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testLogDir = join(tmpdir(), `smartlife-log-test-${Date.now()}`);

vi.mock('electron', () => ({
  app: { getPath: () => testLogDir },
}));

afterEach(() => {
  rmSync(testLogDir, { recursive: true, force: true });
});

describe('logError', () => {
  it('appends a timestamped entry to smartlife.log', async () => {
    const { logError, getLogPath } = await import('./log');
    logError('startup', new Error('boom'));

    const logPath = getLogPath();
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, 'utf8');
    expect(content).toContain('startup');
    expect(content).toContain('boom');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm run test -- src/main/log.test.ts`
Expected: FAIL — `./log` doesn't exist yet.

- [ ] **Step 7: Implement `log.ts`**

```ts
import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function getLogPath(): string {
  return join(app.getPath('logs'), 'smartlife.log');
}

export function logError(context: string, error: unknown): void {
  const logPath = getLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  const message = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  appendFileSync(logPath, `[${new Date().toISOString()}] ${context}: ${message}\n`);
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm run test -- src/main/log.test.ts`
Expected: PASS, 1/1.

- [ ] **Step 9: Write the menu**

`src/main/menu.ts`:

```ts
import { Menu, app, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

export function buildMenu(getWindow: () => BrowserWindow | null): Menu {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: 'Cmd+,',
                click: () => getWindow()?.webContents.send('navigate', '/settings'),
              },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? ([{ role: 'front' }] as MenuItemConstructorOptions[]) : [])],
    },
  ];

  return Menu.buildFromTemplate(template);
}
```

- [ ] **Step 10: Assemble the full main process**

`src/main/index.ts` (replaces Task 1's version):

```ts
import { app, BrowserWindow, Menu, session } from 'electron';
import { join } from 'node:path';
import { openDb } from './db';
import { registerIpcHandlers } from './ipc';
import { buildMenu } from './menu';
import { buildCsp } from './csp';
import { logError, getLogPath } from './log';

const isDev = !app.isPackaged;

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  function createWindow(): void {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      titleBarStyle: 'hiddenInset',
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    mainWindow.once('ready-to-show', () => mainWindow?.show());
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    if (process.env.ELECTRON_RENDERER_URL) {
      mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
    }
  }

  function showStartupError(message: string): void {
    const html = `<!doctype html><html><body style="font-family: -apple-system, sans-serif; padding: 32px; background: #0B0F14; color: #E8EDF2;">
      <h2>SmartLife failed to start</h2>
      <p>${message}</p>
      <p style="color: #8A9AAB; font-size: 13px;">Details were written to: ${getLogPath()}</p>
    </body></html>`;
    const errorWindow = new BrowserWindow({ width: 600, height: 320, webPreferences: { sandbox: true } });
    errorWindow.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  }

  app.whenReady().then(() => {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [buildCsp(isDev)] },
      });
    });

    Menu.setApplicationMenu(buildMenu(() => mainWindow));

    try {
      const db = openDb();
      registerIpcHandlers(db, () => mainWindow);
      createWindow();
    } catch (error) {
      logError('startup', error);
      showStartupError(error instanceof Error ? error.message : String(error));
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
```

- [ ] **Step 11: Run full check**

Run: `npm run typecheck && npm run test && npm run build`
Expected: all exit 0.

- [ ] **Step 12: Manually verify lifecycle behavior**

Run: `npm run dev` in the background.
- Confirm the window opens (check dev-server output for the expected `ELECTRON_RENDERER_URL` load, no thrown errors).
- Confirm a real macOS menu bar with app name / Edit / View / Window is present (this is only visible in the actual UI — the controller will do the visual check with a screenshot after Task 7; here, confirm no error is thrown while `Menu.setApplicationMenu` runs, which the absence of a startup-error window/log entry already tells you).
- Kill the process once confirmed stable.

- [ ] **Step 13: Commit**

```bash
git add src/main/
git commit -m "Task 4: app lifecycle - single-instance lock, menu, CSP, startup error handling"
```

---

### Task 5: Renderer design system and theme provider

**Files:**
- Create: `src/renderer/src/theme/tokens.css`
- Create: `src/renderer/src/theme/ThemeProvider.tsx`
- Test: `src/renderer/src/theme/ThemeProvider.test.tsx`

**Interfaces:**
- Consumes: `window.smartlife.theme.{get,set,onSystemChange}` from Task 3.
- Produces: `<ThemeProvider>` and `useTheme(): { preference, resolved, setPreference }` — Task 6's `App.tsx` wraps the whole tree in this, and `Settings.tsx` calls `useTheme()`. CSS custom properties `--color-bg`, `--color-surface`, `--color-border`, `--color-text`, `--color-text-muted`, `--font-shell`, applied via `[data-theme="light"|"dark"]` on `<html>` — Task 6's components style against these.

- [ ] **Step 1: Write the design tokens**

`src/renderer/src/theme/tokens.css`:

```css
@import "tailwindcss";

@theme {
  --font-shell: -apple-system, BlinkMacSystemFont, "SF Pro Text", ui-sans-serif, system-ui, sans-serif;
}

:root,
[data-theme="light"] {
  --color-bg: #f7f7f8;
  --color-surface: #ffffff;
  --color-border: #e4e4e7;
  --color-text: #18181b;
  --color-text-muted: #71717a;
}

[data-theme="dark"] {
  --color-bg: #0b0b0d;
  --color-surface: #17171a;
  --color-border: #27272a;
  --color-text: #f4f4f5;
  --color-text-muted: #a1a1aa;
}

body {
  background-color: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-shell);
  margin: 0;
}
```

- [ ] **Step 2: Write the failing ThemeProvider tests**

`src/renderer/src/theme/ThemeProvider.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, useTheme } from './ThemeProvider';

function Probe() {
  const { resolved } = useTheme();
  return <div data-testid="resolved">{resolved}</div>;
}

function mockSmartlife(getValue: 'light' | 'dark' | 'system' = 'dark') {
  const listeners: Array<(isDark: boolean) => void> = [];
  (window as unknown as { smartlife: typeof window.smartlife }).smartlife = {
    theme: {
      get: vi.fn().mockResolvedValue(getValue),
      set: vi.fn().mockResolvedValue(undefined),
      onSystemChange: vi.fn((cb: (isDark: boolean) => void) => {
        listeners.push(cb);
        return () => {};
      }),
    },
    app: { getVersion: vi.fn().mockResolvedValue('0.1.0') },
    navigation: { onNavigate: vi.fn(() => () => {}) },
  };
  return listeners;
}

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
});

describe('ThemeProvider', () => {
  it('applies the persisted preference to <html data-theme>', async () => {
    mockSmartlife('dark');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );

    await waitFor(() => expect(screen.getByTestId('resolved').textContent).toBe('dark'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('resolves "system" using the live system-change callback', async () => {
    const listeners = mockSmartlife('system');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );

    await waitFor(() => expect(screen.getByTestId('resolved').textContent).toBe('light'));

    listeners[0](true);

    await waitFor(() => expect(screen.getByTestId('resolved').textContent).toBe('dark'));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -- src/renderer/src/theme/ThemeProvider.test.tsx`
Expected: FAIL — `./ThemeProvider` doesn't exist yet.

- [ ] **Step 4: Implement `ThemeProvider.tsx`**

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type ThemePreference = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (value: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveTheme(preference: ThemePreference, systemIsDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemIsDark ? 'dark' : 'light';
  return preference;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [systemIsDark, setSystemIsDark] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    window.smartlife.theme.get().then((value) => {
      setPreferenceState(value);
      setLoaded(true);
    });
    setSystemIsDark(window.matchMedia('(prefers-color-scheme: dark)').matches);
    return window.smartlife.theme.onSystemChange((isDark) => setSystemIsDark(isDark));
  }, []);

  const resolved = resolveTheme(preference, systemIsDark);

  useEffect(() => {
    if (loaded) {
      document.documentElement.setAttribute('data-theme', resolved);
    }
  }, [resolved, loaded]);

  function setPreference(value: ThemePreference): void {
    setPreferenceState(value);
    window.smartlife.theme.set(value);
  }

  if (!loaded) return null;

  return <ThemeContext.Provider value={{ preference, resolved, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- src/renderer/src/theme/ThemeProvider.test.tsx`
Expected: PASS, 2/2.

- [ ] **Step 6: Run full check**

Run: `npm run typecheck && npm run test`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/theme/
git commit -m "Task 5: design tokens and ThemeProvider"
```

---

### Task 6: Navigation, routes, and app shell

**Files:**
- Create: `src/renderer/src/nav/sections.ts`
- Create: `src/renderer/src/nav/sectionThemes.ts`
- Test: `src/renderer/src/nav/sectionThemes.test.ts`
- Create: `src/renderer/src/nav/Sidebar.tsx`
- Create: `src/renderer/src/routes/Home.tsx`
- Test: `src/renderer/src/routes/Home.test.tsx`
- Create: `src/renderer/src/routes/Settings.tsx`
- Create: `src/renderer/src/routes/ComingSoon.tsx`
- Modify: `src/renderer/src/App.tsx` (replaces Task 1's placeholder)
- Test: `src/renderer/src/App.test.tsx`
- Modify: `src/renderer/src/main.tsx` (import tokens.css)

**Interfaces:**
- Consumes: `ThemeProvider`/`useTheme` from Task 5, `window.smartlife.app.getVersion`/`window.smartlife.navigation.onNavigate` from Task 3.
- Produces: the full Phase 1 UI. No later Phase 1 task depends on this one.

- [ ] **Step 1: Write the section registry**

`src/renderer/src/nav/sections.ts`:

```ts
export interface NavSection {
  slug: string;
  label: string;
  path: string;
}

export const NAV_SECTIONS: NavSection[] = [
  { slug: 'home', label: 'Home', path: '/' },
  { slug: 'ai', label: 'AI', path: '/ai' },
  { slug: 'calendar', label: 'Calendar', path: '/calendar' },
  { slug: 'school', label: 'School', path: '/school' },
  { slug: 'browser', label: 'Browser', path: '/browser' },
  { slug: 'tasks', label: 'Tasks', path: '/tasks' },
  { slug: 'notes', label: 'Notes', path: '/notes' },
  { slug: 'goals', label: 'Goals', path: '/goals' },
  { slug: 'files', label: 'Files', path: '/files' },
  { slug: 'search', label: 'Search', path: '/search' },
  { slug: 'settings', label: 'Settings', path: '/settings' },
];
```

- [ ] **Step 2: Write the failing section-theme test**

`src/renderer/src/nav/sectionThemes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getSectionTheme } from './sectionThemes';

describe('getSectionTheme', () => {
  it('returns the registered theme for a known section', () => {
    expect(getSectionTheme('calendar').accent).toBe('#FB923C');
  });

  it('falls back to the default (Home) theme for an unregistered slug', () => {
    expect(getSectionTheme('nonexistent')).toEqual(getSectionTheme('home'));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -- src/renderer/src/nav/sectionThemes.test.ts`
Expected: FAIL — `./sectionThemes` doesn't exist yet.

- [ ] **Step 4: Implement `sectionThemes.ts`**

```ts
export interface SectionTheme {
  gradient: string;
  accent: string;
}

const REGISTRY: Record<string, SectionTheme> = {
  home: { gradient: 'linear-gradient(135deg, #6D5EFC, #8F7BFF)', accent: '#6D5EFC' },
  ai: { gradient: 'linear-gradient(135deg, #0E7490, #22D3EE)', accent: '#22D3EE' },
  calendar: { gradient: 'linear-gradient(135deg, #9A3412, #FB923C)', accent: '#FB923C' },
  school: { gradient: 'linear-gradient(135deg, #1E3A8A, #3B82F6)', accent: '#3B82F6' },
  browser: { gradient: 'linear-gradient(135deg, #0F766E, #2DD4BF)', accent: '#2DD4BF' },
  tasks: { gradient: 'linear-gradient(135deg, #166534, #4ADE80)', accent: '#4ADE80' },
  notes: { gradient: 'linear-gradient(135deg, #92400E, #FBBF24)', accent: '#FBBF24' },
  goals: { gradient: 'linear-gradient(135deg, #9D174D, #F472B6)', accent: '#F472B6' },
  files: { gradient: 'linear-gradient(135deg, #334155, #94A3B8)', accent: '#94A3B8' },
  search: { gradient: 'linear-gradient(135deg, #6D5EFC, #8F7BFF)', accent: '#6D5EFC' },
  settings: { gradient: 'linear-gradient(135deg, #27272A, #71717A)', accent: '#71717A' },
};

const DEFAULT_THEME: SectionTheme = REGISTRY.home;

export function getSectionTheme(slug: string): SectionTheme {
  return REGISTRY[slug] ?? DEFAULT_THEME;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- src/renderer/src/nav/sectionThemes.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 6: Write the Sidebar**

`src/renderer/src/nav/Sidebar.tsx`:

```tsx
import { NavLink } from 'react-router-dom';
import { NAV_SECTIONS } from './sections';
import { getSectionTheme } from './sectionThemes';

export function Sidebar() {
  return (
    <nav className="flex w-56 flex-shrink-0 flex-col gap-1 border-r p-3" style={{ borderColor: 'var(--color-border)' }}>
      {NAV_SECTIONS.map((section) => {
        const theme = getSectionTheme(section.slug);
        return (
          <NavLink
            key={section.slug}
            to={section.path}
            end={section.path === '/'}
            className={({ isActive }) =>
              `rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive ? 'text-white' : 'hover:opacity-80'
              }`
            }
            style={({ isActive }) => ({
              backgroundColor: isActive ? theme.accent : 'transparent',
              color: isActive ? '#ffffff' : 'var(--color-text-muted)',
            })}
          >
            {section.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 7: Write the failing Home greeting test**

`src/renderer/src/routes/Home.test.tsx`:

```ts
import { describe, expect, it } from 'vitest';
import { greeting } from './Home';

describe('greeting', () => {
  it('says good morning before noon', () => {
    expect(greeting(9)).toBe('Good morning');
  });

  it('says good afternoon from noon to before 6pm', () => {
    expect(greeting(12)).toBe('Good afternoon');
    expect(greeting(17)).toBe('Good afternoon');
  });

  it('says good evening from 6pm', () => {
    expect(greeting(18)).toBe('Good evening');
    expect(greeting(23)).toBe('Good evening');
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npm run test -- src/renderer/src/routes/Home.test.tsx`
Expected: FAIL — `./Home` doesn't exist yet.

- [ ] **Step 9: Implement `Home.tsx`**

```tsx
export function greeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function Home() {
  const text = greeting(new Date().getHours());
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <h1 className="text-2xl font-semibold" style={{ color: 'var(--color-text)' }}>
        {text}
      </h1>
      <p style={{ color: 'var(--color-text-muted)' }}>Nothing wired up yet — start with Settings.</p>
    </div>
  );
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npm run test -- src/renderer/src/routes/Home.test.tsx`
Expected: PASS, 3/3.

- [ ] **Step 11: Write `Settings.tsx` and `ComingSoon.tsx`**

`src/renderer/src/routes/Settings.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useTheme } from '../theme/ThemeProvider';

const OPTIONS = ['light', 'dark', 'system'] as const;

export function Settings() {
  const { preference, setPreference } = useTheme();
  const [version, setVersion] = useState('');

  useEffect(() => {
    window.smartlife.app.getVersion().then(setVersion);
  }, []);

  return (
    <div className="flex flex-col gap-6 p-8">
      <h1 className="text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
        Settings
      </h1>
      <div className="flex flex-col gap-2">
        <span style={{ color: 'var(--color-text-muted)' }}>Theme</span>
        <div className="flex gap-2">
          {OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setPreference(option)}
              className="rounded-md px-3 py-1.5 text-sm capitalize"
              style={{
                backgroundColor: preference === option ? 'var(--color-text)' : 'var(--color-surface)',
                color: preference === option ? 'var(--color-bg)' : 'var(--color-text)',
                border: '1px solid var(--color-border)',
              }}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      <p style={{ color: 'var(--color-text-muted)' }}>SmartLife v{version}</p>
    </div>
  );
}
```

`src/renderer/src/routes/ComingSoon.tsx`:

```tsx
export function ComingSoon({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <h1 className="text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
        {label}
      </h1>
      <p style={{ color: 'var(--color-text-muted)' }}>Coming in a later phase.</p>
    </div>
  );
}
```

- [ ] **Step 12: Write the failing App test**

`src/renderer/src/App.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

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
  };
});

describe('App', () => {
  it('shows Home by default and navigates to a placeholder section', async () => {
    render(<App />);

    expect(await screen.findByText(/good (morning|afternoon|evening)/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: 'Tasks' }));

    expect(await screen.findByText('Coming in a later phase.')).toBeInTheDocument();
  });

  it('navigates to Settings and can change the theme preference', async () => {
    render(<App />);

    await userEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(await screen.findByText('Settings')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'dark' }));

    expect(window.smartlife.theme.set).toHaveBeenCalledWith('dark');
  });
});
```

- [ ] **Step 13: Run test to verify it fails**

Run: `npm run test -- src/renderer/src/App.test.tsx`
Expected: FAIL — `App` still renders Task 1's placeholder, no `link`/`button` roles found.

- [ ] **Step 14: Implement the full `App.tsx`**

```tsx
import { useEffect } from 'react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { ThemeProvider } from './theme/ThemeProvider';
import { Sidebar } from './nav/Sidebar';
import { NAV_SECTIONS } from './nav/sections';
import { Home } from './routes/Home';
import { Settings } from './routes/Settings';
import { ComingSoon } from './routes/ComingSoon';

function NavigationBridge() {
  const navigate = useNavigate();
  useEffect(() => window.smartlife.navigation.onNavigate((path) => navigate(path)), [navigate]);
  return null;
}

function Shell() {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <NavigationBridge />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/settings" element={<Settings />} />
          {NAV_SECTIONS.filter((section) => section.path !== '/' && section.path !== '/settings').map((section) => (
            <Route key={section.slug} path={section.path} element={<ComingSoon label={section.label} />} />
          ))}
        </Routes>
      </main>
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <MemoryRouter>
        <Shell />
      </MemoryRouter>
    </ThemeProvider>
  );
}
```

- [ ] **Step 15: Update `main.tsx` to import the design tokens**

`src/renderer/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './theme/tokens.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 16: Run test to verify it passes**

Run: `npm run test -- src/renderer/src/App.test.tsx`
Expected: PASS, 2/2.

- [ ] **Step 17: Run full check**

Run: `npm run typecheck && npm run test && npm run lint && npm run build`
Expected: all exit 0.

- [ ] **Step 18: Commit**

```bash
git add src/renderer/
git commit -m "Task 6: navigation, routes, and app shell"
```

---

### Task 7: Packaging and final verification

**Files:**
- No new files — this task packages and verifies everything from Tasks 1-6 together.

**Interfaces:**
- Consumes: everything. Produces: nothing further — this is the last task in the plan.

- [ ] **Step 1: Run the complete pipeline**

Run: `npm run lint && npm run typecheck && npm run test && npm run build`
Expected: every command exits 0. Note the total test count in the final `npm run test` output for the task report.

- [ ] **Step 2: Package the app**

Run: `npm run package`
Expected: exits 0.

- [ ] **Step 3: Verify the packaged app artifact exists**

Run: `find release -maxdepth 3 -name "SmartLife.app"`
Expected: prints one path (the exact directory name under `release/` varies by CPU architecture, e.g. `release/mac-arm64/SmartLife.app` or `release/mac/SmartLife.app` — either is correct, just confirm one exists).

- [ ] **Step 4: Confirm the packaged app's entry point matches `package.json`**

Run: `ls out/main/index.js out/preload/index.js out/renderer/index.html`
Expected: all three files exist (these are exactly what `electron-builder.yml`'s `files: [out/**/*]` packages, and what `package.json`'s `"main": "./out/main/index.js"` points at).

- [ ] **Step 5: Commit if `npm run package` produced any tracked file changes**

Run: `git status`
Expected: `release/` and `out/` are untracked/ignored (already covered by `.gitignore`) — if `git status` shows them as tracked, that's a bug in `.gitignore`; fix `.gitignore` to add `out/` if missing (it should already be there from the repo's initial `.gitignore`) and commit that fix. Otherwise, nothing to commit for this task.

---

## After this plan

Once all 7 tasks are reviewed and approved, the controller (not a subagent) does a real visual pass: launch `npm run dev`, take a screenshot, click through all 11 nav items, toggle the theme three ways, and confirm the native macOS menu bar (App/Edit/View/Window) is present — none of that is meaningfully verifiable through text-only tool output. Then update `../../../ROADMAP.md`'s status checklist and move on to brainstorming Phase 2 (AI Core) when the user is ready.
