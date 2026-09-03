# Local Whisper Voice Transcription — Design

**Status:** Approved (engine and model-acquisition choices confirmed with the
user directly; open for revision on review), ready for planning.

## Motivation

Voice input (Phase 8e) currently transcribes by sending recorded audio to
Google Gemini (`gemini-2.5-flash`). That requires a paid Gemini API key. The
user does not want to pay for an API key to use "talk and speak," and wants
transcription to run locally instead. Text-to-speech already uses the
browser's built-in `speechSynthesis` (free) and is not changing.

This phase replaces **only** the transcription backend: audio is transcribed
on-device with `whisper.cpp`. No API key, no network calls for voice, no
per-use cost.

## Reversal of the Phase 8e decision

The Phase 8e spec explicitly rejected local `whisper.cpp` for three reasons.
Each is addressed here:

1. **App-size bloat (150–470 MB model).** The model (`ggml-base.en.bin`,
   ~142 MB) is **not** shipped in the app or installer. It downloads once, on
   first use, to `userData/models/`. The installer grows only by the ~2 MB
   `whisper-cli` binary.
2. **Native-binary packaging risk** ("bitten twice by native/ESM packaging
   gaps that passed tests but broke the packaged app"). This design uses a
   **standalone `whisper-cli` executable run as a subprocess**, not a native
   Node addon linked into Electron. There is no N-API module, no
   `node-gyp`/`electron-rebuild` step, no ABI coupling to Electron's Node
   version. The residual risk — bundling a plain executable via
   `extraResources`, marking it executable, arch matching, and (for a future
   notarized build) signing the nested binary — is real and is called out in
   Global Constraints as the item to verify against a **packaged** build, not
   just `electron-vite dev`.
3. **Weaker accuracy on course-specific vocabulary.** Accepted. `base.en` is
   good enough for conversational input; the transcript re-enters the chat as
   ordinary editable text and a misheard word is low-stakes (same rationale
   Phase 8e used for auto-sending the transcript).

## Decisions confirmed with the user before writing this spec

- **Engine:** bundled `whisper.cpp` (`whisper-cli` subprocess), local and
  offline. Two alternatives were considered and rejected: Apple's on-device
  `SFSpeechRecognizer` — rejected because it needs a separately authored,
  signed, notarized Swift helper binary plus a second OS permission
  ("Speech Recognition"), more moving parts than a self-contained Whisper
  binary; and the browser `webkitSpeechRecognition` API — rejected because
  Electron's bundled Chromium has no Google speech API key and the call
  typically fails with a `network` error (the same reason Phase 8e gave for
  not using `SpeechRecognition`).
- **Model:** `ggml-base.en.bin` (~142 MB, English-only).
- **Model acquisition:** downloaded on first mic use to
  `userData/models/ggml-base.en.bin`, with a one-time status message in the
  chat panel. Not bundled in the app.
- **Gemini:** stays a chat provider (its Settings key field is untouched); it
  is simply no longer called for transcription.
- **TTS:** unchanged (`window.speechSynthesis`).

## Global Constraints

- Tests run via `npm test` (sets `ELECTRON_RUN_AS_NODE=1`) — never
  `npx vitest run`.
- **Biggest technical risk:** the `whisper-cli` binary must be located and
  executed correctly from a **packaged** SmartLife build, not only from
  `electron-vite dev`. `extraResources` places it under
  `process.resourcesPath`; in dev it lives at `<repo>/resources/`. This must
  be verified against an actual `npm run package` build during
  implementation — this project has twice shipped native/packaging bugs that
  passed tests and dev but broke the packaged app.
- **16 kHz mono is mandatory.** `whisper.cpp` rejects any WAV that is not
  16 kHz mono. The renderer currently records at the `AudioContext` default
  (typically 48 kHz). It must record at 16 kHz — `new AudioContext({
  sampleRate: 16000 })` — so the existing `encodeWav` produces a
  Whisper-ready file with no resampling in the main process.
- Voice input still requires microphone permission and the existing
  `NSMicrophoneUsageDescription` (already present in `electron-builder.yml`
  and `Info.plist`). Nothing new is needed from the OS — `whisper-cli` reads
  a WAV file, it does not touch the microphone.
- First-use model download requires a network connection **once**. After
  that, voice works fully offline. A failed download is surfaced, not
  silently swallowed, and retried on the next mic press.
- `transcribeAudio`'s signature and result shape
  (`{ ok: true; text } | { ok: false; reason }`) do not change — the
  renderer, preload, and IPC channel are untouched except for the 16 kHz
  recording change.
- This is the first subprocess in the codebase (`node:child_process` is
  currently unused). The child is spawned with `execFile` (no shell), a
  fixed argument array, an absolute binary path, and a timeout.

## Architecture

### 1. Recording at 16 kHz (`src/renderer/src/ai/useVoice.ts`)

One change: construct the recording context as
`new AudioContext({ sampleRate: 16000 })` instead of `new AudioContext()`.
`encodeWav(merged, sampleRate)` already takes the rate from
`session.audioContext.sampleRate`, so it then writes a 16 kHz mono 16-bit
PCM WAV with no other change. The `ScriptProcessorNode` path is kept as-is
(deprecated but working; not rewriting to `AudioWorklet` in this phase).

macOS Chromium honors a 16 kHz `AudioContext`, so there is no resampling
anywhere — not in the renderer beyond this constructor argument, and not in
the main process. If the context constructor throws (not expected on the
supported platform), `startRecording`'s existing `catch` surfaces the
current "Could not access the microphone" error; no fallback rate path is
built.

### 2. Model + binary resolution (`src/main/ai/voice/whisperPaths.ts`, new)

```ts
export function whisperBinPath(): string;   // resources/whisper-cli (dev) | <resourcesPath>/whisper-cli (packaged)
export function whisperModelPath(): string;  // join(app.getPath('userData'), 'models', 'ggml-base.en.bin')
export const WHISPER_MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';
```

`whisperBinPath` picks the dev vs packaged location off
`app.isPackaged` / `process.resourcesPath`. Pure path logic, unit-tested.

### 3. Transcription (`src/main/ai/voice/transcribe.ts`, rewritten)

```ts
export async function transcribeAudio(
  db: Database.Database,   // kept for signature compatibility; no longer read
  data: string,            // base64 WAV
  mimeType: string,        // must be 'audio/wav'
): Promise<{ ok: true; text: string } | { ok: false; reason: string }>
```

Flow:

1. If `mimeType !== 'audio/wav'` → `{ ok: false, reason: 'Unsupported audio
   format.' }` (defensive; the renderer only ever sends WAV).
2. If the model file is absent → kick off the download (§4) and return
   `{ ok: false, reason: 'Setting up voice (one-time, ~140 MB download)…' }`.
   The renderer shows this as a status line, not a hard error, and the user
   presses the mic again once it finishes.
3. Write the decoded WAV bytes to a temp file under `app.getPath('temp')`
   (`smartlife-voice-<random>.wav`).
4. `execFile(whisperBinPath(), whisperArgs(modelPath, wavPath), { timeout:
   120_000, maxBuffer: 8 * 1024 * 1024 })`.
5. On exit 0: read stdout, trim, collapse internal whitespace →
   `{ ok: true, text }`. Empty output → `{ ok: false, reason: "Couldn't hear
   anything in that recording." }`.
6. On non-zero exit, spawn error, or timeout → `{ ok: false, reason: 'Voice
   transcription failed.' }` with the last line of stderr appended when
   present.
7. `finally`: unlink the temp WAV.

```ts
export function whisperArgs(modelPath: string, wavPath: string): string[] {
  return ['-m', modelPath, '-f', wavPath, '-np', '-nt', '-l', 'en'];
}
```

`-np` suppresses progress output, `-nt` drops timestamps so stdout is plain
transcript text, `-l en` pins the language. `whisperArgs` is a pure function
with its own unit test so the exact flag list is pinned.

### 4. First-use model download (`src/main/ai/voice/whisperModel.ts`, new)

```ts
export function ensureWhisperModel(): Promise<'ready' | 'downloading' | 'error'>;
```

- If the file exists and is non-empty → `'ready'`.
- If a download is already in progress → `'downloading'` (a module-level
  promise guards against concurrent mic presses starting two downloads).
- Otherwise start streaming `WHISPER_MODEL_URL` to
  `<model>.partial`, `rename` to the final name on completion, resolve
  `'downloading'` for this call (the current press does not block on the
  full download).
- Network/write failure → delete the partial file, return `'error'`.

No progress bar in this phase — a single status line ("Setting up voice…")
is enough. A percentage indicator is a possible follow-up, not a blocker.

### 5. Packaging (`electron-builder.yml`)

Add:

```yaml
extraResources:
  - from: resources/whisper-cli
    to: whisper-cli
```

`resources/whisper-cli` is git-ignored. A `scripts/fetch-whisper.mjs` run
from `postinstall` downloads the pinned-version `whisper-cli` arm64 binary
into `resources/` and `chmod +x` it, so a fresh `npm install` is the only
setup step. The script no-ops if the binary is already present.

The model is **not** listed in `extraResources` — it is runtime-downloaded
per §4.

## Error handling summary

| Situation | User sees |
|---|---|
| Model not downloaded yet | "Setting up voice (one-time, ~140 MB download)…", auto-clears; press mic again when ready |
| Model download failed | "Couldn't download the voice model. Check your connection and try again." |
| Empty / silent recording | "Couldn't hear anything in that recording." (unchanged copy) |
| `whisper-cli` missing / exits non-zero / times out | "Voice transcription failed." + last stderr line |
| Non-WAV mime type | "Unsupported audio format." |

All are returned as `{ ok: false, reason }` and rendered in the existing
`voiceError` slot in `ChatPanel.tsx` — no throwing, matching the current
pattern.

## Testing

Matches the project's existing `transcribe.test.ts` style (mock `electron`,
mock the boundary, assert result shapes).

- **`transcribe.test.ts`** (rewritten): mock `node:child_process`'s
  `execFile` and the `whisperModel` / `whisperPaths` modules.
  - model absent → returns the "Setting up voice…" result and does **not**
    call `execFile`; calls `ensureWhisperModel` once.
  - model present, `execFile` yields stdout `"hello there"` → `{ ok: true,
    text: 'hello there' }`; asserts it was called with
    `whisperArgs(modelPath, <tmp wav>)`.
  - `execFile` yields empty stdout → `{ ok: false, reason: "Couldn't hear
    anything in that recording." }`.
  - `execFile` rejects (non-zero exit with stderr) → `{ ok: false }` with
    the stderr tail in `reason`.
  - `mimeType: 'audio/webm'` → `{ ok: false, reason: 'Unsupported audio
    format.' }`, no `execFile` call.
  - temp WAV is unlinked in every branch (assert via the `fs` mock).
- **`whisperArgs.test.ts`** (new, or a `describe` block in
  `transcribe.test.ts`): exact array for given paths.
- **`whisperPaths.test.ts`** (new): dev vs packaged binary path off a
  mocked `app.isPackaged` / `process.resourcesPath`; model path under a
  mocked `userData`.
- **`whisperModel.test.ts`** (new): file exists → `'ready'`; concurrent
  calls share one in-flight download (only one fetch); fetch failure →
  `'error'` and the `.partial` file is removed.
- **`useVoice.test.ts`**: assert the recording `AudioContext` is created
  with `{ sampleRate: 16000 }` (extend the existing mock).
- No test starts a real subprocess or hits the network.

## As-built notes (deviations from the sketch above, all reviewed)

- `whisperArgs` ships `['-m', m, '-f', w, '-np', '-nt']` — **no `-l en`**. `ggml-base.en.bin`
  is English-only, so whisper.cpp fixes the language regardless; the flag was noise.
- The scratch WAV goes in an `os.mkdtemp()` dir (mode 0700, removed with one `rm -rf` in a
  guarded `finally`), not `app.getPath('temp')/smartlife-voice-<random>.wav` — a private dir
  beats a guessable name in a world-readable location, and needs no `electron` mock in tests.
- `transcribeAudio` strips bracketed non-speech markers (`[BLANK_AUDIO]`, `[MUSIC]`,
  `[ Silence ]`) from stdout before the empty-transcript check — with `-nt`, whisper.cpp emits
  those as ordinary lines, so without stripping a silent clip would be *sent* as `[BLANK_AUDIO]`.
- `whisperModel.download()` sanity-checks the downloaded file (≥ 1 MB, and equal to
  `content-length` when the header is present) before `rename` — a captive-portal HTTP 200 that
  returns an HTML login page instead of the weights would otherwise be committed as "the model".
- Download failures (`voice:model-download`) and transcription errors (`voice:transcribe`) are
  written to `smartlife.log` via the existing `logError` helper rather than swallowed.

- Any change to text-to-speech, the mic button, the voice-mode toggle, IPC,
  or preload beyond what §1 requires.
- Removing Gemini as a chat provider or touching its Settings key field.
- A download progress percentage / cancel button (single status line only).
- Model choice beyond `base.en` (no `tiny`/`small`/multilingual selector).
- Silence-based auto-stop, barge-in, streaming transcription — all already
  deferred by Phase 8e and still deferred.
- The separate, unrelated "browser isn't working in SmartLife" issue the
  user raised — tracked for after this.
- Windows/Linux binaries for `whisper-cli` (the app ships macOS-only today;
  `fetch-whisper.mjs` and `whisperBinPath` are written so a second arch can
  be added later without redesign).
