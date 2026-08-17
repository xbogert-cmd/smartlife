# SmartLife Phase 1: Foundation — Design

**Goal:** Stand up the real Electron+React+TypeScript desktop shell SmartLife will
be built on for the rest of its phases — nav, theming, a local database with
migrations, and secure IPC — with nothing in it yet that talks to a network.
`npm run package` produces a launchable `SmartLife.app` by the end of this phase.

See `../../../ROADMAP.md` for how this phase fits into the full 9-phase plan
and the corrections made to the original master-build prompt.

## Architecture

Electron's three-process model, scaffolded via `electron-vite`'s
`react-ts` template (the standard, actively-maintained way to get Vite's dev
server + HMR wired correctly across main/preload/renderer — hand-rolling this
is a well-known footgun, not worth doing manually):

```
main process (Node)  <--IPC-->  preload (contextBridge)  <--window.smartlife-->  renderer (React, browser sandbox)
       |
       v
  better-sqlite3 (userData/smartlife.db)
```

- **Main process** (`src/main/`): app lifecycle, the one `BrowserWindow`,
  owns the SQLite connection, all `ipcMain.handle` handlers.
- **Preload** (`src/preload/`): the *only* bridge between main and renderer.
  Exposes a narrow, typed `window.smartlife` API via `contextBridge`. The
  renderer never sees Node or Electron APIs directly.
- **Renderer** (`src/renderer/`): plain React 19 + TypeScript, no Node
  integration, no filesystem/IPC access except through `window.smartlife`.

Nothing in Phase 1 makes a network request. That's deliberate — it's the one
phase where "does the shell work" and "does a network call fail" can never be
confused with each other while debugging.

## Directory structure

```
smartlife/
  src/
    main/
      index.ts              # app lifecycle, BrowserWindow, ipcMain handlers
      db/
        index.ts             # opens better-sqlite3, runs migrations on startup
        migrate.ts            # migration runner
        migrations/
          0001_init.sql        # schema_migrations + settings tables
      log.ts                 # writes to userData/logs/smartlife.log
    preload/
      index.ts              # contextBridge, exposes window.smartlife
    renderer/
      index.html
      src/
        main.tsx
        App.tsx              # router root
        theme/
          ThemeProvider.tsx   # reads/writes theme via window.smartlife.theme
          tokens.css          # Tailwind v4 @theme block, ported palette
        nav/
          Sidebar.tsx         # persistent left nav, 11 sections
          sectionThemes.ts    # accent/gradient per section (ports moduleThemes.ts)
        routes/
          Home.tsx             # real content
          Settings.tsx         # real content: theme toggle
          ComingSoon.tsx       # placeholder used by the other 9 routes
  docs/superpowers/{specs,plans}/
  ROADMAP.md
  package.json
  electron.vite.config.ts
  electron-builder.yml
  tsconfig.json / tsconfig.node.json / tsconfig.web.json  (electron-vite default split)
  .gitignore
```

## Design system

Ported from the existing dashboard's Tailwind v4 `@theme` token approach
(`lib/moduleThemes.ts`, `app/globals.css` in the `redline-dashboard` repo),
adapted for a dark-first desktop shell:

- Dark theme is the default; light and system-follow are both fully supported
  from Phase 1, not bolted on later.
- Each of the 11 nav sections gets a `{ gradient, accent }` pair in
  `sectionThemes.ts` — same shape as `moduleThemes.ts`'s `ModuleTheme`, same
  "unregistered sections still look intentional via a default" fallback rule.
  Phase 1 hand-picks accents for all 11 now (cheap, avoids an ugly
  all-grey nav before later phases land):

  | Section | Accent hex | Gradient |
  |---|---|---|
  | Home | `#6D5EFC` | `linear-gradient(135deg, #6D5EFC, #8F7BFF)` (ported `DEFAULT_THEME`) |
  | AI | `#22D3EE` | `linear-gradient(135deg, #0E7490, #22D3EE)` |
  | Calendar | `#FB923C` | `linear-gradient(135deg, #9A3412, #FB923C)` |
  | School | `#3B82F6` | `linear-gradient(135deg, #1E3A8A, #3B82F6)` |
  | Browser | `#2DD4BF` | `linear-gradient(135deg, #0F766E, #2DD4BF)` |
  | Tasks | `#4ADE80` | `linear-gradient(135deg, #166534, #4ADE80)` |
  | Notes | `#FBBF24` | `linear-gradient(135deg, #92400E, #FBBF24)` |
  | Goals | `#F472B6` | `linear-gradient(135deg, #9D174D, #F472B6)` |
  | Files | `#94A3B8` | `linear-gradient(135deg, #334155, #94A3B8)` |
  | Search | same as Home (`#6D5EFC`) — search isn't really "a place" |
  | Settings | `#71717A` | `linear-gradient(135deg, #27272A, #71717A)` — deliberately muted |
- Typography: system font stack (`ui-sans-serif` / SF Pro on macOS via
  `-apple-system`), matching the dashboard's `--font-shell` pattern rather
  than shipping a custom webfont — a desktop app should feel native.
- `framer-motion` for section-switch transitions and the theme-toggle
  micro-interaction, matching the dashboard's existing motion language.

## Navigation shell

Persistent left sidebar, all 11 sections from the master prompt (Home, AI,
Calendar, School, Browser, Tasks, Notes, Goals, Files, Search, Settings),
routed now via `react-router`'s `MemoryRouter` (no real URLs needed in a
single-window desktop app). Only **Home** and **Settings** render real
content in Phase 1; the other 9 render `<ComingSoon section="..." />` — a
plain centered message naming the section and, where known, which phase adds
it. This is a one-time cost to avoid re-plumbing navigation on every future
phase, and it means the app never has a broken/missing link even though most
of it isn't built yet.

**Home** (Phase 1 version — not the full AI-briefing Home from later phases):
a static greeting ("Good morning" / afternoon / evening by local time) and a
short "Nothing wired up yet — start with Settings" hint. Deliberately not
building the timeline/briefing layout now; that whole screen gets redesigned
in Phase 6 once there's real data to show. Building it twice would be wasted
work either way, but building a placeholder once is nearly free.

**Settings**: exactly one real control in Phase 1 — theme (Light / Dark /
System), persisted to the local DB and applied immediately, plus an "About"
line showing the app version from `window.smartlife.app.getVersion()`.

## Local database

`better-sqlite3` (synchronous, no async ceremony, the standard choice for
Electron local storage — used by VS Code and most local-first Electron apps),
opened once in the main process at
`app.getPath('userData')/smartlife.db` (e.g.
`~/Library/Application Support/SmartLife/smartlife.db` on macOS).

No ORM in Phase 1. A hand-rolled migration runner is enough for the two
tables this phase needs; Drizzle or similar gets evaluated when a later phase
(Canvas or the planner) actually brings enough relational complexity to
justify it — adding it now for two tables would be solving a problem that
doesn't exist yet.

**Migration runner** (`src/main/db/migrate.ts`): reads `.sql` files from
`migrations/` in filename order, tracks applied ones in `schema_migrations`,
applies any not-yet-applied file inside a single transaction, throws (caught
by `main/index.ts`, see Error Handling) if a migration fails partway.

**`migrations/0001_init.sql`:**

```sql
create table schema_migrations (
  filename text primary key,
  applied_at text not null default (datetime('now'))
);

create table settings (
  key text primary key,
  value text not null
);
```

Phase 1's only row: `('theme', 'system' | 'light' | 'dark')`, defaulted to
`'system'` on first read if absent.

## Secure IPC

Electron security baseline, non-negotiable from day one because retrofitting
it after the renderer has grown dependent on loose access is real, painful
work (this is explicitly called out in the master prompt too):

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on the
  `BrowserWindow`.
- Preload exposes exactly this surface for Phase 1 — nothing else:

```ts
window.smartlife = {
  theme: {
    get(): Promise<'light' | 'dark' | 'system'>,
    set(value: 'light' | 'dark' | 'system'): Promise<void>,
    onSystemChange(cb: (isDark: boolean) => void): () => void, // returns unsubscribe
  },
  app: {
    getVersion(): Promise<string>,
  },
}
```

- `theme.onSystemChange` exists because "System" mode needs to react live
  when macOS's appearance changes while the app is open: main process
  subscribes to Electron's `nativeTheme.on('updated', ...)` once and
  broadcasts via `webContents.send('theme:system-changed', ...)`; preload
  relays it into the callback the renderer registered.
- Content-Security-Policy (set via a `<meta>` tag in
  `renderer/index.html`): `default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'`. The `style-src` relaxation is
  deliberate and scoped narrowly — `framer-motion` sets inline `style`
  attributes for its transforms, which CSP's `style-src` governs even
  without a `<style>` tag involved; `script-src` stays strict.
- No `<webview>` tag and no second `BrowserWindow` in Phase 1 — those
  concerns start in Phase 5 (embedded browser), which needs its own,
  separately-reviewed sandboxing story.

## macOS app conventions

Three easy-to-miss Electron defaults that read as broken/unpolished on macOS
if left unset — cheap to get right now, annoying to notice and fix later
because by then they're load-bearing habits:

- **Single instance lock** (`app.requestSingleInstanceLock()`): a second
  launch (e.g. double-clicking the `.app` again) quits immediately and
  focuses the existing window instead of opening a second `better-sqlite3`
  connection against the same file. Without this, two instances writing to
  `smartlife.db` at once is a real corruption risk, not a hypothetical one.
- **Menu bar with standard Edit roles**: Electron ships no menu bar by
  default, which silently breaks Cmd+C/Cmd+X/Cmd+V/Cmd+A/Cmd+Z in every text
  input — those shortcuts only work because of the OS-level Edit menu's
  `role: 'copy'/'cut'/'paste'/'selectAll'/'undo'` entries, which don't exist
  until you build the menu. Phase 1 ships a minimal `Menu.buildFromTemplate`
  with App/Edit/View/Window menus using Electron's built-in roles, plus one
  custom item: Settings under the App menu, bound to Cmd+,.
- **Quit/activate lifecycle**: on macOS, closing the last window should not
  quit the app (`app.on('window-all-closed')` is a no-op when
  `process.platform === 'darwin'`), and clicking the Dock icon after all
  windows are closed should reopen one (`app.on('activate')` creates a new
  `BrowserWindow` if none exist). This is the behavior every native Mac app
  has; skipping it is the single fastest way for SmartLife to feel like a
  ported web app instead of a Mac app.

## Error handling

Phase 1's only real failure modes are local: the DB fails to open, or a
migration throws. Both are caught in `main/index.ts` before the window is
shown. On failure:

1. Append the error (message + stack) to
   `app.getPath('logs')/smartlife.log` via plain `fs.appendFileSync` — no new
   logging dependency for one file write; a packaged `.app` has no visible
   terminal, so this is the only place a startup failure is recorded.
2. Load a minimal static error view instead of the React app (a plain HTML
   string, not the renderer bundle, so a broken renderer build can't also
   break the error path) telling the user startup failed and naming the log
   file path.

## Testing

`vitest`, matching the existing dashboard project's convention:

- Migration runner: apply `0001_init.sql` against an in-memory
  `better-sqlite3` instance, assert both tables exist and re-running the
  runner is a no-op (idempotent).
- IPC handler logic: the `ipcMain.handle('theme:set', ...)` handler bodies
  are plain functions taking `(db, value)` — test them directly without
  going through real Electron IPC.
- Renderer: `ThemeProvider` applies the right `data-theme` value for each of
  light/dark/system (system case mocks `window.smartlife.theme.onSystemChange`).

Full Electron end-to-end testing (Playwright's Electron support or similar)
is deliberately not set up in Phase 1 — there's one real interaction (the
theme toggle) worth automating that way, not enough yet to justify the
harness. Revisit once more phases land. Manual verification for Phase 1: run
`npm run dev`, confirm the shell launches, all 11 nav items are clickable,
Home and Settings show real content, the other 9 show their placeholder, and
the theme toggle changes the whole app immediately and survives a restart.

## Packaging

`electron-builder`, configured for a fast unsigned local build (`target:
dir` — skips DMG creation and code signing entirely) via `npm run package`.
Real signed/notarized distribution is a Phase 9 concern and requires an Apple
Developer Program account ($99/yr) — not set up now, and not needed to run
the app on this Mac.

## npm scripts

```
npm run dev         # electron-vite dev, HMR
npm run build        # electron-vite build
npm run package       # electron-builder, unsigned .app to dist/
npm run test         # vitest run
npm run lint          # eslint
npm run typecheck      # tsc --noEmit (both node and web tsconfigs)
```

## Explicitly out of scope for Phase 1

No AI, no Canvas, no Google, no embedded browser, no tasks/notes/goals/files
data model, no universal search, no command palette. All of those are later
phases per `ROADMAP.md` and get their own brainstorm when we reach them. The
9 placeholder nav sections exist so navigating to them isn't a dead end, not
because any of their functionality starts here.

## Global constraints

- macOS only (no Windows/Linux build target in `electron-builder.yml`).
- No network request anywhere in this phase's code.
- No dependency added beyond: `electron`, `electron-vite`, `electron-builder`,
  `react`, `react-dom`, `react-router`, `framer-motion`, `better-sqlite3`,
  `tailwindcss` v4, plus their `@types/*`/dev tooling (`vitest`,
  `@testing-library/react`, `eslint`, `typescript`). Anything else needed
  gets flagged, not silently added.
- `contextIsolation`/`sandbox`/no-`nodeIntegration` apply to every
  `BrowserWindow` created in every future phase, not just this one.
