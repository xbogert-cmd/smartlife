# Local Whisper Voice Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SmartLife's Gemini-based voice transcription with an on-device `whisper.cpp` subprocess — no API key, no per-use cost, offline after a one-time model download.

**Architecture:** The renderer records 16 kHz mono WAV (unchanged pipeline, one constructor argument added) and sends base64 over the existing `ai:transcribe-audio` IPC channel. In the main process, `transcribeAudio` writes the WAV to a temp file, runs a bundled `whisper-cli` binary via `execFile`, and returns the trimmed stdout. The ~142 MB model downloads once on first use to `userData/models/`. TTS and all voice UI are untouched.

**Tech Stack:** Electron 33 (main = Node, `externalizeDepsPlugin`), TypeScript strict, Vitest + jsdom, `whisper.cpp` (`whisper-cli`) built from source into a git-ignored `resources/` and bundled via electron-builder `extraResources`.

## Global Constraints

- Tests run via `npm test` (script sets `ELECTRON_RUN_AS_NODE=1`). Single file: `npm test -- <path>`. Single test: `npm test -- -t "<name>"`. Never `npx vitest`.
- After each task: `npm run lint` and `npm run typecheck` must both pass before the commit step.
- **16 kHz mono is mandatory** — `whisper.cpp` rejects any other WAV. The renderer records at `new AudioContext({ sampleRate: 16000 })`; there is no resampling anywhere else.
- `transcribeAudio`'s signature and result shape (`{ ok: true; text: string } | { ok: false; reason: string }`) **do not change**. The IPC handler, preload, and `useVoice.ts`'s call site stay as they are apart from the 16 kHz constructor argument.
- The child process is spawned with `execFile` (no shell), a fixed argument array, an absolute binary path, `timeout: 120_000`, `maxBuffer: 8 * 1024 * 1024`.
- The model is **downloaded on first use**, once, to `join(app.getPath('userData'), 'models', 'ggml-base.en.bin')` — never bundled in the app or committed.
- **Packaging risk (verify against a real build, not just `electron-vite dev`):** `whisper-cli` must resolve and run from a packaged app (`process.resourcesPath`) as well as from the repo (`resources/`). Confirm with `npm run package` during Task 1.
- Gemini stays a chat provider; its Settings key field and `providerConfig.ts` are not touched.
- No test starts a real subprocess or makes a real network request.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `scripts/fetch-whisper.mjs` (create) | Build `whisper-cli` from a pinned `whisper.cpp` ref into `resources/` on `postinstall` | 1 |
| `.gitignore` (modify) | Ignore `resources/` | 1 |
| `package.json` (modify) | `postinstall` also runs the fetch script | 1 |
| `electron-builder.yml` (modify) | `extraResources` bundles `resources/whisper-cli` | 1 |
| `eslint.config.mjs` (modify) | Node globals for `scripts/**/*.mjs` | 1 |
| `src/main/ai/voice/whisperPaths.ts` (create) | Pure resolution of the binary path, model path, model URL | 2 |
| `src/main/ai/voice/whisperPaths.test.ts` (create) | Unit tests for the above | 2 |
| `src/main/ai/voice/whisperModel.ts` (create) | `ensureWhisperModel()` — first-use download, concurrency guard, partial cleanup | 3 |
| `src/main/ai/voice/whisperModel.test.ts` (create) | Unit tests for the above | 3 |
| `src/main/ai/voice/transcribe.ts` (rewrite) | Orchestrate: mime check → model check → temp WAV → `whisper-cli` → parse; export `whisperArgs()` | 4 |
| `src/main/ai/voice/transcribe.test.ts` (rewrite) | Unit tests for the above | 4 |
| `src/renderer/src/ai/useVoice.ts` (modify) | Record at 16 kHz | 5 |
| `src/renderer/src/ai/useVoice.test.ts` (modify) | Fake `AudioContext` honors `sampleRate`; assert 16 kHz | 5 |

Task 4 consumes Tasks 2 and 3. Tasks 1 and 5 are independent. Recommended order: 1 → 2 → 3 → 4 → 5.

---

### Task 1: Vendor the `whisper-cli` binary

**Files:**
- Create: `scripts/fetch-whisper.mjs`
- Modify: `.gitignore`
- Modify: `package.json` (the `postinstall` script)
- Modify: `electron-builder.yml`
- Modify: `eslint.config.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: an executable at `<repo>/resources/whisper-cli` after `npm install`; the same binary at `<app>/Contents/Resources/whisper-cli` after `npm run package`.

This task has no unit test — it is a build script. Its deliverable is verified by running the binary.

- [ ] **Step 1: Add the eslint block for the script**

In `eslint.config.mjs`, add this object to the `tseslint.config(...)` call, after the existing `no-unused-vars` block:

```js
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
  },
```

- [ ] **Step 2: Write `scripts/fetch-whisper.mjs`**

```js
// Builds the whisper.cpp CLI once, into resources/whisper-cli (git-ignored),
// so it can be bundled via electron-builder extraResources. Runs on
// postinstall; no-ops if the binary is already there.
//
// Requires: git, cmake. macOS: `brew install cmake` if missing.
// Verify at implementation time: the tag below is current and
// `build/bin/whisper-cli` is still the artifact path for it.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WHISPER_CPP_REF = 'v1.7.4';
const OUT = join(process.cwd(), 'resources', 'whisper-cli');

if (existsSync(OUT)) {
  console.log('[fetch-whisper] resources/whisper-cli already present, skipping');
  process.exit(0);
}

try {
  execFileSync('cmake', ['--version'], { stdio: 'ignore' });
} catch {
  console.error('[fetch-whisper] cmake not found. Install it (macOS: `brew install cmake`) and re-run `npm install`.');
  process.exit(1);
}

const work = join(tmpdir(), `whisper-cpp-${WHISPER_CPP_REF}-${Date.now()}`);
try {
  console.log(`[fetch-whisper] cloning whisper.cpp ${WHISPER_CPP_REF}`);
  execFileSync('git', ['clone', '--depth', '1', '--branch', WHISPER_CPP_REF,
    'https://github.com/ggerganov/whisper.cpp', work], { stdio: 'inherit' });

  const build = join(work, 'build');
  execFileSync('cmake', ['-S', work, '-B', build,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DGGML_METAL_EMBED_LIBRARY=ON',
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_EXAMPLES=ON',
  ], { stdio: 'inherit' });
  execFileSync('cmake', ['--build', build, '--config', 'Release', '--target', 'whisper-cli', '-j'], { stdio: 'inherit' });

  mkdirSync(join(process.cwd(), 'resources'), { recursive: true });
  copyFileSync(join(build, 'bin', 'whisper-cli'), OUT);
  chmodSync(OUT, 0o755);
  console.log(`[fetch-whisper] wrote ${OUT}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
```

- [ ] **Step 3: Ignore `resources/`**

Append to `.gitignore` (after the `.vite/` line):

```
resources/
```

- [ ] **Step 4: Wire the script into `postinstall`**

In `package.json`, change:

```json
    "postinstall": "electron-builder install-app-deps",
```

to:

```json
    "postinstall": "electron-builder install-app-deps && node scripts/fetch-whisper.mjs",
```

- [ ] **Step 5: Bundle the binary in the packaged app**

In `electron-builder.yml`, add a top-level key (sibling of `files:` and `mac:`):

```yaml
extraResources:
  - from: resources/whisper-cli
    to: whisper-cli
```

- [ ] **Step 6: Build the binary and verify it runs**

Run: `node scripts/fetch-whisper.mjs`
Expected: clones, configures, builds, prints `[fetch-whisper] wrote .../resources/whisper-cli`.

Run: `./resources/whisper-cli --help`
Expected: whisper.cpp usage text listing `-m`, `-f`, `-nt`, `-np` (or `--no-prints`). **If `-np` is absent in this version, note the actual "quiet"/"no extra output" flag — Task 4's `whisperArgs` and its test must match what this binary accepts.**

- [ ] **Step 7: Verify it survives packaging**

Run: `npm run package`
Run: `test -x release/mac-arm64/SmartLife.app/Contents/Resources/whisper-cli && echo OK`
Expected: `OK`. (Path may be `release/mac/...` depending on the electron-builder version — adjust the check to whatever `npm run package` produced.)

- [ ] **Step 8: Lint**

Run: `npm run lint`
Expected: passes (the Step 1 eslint block covers the new script).

- [ ] **Step 9: Commit**

```bash
git add scripts/fetch-whisper.mjs .gitignore package.json electron-builder.yml eslint.config.mjs
git commit -m "Build and bundle the whisper.cpp CLI for local voice transcription"
```

---

### Task 2: `whisperPaths.ts` — binary path, model path, model URL

**Files:**
- Create: `src/main/ai/voice/whisperPaths.ts`
- Test: `src/main/ai/voice/whisperPaths.test.ts`

**Interfaces:**
- Consumes: `electron`'s `app` (`isPackaged`, `getAppPath`, `getPath`), `process.resourcesPath`.
- Produces:
  - `WHISPER_MODEL_URL: string`
  - `WHISPER_MODEL_FILENAME: string` (`'ggml-base.en.bin'`)
  - `whisperBinPath(): string`
  - `whisperModelPath(): string`

- [ ] **Step 1: Write the failing test**

Create `src/main/ai/voice/whisperPaths.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = { isPackaged: false };

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.isPackaged;
    },
    getAppPath: () => '/repo',
    getPath: (name: string) => `/userdata/${name}`,
  },
}));

const ORIGINAL_RESOURCES_PATH = process.resourcesPath;

beforeEach(() => {
  state.isPackaged = false;
  Object.defineProperty(process, 'resourcesPath', { value: '/app/Contents/Resources', configurable: true });
});

afterEach(() => {
  vi.resetModules();
  Object.defineProperty(process, 'resourcesPath', { value: ORIGINAL_RESOURCES_PATH, configurable: true });
});

describe('whisperPaths', () => {
  it('resolves the binary from the repo resources/ dir in development', async () => {
    const { whisperBinPath } = await import('./whisperPaths');
    expect(whisperBinPath()).toBe('/repo/resources/whisper-cli');
  });

  it('resolves the binary from process.resourcesPath in a packaged app', async () => {
    state.isPackaged = true;
    const { whisperBinPath } = await import('./whisperPaths');
    expect(whisperBinPath()).toBe('/app/Contents/Resources/whisper-cli');
  });

  it('puts the model under userData/models/', async () => {
    const { whisperModelPath } = await import('./whisperPaths');
    expect(whisperModelPath()).toBe('/userdata/userData/models/ggml-base.en.bin');
  });

  it('points the model URL at the ggml base.en weights', async () => {
    const { WHISPER_MODEL_URL } = await import('./whisperPaths');
    expect(WHISPER_MODEL_URL).toBe(
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/main/ai/voice/whisperPaths.test.ts`
Expected: FAIL — `Cannot find module './whisperPaths'`.

- [ ] **Step 3: Write the implementation**

Create `src/main/ai/voice/whisperPaths.ts`:

```ts
import { app } from 'electron';
import { join } from 'node:path';

export const WHISPER_MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

export const WHISPER_MODEL_FILENAME = 'ggml-base.en.bin';

/** The bundled whisper.cpp CLI. Dev: the repo's resources/. Packaged:
 *  electron-builder's extraResources drops it under process.resourcesPath. */
export function whisperBinPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'whisper-cli');
  return join(app.getAppPath(), 'resources', 'whisper-cli');
}

/** Runtime-downloaded (see whisperModel.ts) — never bundled. */
export function whisperModelPath(): string {
  return join(app.getPath('userData'), 'models', WHISPER_MODEL_FILENAME);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/main/ai/voice/whisperPaths.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/voice/whisperPaths.ts src/main/ai/voice/whisperPaths.test.ts
git commit -m "Add whisperPaths: resolve the whisper-cli binary and model locations"
```

---

### Task 3: `whisperModel.ts` — first-use model download

**Files:**
- Create: `src/main/ai/voice/whisperModel.ts`
- Test: `src/main/ai/voice/whisperModel.test.ts`

**Interfaces:**
- Consumes: `whisperModelPath()`, `WHISPER_MODEL_URL` from Task 2; global `fetch`; `node:fs`, `node:fs/promises`, `node:stream`, `node:stream/promises`.
- Produces: `type ModelStatus = 'ready' | 'downloading' | 'error'` and `ensureWhisperModel(): Promise<ModelStatus>`.

Semantics: `'ready'` when the file is on disk and non-empty. Otherwise the first caller starts a background download and gets `'downloading'` (it does **not** block on completion). Concurrent callers while a download is in flight also get `'downloading'` and never start a second download. If the last download attempt failed, the next call returns `'error'` once (clearing the flag), then subsequent calls retry from scratch.

- [ ] **Step 1: Write the failing test**

Create `src/main/ai/voice/whisperModel.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./whisperPaths', () => ({
  WHISPER_MODEL_URL: 'https://example.test/ggml-base.en.bin',
  whisperModelPath: () => '/userdata/models/ggml-base.en.bin',
}));

const stat = vi.fn();
const mkdir = vi.fn().mockResolvedValue(undefined);
const rm = vi.fn().mockResolvedValue(undefined);
const rename = vi.fn().mockResolvedValue(undefined);
vi.mock('node:fs/promises', () => ({
  stat: (...a: unknown[]) => stat(...a),
  mkdir: (...a: unknown[]) => mkdir(...a),
  rm: (...a: unknown[]) => rm(...a),
  rename: (...a: unknown[]) => rename(...a),
}));

const createWriteStream = vi.fn(() => ({ __isFakeWritable: true }));
vi.mock('node:fs', () => ({ createWriteStream: (...a: unknown[]) => createWriteStream(...a) }));

const pipeline = vi.fn().mockResolvedValue(undefined);
vi.mock('node:stream/promises', () => ({ pipeline: (...a: unknown[]) => pipeline(...a) }));

vi.mock('node:stream', () => ({ Readable: { fromWeb: (b: unknown) => ({ __webStream: b }) } }));

function fileMissing(): void {
  stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
}
function filePresent(): void {
  stat.mockResolvedValue({ isFile: () => true, size: 142_000_000 });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  pipeline.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: {} }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ensureWhisperModel', () => {
  it("returns 'ready' without fetching when the model file exists", async () => {
    filePresent();
    const { ensureWhisperModel } = await import('./whisperModel');
    await expect(ensureWhisperModel()).resolves.toBe('ready');
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 'downloading' and starts exactly one download when the file is missing", async () => {
    fileMissing();
    const { ensureWhisperModel } = await import('./whisperModel');
    await expect(ensureWhisperModel()).resolves.toBe('downloading');
    await expect(ensureWhisperModel()).resolves.toBe('downloading');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(mkdir).toHaveBeenCalledWith('/userdata/models', { recursive: true });
  });

  it("writes to a .partial file and renames it into place on success", async () => {
    fileMissing();
    const { ensureWhisperModel } = await import('./whisperModel');
    await ensureWhisperModel();
    await vi.waitFor(() => expect(rename).toHaveBeenCalled());
    expect(createWriteStream).toHaveBeenCalledWith('/userdata/models/ggml-base.en.bin.partial');
    expect(rename).toHaveBeenCalledWith(
      '/userdata/models/ggml-base.en.bin.partial',
      '/userdata/models/ggml-base.en.bin',
    );
  });

  it("removes the .partial file and later returns 'error' when the download fails", async () => {
    fileMissing();
    pipeline.mockRejectedValue(new Error('socket hang up'));
    const { ensureWhisperModel } = await import('./whisperModel');

    expect(await ensureWhisperModel()).toBe('downloading');
    await vi.waitFor(() => expect(rm).toHaveBeenCalledWith('/userdata/models/ggml-base.en.bin.partial', { force: true }));

    // Poll: the download promise's .catch (sets lastFailed) and .finally
    // (clears inFlight) run a few microtasks after rm; until both settle
    // the call still reports 'downloading'. waitFor stops on the first
    // non-throwing run, and the inFlight guard means these polls start no
    // extra download.
    await vi.waitFor(async () => {
      expect(await ensureWhisperModel()).toBe('error');
    });
    // flag cleared by that successful call: the next one retries afresh
    expect(await ensureWhisperModel()).toBe('downloading');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("returns 'error' when fetch resolves non-ok", async () => {
    fileMissing();
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 503, body: null });
    const { ensureWhisperModel } = await import('./whisperModel');

    expect(await ensureWhisperModel()).toBe('downloading');
    await vi.waitFor(() => expect(rm).toHaveBeenCalled());
    await vi.waitFor(async () => {
      expect(await ensureWhisperModel()).toBe('error');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/main/ai/voice/whisperModel.test.ts`
Expected: FAIL — `Cannot find module './whisperModel'`.

- [ ] **Step 3: Write the implementation**

Create `src/main/ai/voice/whisperModel.ts`:

```ts
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WHISPER_MODEL_URL, whisperModelPath } from './whisperPaths';

export type ModelStatus = 'ready' | 'downloading' | 'error';

let inFlight: Promise<void> | null = null;
let lastFailed = false;

async function fileReady(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

async function download(): Promise<void> {
  const dest = whisperModelPath();
  const partial = `${dest}.partial`;
  await mkdir(dirname(dest), { recursive: true });
  try {
    const res = await fetch(WHISPER_MODEL_URL);
    if (!res.ok || !res.body) throw new Error(`model download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
    await rename(partial, dest);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
}

/** See whisperModel semantics in the plan/spec. Non-blocking: the caller
 *  that starts the download gets 'downloading', shows a status line, and
 *  the user retries once the file lands. */
export async function ensureWhisperModel(): Promise<ModelStatus> {
  if (await fileReady(whisperModelPath())) {
    lastFailed = false;
    return 'ready';
  }
  if (inFlight) return 'downloading';
  if (lastFailed) {
    lastFailed = false;
    return 'error';
  }
  inFlight = download()
    .catch(() => {
      lastFailed = true;
    })
    .finally(() => {
      inFlight = null;
    });
  return 'downloading';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/main/ai/voice/whisperModel.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both pass. (`Readable.fromWeb` types: if `@types/node` complains about the `ReadableStream` argument, cast at the call site — `Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0])` — rather than loosening the function.)

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/voice/whisperModel.ts src/main/ai/voice/whisperModel.test.ts
git commit -m "Add ensureWhisperModel: one-time first-use download of the base.en weights"
```

---

### Task 4: Rewrite `transcribe.ts` to run `whisper-cli`

**Files:**
- Rewrite: `src/main/ai/voice/transcribe.ts`
- Rewrite: `src/main/ai/voice/transcribe.test.ts`

**Interfaces:**
- Consumes: `ensureWhisperModel` (Task 3); `whisperBinPath`, `whisperModelPath` (Task 2); `node:child_process` `execFile`; `node:fs/promises` `mkdtemp`/`writeFile`/`rm`; `node:os` `tmpdir`.
- Produces (unchanged signature):
  - `type TranscribeAudioResult = { ok: true; text: string } | { ok: false; reason: string }`
  - `transcribeAudio(_db: Database.Database, data: string, mimeType: string): Promise<TranscribeAudioResult>`
  - `whisperArgs(modelPath: string, wavPath: string): string[]`

Note: uses `os.tmpdir()` + `mkdtemp` for the scratch WAV (a unique dir, removed with one `rm -rf`) rather than `app.getPath('temp')` — same system temp location, no `electron` mock needed here, simpler cleanup. `_db` is retained unused so `ai/ipc.ts` and its tests don't change.

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `src/main/ai/voice/transcribe.test.ts` with:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

const execFile = vi.fn();
vi.mock('node:child_process', () => ({ execFile: (...a: unknown[]) => execFile(...a) }));

const ensureWhisperModel = vi.fn();
vi.mock('./whisperModel', () => ({ ensureWhisperModel: () => ensureWhisperModel() }));

vi.mock('./whisperPaths', () => ({
  whisperBinPath: () => '/bin/whisper-cli',
  whisperModelPath: () => '/models/ggml-base.en.bin',
}));

const mkdtemp = vi.fn().mockResolvedValue('/tmp/smartlife-voice-abc');
const writeFile = vi.fn().mockResolvedValue(undefined);
const rm = vi.fn().mockResolvedValue(undefined);
vi.mock('node:fs/promises', () => ({
  mkdtemp: (...a: unknown[]) => mkdtemp(...a),
  writeFile: (...a: unknown[]) => writeFile(...a),
  rm: (...a: unknown[]) => rm(...a),
}));

// promisify(execFile) calls execFile(file, args, opts, cb). Drive cb from the
// queued result so the production code can stay on the promise form.
function execFileYields(result: { stdout?: string; error?: Error & { stderr?: string } }): void {
  execFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (e: unknown, r?: unknown) => void) => {
    if (result.error) cb(result.error);
    else cb(null, { stdout: result.stdout ?? '', stderr: '' });
  });
}

const db = {} as Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  ensureWhisperModel.mockResolvedValue('ready');
  execFileYields({ stdout: 'hello there' });
});

afterEach(() => {
  vi.resetModules();
});

describe('transcribeAudio', () => {
  it('rejects a non-WAV mime type without touching the model or the binary', async () => {
    const { transcribeAudio } = await import('./transcribe');
    const result = await transcribeAudio(db, 'base64', 'audio/webm');
    expect(result).toEqual({ ok: false, reason: 'Unsupported audio format.' });
    expect(ensureWhisperModel).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("returns the setup message and does not run whisper while the model is downloading", async () => {
    ensureWhisperModel.mockResolvedValue('downloading');
    const { transcribeAudio } = await import('./transcribe');
    const result = await transcribeAudio(db, 'base64', 'audio/wav');
    expect(result).toEqual({ ok: false, reason: 'Setting up voice (one-time, ~140 MB download)…' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns a download-failed message when the model could not be fetched', async () => {
    ensureWhisperModel.mockResolvedValue('error');
    const { transcribeAudio } = await import('./transcribe');
    const result = await transcribeAudio(db, 'base64', 'audio/wav');
    expect(result).toEqual({
      ok: false,
      reason: "Couldn't download the voice model. Check your connection and try again.",
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('writes the decoded WAV to a temp file, runs whisper-cli, and returns the trimmed transcript', async () => {
    execFileYields({ stdout: '  hello   there \n' });
    const { transcribeAudio, whisperArgs } = await import('./transcribe');
    const result = await transcribeAudio(db, Buffer.from('wavbytes').toString('base64'), 'audio/wav');

    expect(result).toEqual({ ok: true, text: 'hello there' });
    expect(writeFile).toHaveBeenCalledWith('/tmp/smartlife-voice-abc/audio.wav', expect.any(Buffer));
    expect(execFile).toHaveBeenCalledWith(
      '/bin/whisper-cli',
      whisperArgs('/models/ggml-base.en.bin', '/tmp/smartlife-voice-abc/audio.wav'),
      expect.objectContaining({ timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }),
      expect.any(Function),
    );
  });

  it('reports an empty transcript as "couldn\'t hear anything"', async () => {
    execFileYields({ stdout: '   \n  ' });
    const { transcribeAudio } = await import('./transcribe');
    const result = await transcribeAudio(db, 'base64', 'audio/wav');
    expect(result).toEqual({ ok: false, reason: "Couldn't hear anything in that recording." });
  });

  it('returns a failure with the stderr tail when whisper-cli exits non-zero', async () => {
    execFileYields({ error: Object.assign(new Error('exit 1'), { stderr: 'whisper: init\nfailed to load model\n' }) });
    const { transcribeAudio } = await import('./transcribe');
    const result = await transcribeAudio(db, 'base64', 'audio/wav');
    expect(result).toEqual({ ok: false, reason: 'Voice transcription failed: failed to load model' });
  });

  it('removes the temp dir on success and on failure', async () => {
    const { transcribeAudio } = await import('./transcribe');
    await transcribeAudio(db, 'base64', 'audio/wav');
    expect(rm).toHaveBeenCalledWith('/tmp/smartlife-voice-abc', { recursive: true, force: true });

    rm.mockClear();
    execFileYields({ error: new Error('boom') });
    await transcribeAudio(db, 'base64', 'audio/wav');
    expect(rm).toHaveBeenCalledWith('/tmp/smartlife-voice-abc', { recursive: true, force: true });
  });

  describe('whisperArgs', () => {
    it('pins the flag list', async () => {
      const { whisperArgs } = await import('./transcribe');
      expect(whisperArgs('/m/model.bin', '/t/a.wav')).toEqual([
        '-m', '/m/model.bin', '-f', '/t/a.wav', '-np', '-nt',
      ]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/main/ai/voice/transcribe.test.ts`
Expected: FAIL — the current `transcribe.ts` still imports `@google/genai` and has no `whisperArgs` export; assertions error.

- [ ] **Step 3: Write the implementation**

Replace the entire contents of `src/main/ai/voice/transcribe.ts` with:

```ts
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { ensureWhisperModel } from './whisperModel';
import { whisperBinPath, whisperModelPath } from './whisperPaths';

const run = promisify(execFile);

export type TranscribeAudioResult = { ok: true; text: string } | { ok: false; reason: string };

/** The whisper.cpp CLI arguments. `-np` silences everything but the result,
 *  `-nt` drops timestamps, so stdout is the bare transcript. Pinned by test. */
export function whisperArgs(modelPath: string, wavPath: string): string[] {
  return ['-m', modelPath, '-f', wavPath, '-np', '-nt'];
}

/**
 * On-device transcription via the bundled whisper.cpp CLI -- no API key, no
 * network after the one-time model download. The transcribed text re-enters
 * handleSendMessage exactly like a typed message.
 *
 * `_db` is unused (kept so ai/ipc.ts's handler signature doesn't change).
 */
export async function transcribeAudio(
  _db: Database.Database,
  data: string,
  mimeType: string,
): Promise<TranscribeAudioResult> {
  if (mimeType !== 'audio/wav') {
    return { ok: false, reason: 'Unsupported audio format.' };
  }

  const model = await ensureWhisperModel();
  if (model === 'downloading') {
    return { ok: false, reason: 'Setting up voice (one-time, ~140 MB download)…' };
  }
  if (model === 'error') {
    return { ok: false, reason: "Couldn't download the voice model. Check your connection and try again." };
  }

  const dir = await mkdtemp(join(tmpdir(), 'smartlife-voice-'));
  const wavPath = join(dir, 'audio.wav');
  try {
    await writeFile(wavPath, Buffer.from(data, 'base64'));
    const { stdout } = await run(whisperBinPath(), whisperArgs(whisperModelPath(), wavPath), {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const text = stdout.replace(/\s+/g, ' ').trim();
    if (!text) return { ok: false, reason: "Couldn't hear anything in that recording." };
    return { ok: true, text };
  } catch (err) {
    const stderrTail = (err as { stderr?: string }).stderr?.trim().split('\n').pop()?.trim();
    return {
      ok: false,
      reason: stderrTail ? `Voice transcription failed: ${stderrTail}` : 'Voice transcription failed.',
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/main/ai/voice/transcribe.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Full suite, lint, typecheck**

Run: `npm test`
Expected: PASS — in particular `src/main/ai/ipc.test.ts` still passes untouched (the handler signature is unchanged).
Run: `npm run lint && npm run typecheck`
Expected: both pass. `@google/genai` is now unused by this file; leave the dependency in `package.json` (still used by the Gemini chat provider — confirm with `grep -rn "@google/genai" src`).

- [ ] **Step 6: Commit**

```bash
git add src/main/ai/voice/transcribe.ts src/main/ai/voice/transcribe.test.ts
git commit -m "Transcribe voice on-device with whisper-cli instead of the Gemini API"
```

---

### Task 5: Record at 16 kHz in `useVoice.ts`

**Files:**
- Modify: `src/renderer/src/ai/useVoice.ts` (one line, in `startRecording`)
- Modify: `src/renderer/src/ai/useVoice.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no API change. The WAV sent over IPC is now 16 kHz mono, which is what Task 4's `whisper-cli` requires.

- [ ] **Step 1: Update the test's fake `AudioContext` and add the 16 kHz assertions**

In `src/renderer/src/ai/useVoice.test.ts`:

Replace the `FakeAudioContext` class with one that records its constructor options and honors `sampleRate`:

```ts
const audioContextOptions: Array<{ sampleRate?: number } | undefined> = [];

class FakeAudioContext {
  sampleRate: number;
  destination = {};
  close = vi.fn().mockResolvedValue(undefined);
  createMediaStreamSource = vi.fn(() => new FakeMediaStreamAudioSourceNode());
  createScriptProcessor = vi.fn(() => {
    const node = new FakeScriptProcessorNode();
    createdProcessors.push(node);
    return node;
  });
  createGain = vi.fn(() => new FakeGainNode());
  constructor(options?: { sampleRate?: number }) {
    audioContextOptions.push(options);
    this.sampleRate = options?.sampleRate ?? 48000;
  }
}
```

In `beforeEach`, add after `createdProcessors.length = 0;`:

```ts
  audioContextOptions.length = 0;
```

In the existing test **"encodes captured audio samples into a correct WAV header and PCM data"**, change the sample-rate assertion:

```ts
    expect(view.getUint32(24, true)).toBe(16000); // the 16 kHz recording rate Whisper requires
```

Add a new test inside the `describe('useVoice — recording and transcription', ...)` block:

```ts
  it('creates the recording AudioContext at 16 kHz (whisper.cpp requires it)', async () => {
    ai.transcribeAudio.mockResolvedValue({ ok: true, text: 'ok' });
    const { result } = renderHook(() => useVoice({ messages: [], sending: false, sendMessage: vi.fn() }));

    await act(async () => {
      await result.current.toggleRecording();
    });

    expect(audioContextOptions.at(-1)).toEqual({ sampleRate: 16000 });
  });
```

- [ ] **Step 2: Run tests to verify the new expectations fail**

Run: `npm test -- src/renderer/src/ai/useVoice.test.ts`
Expected: FAIL — the new test sees `undefined` (current code calls `new AudioContext()` with no args) and the WAV-header test now expects `16000` but gets `48000`.

- [ ] **Step 3: Make the one-line change in `useVoice.ts`**

In `src/renderer/src/ai/useVoice.ts`, inside `startRecording`, change:

```ts
      const audioContext = new AudioContext();
```

to:

```ts
      // whisper.cpp only accepts 16 kHz mono; record at that rate so no
      // resampling is needed anywhere. encodeWav already reads the rate off
      // this context.
      const audioContext = new AudioContext({ sampleRate: 16000 });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/renderer/src/ai/useVoice.test.ts`
Expected: PASS (all existing tests plus the new one).

- [ ] **Step 5: Full suite, lint, typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/ai/useVoice.ts src/renderer/src/ai/useVoice.test.ts
git commit -m "Record voice input at 16 kHz for local whisper.cpp"
```

---

## Manual verification (after all tasks)

Not a substitute for the packaged-build check in Task 1, Step 7.

1. `npm run dev`, open the AI dock, toggle voice mode, press the mic.
2. First press with no model yet: the input area shows "Setting up voice (one-time, ~140 MB download)…". Wait for the file to appear at `~/Library/Application Support/SmartLife/models/ggml-base.en.bin`.
3. Press the mic again, say a sentence, press stop. The transcript appears as a sent message and (voice mode on) the reply is spoken.
4. Airplane mode → repeat step 3 → still works (fully offline once the model is present).
5. Confirm no Gemini key is configured and transcription still works.

---

## Self-Review

**1. Spec coverage**

| Spec item | Task |
|---|---|
| Replace only `transcribe.ts` guts; signature unchanged | 4 |
| `whisper-cli` as a subprocess, not a native addon | 1, 4 |
| Bundle binary via `extraResources`; git-ignored `resources/`; `postinstall` fetch | 1 |
| 16 kHz recording (`new AudioContext({ sampleRate: 16000 })`) | 5 |
| `whisperPaths` — dev vs packaged binary, model under `userData/models/`, `WHISPER_MODEL_URL` | 2 |
| `ensureWhisperModel` — ready/downloading/error, concurrency guard, `.partial` cleanup | 3 |
| `whisperArgs` pure + own test | 4 |
| mime check → "Unsupported audio format." | 4 |
| model downloading → "Setting up voice…" | 4 |
| download failed → "Couldn't download the voice model…" | 3 (status), 4 (message) |
| empty transcript → existing "Couldn't hear anything…" copy | 4 |
| `whisper-cli` missing/non-zero/timeout → "Voice transcription failed." + stderr tail | 4 |
| `execFile`, no shell, fixed args, timeout, maxBuffer | 4 |
| Temp WAV cleaned up every branch | 4 |
| No test spawns a real process or hits the network | 2, 3, 4 |
| Gemini untouched as chat provider | (no task modifies `providerConfig.ts`; verified in Task 4 Step 5) |
| TTS / mic button / voice-mode toggle / IPC / preload untouched | (only Task 5's one line touches the renderer) |
| Packaging verified against a real build | 1 Step 7 |

No gaps.

**2. Placeholder scan**

Two intentional "verify against the real binary" notes — Task 1 Step 6 (`-np` flag name) and the `WHISPER_CPP_REF` tag in `fetch-whisper.mjs`. These are external facts that cannot be pinned from inside the repo; both have a concrete default and an explicit check, and every downstream step (`whisperArgs` + its test) is fully specified for the default. Not placeholders. No "TODO"/"add error handling"/"similar to Task N" anywhere.

**3. Type consistency**

- `ModelStatus` = `'ready' | 'downloading' | 'error'` — defined in Task 3, consumed in Task 4 by string comparison against the same three literals. ✔
- `ensureWhisperModel(): Promise<ModelStatus>` — Task 3 produces, Task 4 mock (`vi.mock('./whisperModel')`) and call match. ✔
- `whisperBinPath()`, `whisperModelPath()` — Task 2 produces; Task 4 imports both and its mock returns `string` for each. ✔
- `whisperArgs(modelPath, wavPath): string[]` — defined and consumed within Task 4; the test imports it and compares with `.toEqual`. ✔
- `transcribeAudio(_db, data, mimeType)` — unchanged from the current signature; `ai/ipc.ts` (`transcribeAudio(db, data, mimeType)`) needs no edit. ✔
- `WHISPER_MODEL_URL` string literal is identical in Task 2's impl, Task 2's test, and Task 3's mock. ✔

No inconsistencies found.
