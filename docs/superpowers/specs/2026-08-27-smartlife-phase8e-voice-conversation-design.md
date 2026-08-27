# Phase 8e: Voice Conversation — Design

**Status:** Approved (voice-input architecture confirmed with the user directly; remaining defaults chosen per their standing authorization; open for revision on review), ready for planning.

## Motivation

The user wants to talk to the assistant instead of typing, and have it talk back — a real back-and-forth voice conversation, not one-shot dictation. This phase adds speech-to-text input and text-to-speech output to the existing chat dock.

## Decisions confirmed with the user before writing this spec

- **Speech-to-text:** record audio in the renderer and send it to Gemini for transcription (Gemini's API accepts inline audio input the same way it already accepts inline images — see Architecture §2). This only requires a working Gemini key; it does **not** make Gemini the conversation's answering provider — the transcribed text re-enters the normal flow and gets answered by whichever provider is actually active/ranked, same as if it had been typed. Two alternatives were explicitly considered and rejected: local on-device transcription (whisper.cpp) — rejected for app-size bloat (150-470MB model), native-binary packaging risk (this project has twice been bitten by native/ESM packaging gaps that passed tests but broke the real packaged app), and weaker accuracy on course-specific vocabulary; and the OpenAI Whisper API — rejected because it would require standing up real OpenAI API billing now, pulling forward a decision (OpenAI as a 4th provider) the user already deferred separately.
- **Text-to-speech:** the browser's built-in `speechSynthesis` API (macOS system voices via Chromium's TTS backend) — free, already available in Electron, no new dependency, no research needed.

## Global Constraints

- Tests run via `npm test` (sets `ELECTRON_RUN_AS_NODE=1`) — never `npx vitest run`.
- Gemini's exact audio-input wire format (accepted mime types, whether `MediaRecorder`'s default `audio/webm;codecs=opus` output is directly usable or needs a mime-type hint/conversion) must be verified against `@google/genai`'s current types and `ai.google.dev/gemini-api/docs/audio` at implementation time — not guessed. This is the single biggest technical risk in this phase and is called out explicitly rather than assumed away.
- Voice input requires a configured Gemini key. If none is configured, the mic control is disabled with an explanatory tooltip/message pointing at Settings — never a silent no-op, matching this project's existing pattern for every other capability gate (vision, web search).
- This phase is **turn-based** voice conversation, not full-duplex: press mic → speak → press again to stop → transcribe → send → assistant answers (streamed text, then spoken once complete) → press mic for your next turn. True barge-in (interrupting the assistant mid-speech by just talking) would need continuous mic streaming and voice-activity detection — a materially larger feature than what was asked for ("talk back to you and be able to conversate" is satisfied by fluid back-and-forth turns) and is explicitly deferred, not built partially.
- Recording stop is manual (click again), not silence-detected. Silence-based auto-stop needs a tuned amplitude threshold that behaves differently per microphone/room — exactly the kind of environment-dependent calibration knob to leave out of a first pass rather than guess a threshold for.
- macOS requires a microphone usage description before the OS permission prompt can appear at all; omitting it means `getUserMedia` fails silently with no prompt ever shown, not a soft degradation.
- Speaking assistant text aloud must strip markdown syntax first — reading `"**bold**"` or `"- item"` aloud verbatim (asterisks, dashes, hashes) would sound broken.

## Architecture

### 1. Voice mode as one toggle, not separate mic/speaker settings

A single "Voice mode" toggle button in `ChatPanel.tsx`'s header area. Off (default): today's behavior, completely unchanged — no mic control shown, no spoken output. On: a mic button appears next to "Attach" in the input row, and every assistant response is spoken aloud once its stream completes. One toggle instead of two independent switches because the user described this as a mode ("conversate"), not two orthogonal features.

### 2. Recording and transcription

Renderer (`useVoice.ts`, new hook, composed into `useConversation.ts`'s consumer the same way `useViewContext.ts` already is): `navigator.mediaDevices.getUserMedia({ audio: true })` + `MediaRecorder` — both standard Web APIs that work in Electron's renderer without any native dependency (unlike `SpeechRecognition`, which needs a Google-issued API key baked into the Chromium build that Electron's bundled Chromium doesn't have, and which this phase deliberately does not use). Recording start/stop is driven by the mic button; on stop, the recorded `Blob` is read as an `ArrayBuffer`, base64-encoded, and sent over a new IPC channel:

```ts
// preload
transcribeAudio(data: string, mimeType: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }>
```

Main process, new file `src/main/ai/voice/transcribe.ts`:

```ts
export async function transcribeAudio(
  db: Database.Database,
  data: string,      // base64
  mimeType: string
): Promise<{ ok: true; text: string } | { ok: false; reason: string }>
```

Constructs its own lightweight `GoogleGenAI` client from `getGeminiKey(db)` (same accessor `gemini.ts`'s `createGeminiProvider` already uses) — no shared client with the chat provider, since this call is a one-shot utility, not a `streamTurn`. Calls `generateContent` with a fast/cheap model (`gemini-2.5-flash`) and two parts: an `inlineData` part carrying the audio (`{ inlineData: { mimeType, data } }` — the exact same shape `gemini.ts`'s existing `attachmentsToParts` already uses for images, verified reusable for audio per the Global Constraints note above) and a text part instructing transcription only (e.g. "Transcribe this audio exactly. Output only the spoken words, nothing else."). Returns `{ ok: false, reason: ... }` for no Gemini key configured, an empty/silent recording, or any API error — mirroring `pickAttachment.ts`'s existing result-shape convention rather than throwing.

New IPC handler: `ai:transcribe-audio(data, mimeType)` → `transcribeAudio(db, data, mimeType)`.

On a successful transcription, the renderer feeds the returned text straight into the existing `sendMessage` flow (`useConversation.ts`) — auto-sent, not placed in the input box for manual review-then-send, matching natural conversational flow. A misheard word is low-stakes and easily corrected by saying the next thing, unlike the consequential actions this project already gates behind confirmation tiers.

### 3. Speaking responses aloud

New small utility, `src/renderer/src/ai/textForSpeech.ts`:

```ts
export function textForSpeech(markdown: string): string
// strips **bold**/*italic*/# headers/- and * bullet markers/`code` backticks;
// collapses resulting extra whitespace. Visible chat bubble text is untouched --
// this only affects what gets passed to speechSynthesis.
```

`useVoice.ts` listens for `turn-complete` stream events (already emitted by every provider today) while voice mode is on, and calls `window.speechSynthesis.speak(new SpeechSynthesisUtterance(textForSpeech(finalAssistantText)))` with the completed message's full text. If the user clicks the mic to start a new recording while speech is still playing, `speechSynthesis.cancel()` fires first — no overlapping audio, and no attempt at detecting interruption by voice (see Global Constraints).

### 4. System prompt awareness of voice mode

`buildSystemPrompt(db, view, now, voiceMode = false)` gains a 4th parameter. `ai:send-message`'s IPC handler and `handleSendMessage` thread a `voiceMode: boolean` through (set from the renderer's toggle state, sent alongside the existing `attachmentIds`/`conversationId`). When `true`, one extra line is appended to the prompt: "The user is in a voice conversation right now — your response will be read aloud. Keep it natural to speak: no markdown formatting, no code blocks, no bullet lists, and keep it reasonably concise." This does not change anything about *what* the assistant is allowed to do — only the shape of the reply it writes.

### 5. Microphone permission

`electron-builder.yml`'s `mac:` section gains:

```yaml
mac:
  extendInfo:
    NSMicrophoneUsageDescription: "SmartLife uses your microphone to let you talk to the AI assistant."
```

This is what makes the OS permission dialog appear at all the first time `getUserMedia` is called; without it, the call fails with no prompt shown to the user, not a soft degradation.

## UI

`ChatPanel.tsx`'s header gains a small "Voice mode" toggle (icon button, matches the existing header's visual weight). The input row, when voice mode is on, gains a mic button to the left of "Attach": idle state shows a plain mic icon; recording state shows it filled/pulsing with a distinct color, matching how `AIDock`'s existing controls use `var(--color-*)` tokens. No new dedicated voice screen — voice mode augments the existing dock rather than replacing it, so switching it on/off mid-conversation is just a toggle, not a navigation.

## Testing approach

- `voice/transcribe.test.ts` (new): mocks `GoogleGenAI`, asserts the correct model/parts shape is sent, asserts `{ ok: false }` when no Gemini key is configured, asserts `{ ok: false }` on an API error (never throws to the caller).
- `ipc.test.ts`: new test for `ai:transcribe-audio` delegating to `transcribeAudio`.
- `viewContext.test.ts`: new test that `buildSystemPrompt(db, view, now, true)` includes the voice-mode line and `buildSystemPrompt(db, view, now, false)` (and the existing no-arg calls) do not.
- `textForSpeech.test.ts` (new): table-driven tests stripping bold/italic/headers/bullets/code fences, confirming plain prose passes through unchanged.
- `useVoice.test.ts` (new): mocks `MediaRecorder`/`getUserMedia`/`speechSynthesis` (all standard browser globals, straightforward to stub in the existing Vitest + jsdom setup this project already uses for renderer tests); asserts start/stop recording calls `transcribeAudio`, a successful transcription calls the passed-in `sendMessage`, a failed transcription surfaces the `reason` instead of sending, and `speechSynthesis.cancel()` fires before a new recording starts if speech is in progress.
- `ChatPanel.test.tsx`: new tests that the mic button only renders when voice mode is on, and that voice mode being off leaves every existing test (already passing today) unaffected.

## Deferred (explicitly out of scope for this phase)

- True full-duplex conversation (interrupting the assistant by speaking over it).
- Silence-based auto-stop for recording.
- Any non-macOS-system voice choice for TTS (custom/premium voices, e.g. ElevenLabs) — `speechSynthesis` uses whatever voices are installed on the Mac.
- Streaming/incremental speech synthesis (speaking sentence-by-sentence as the response streams in, rather than waiting for `turn-complete`) — waiting for the full text is simpler and avoids mid-sentence cut-off artifacts.
