# Phase 8e: Voice Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user talk to the assistant and have it talk back — turn-based voice input (record → transcribe via Gemini → send like a typed message) and spoken output (speak the completed reply via the browser's built-in TTS).

**Architecture:** A new main-process module transcribes recorded audio through Gemini's `generateContent` (one-shot, not the chat provider flow — transcription is decoupled from which provider actually answers). The renderer captures microphone audio via the Web Audio API and hand-encodes a WAV file (verified at plan time: Gemini's inline audio input does **not** accept the `audio/webm` format `MediaRecorder` produces by default — see Global Constraints). A new `useVoice` hook owns recording/playback state and composes with the existing `useConversation`/`ConversationProvider` plumbing without changing it.

**Tech Stack:** Electron + React (existing stack). No new npm dependencies — `@google/genai` (already installed) handles transcription; the Web Audio API, `MediaRecorder`-free WAV encoding, and `speechSynthesis` are all built into Chromium's renderer.

## Global Constraints

- Tests run via `npm test` (sets `ELECTRON_RUN_AS_NODE=1`) — never `npx vitest run`.
- **Verified at plan time (2026-08-27) against `ai.google.dev/gemini-api/docs/audio`: Gemini's inline audio input accepts exactly six MIME types — `audio/wav`, `audio/mp3`, `audio/aiff`, `audio/aac`, `audio/ogg`, `audio/flac`. `audio/webm` (what `MediaRecorder` produces by default in Chromium/Electron, and the only container Chromium's `MediaRecorder` reliably supports) is NOT in that list.** This is why recording does not use `MediaRecorder` at all — it captures raw PCM via `AudioContext`/`ScriptProcessorNode` and hand-encodes a plain WAV file (a well-established, dependency-free ~40-line technique), which is always accepted.
- Voice input requires a configured Gemini key (used only for the transcription step, not as the answering provider). No key configured → the transcription call returns a clear `{ ok: false, reason }`, surfaced in the UI — never a silent no-op.
- Turn-based, not full-duplex: press mic → speak → press again to stop → transcribe → send → assistant answers → speaks once complete → press mic for the next turn. No barge-in, no silence-based auto-stop (see the design spec's Deferred section).
- Voice mode is one toggle (mic input + spoken output together), not two independent switches. Off by default; does not change any existing chat behavior when off.
- macOS requires `NSMicrophoneUsageDescription` in the packaged app's Info.plist before the OS permission prompt can appear at all.
- Speaking assistant text aloud must strip markdown syntax first (bold/italic/headers/bullets/code fences) — reading `"**bold**"` verbatim aloud is broken.

---

### Task 1: Voice transcription backend

**Files:**
- Create: `src/main/ai/voice/transcribe.ts`
- Create: `src/main/ai/voice/transcribe.test.ts`
- Modify: `src/main/ai/ipc.ts`
- Modify: `src/main/ai/ipc.test.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: `getGeminiKey(db)` from `src/main/ai/providerConfig.ts` (pre-existing).
- Produces: `transcribeAudio(db, data: string, mimeType: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }>`. IPC channel `ai:transcribe-audio`. Preload method `transcribeAudio(data, mimeType): Promise<{ ok: true; text: string } | { ok: false; reason: string }>`. Task 5 (`useVoice.ts`) consumes the preload method.

- [ ] **Step 1: Write the failing tests**

Create `src/main/ai/voice/transcribe.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { GoogleGenAI } from '@google/genai';

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return { ...actual, GoogleGenAI: vi.fn() };
});

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}));

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('create table settings (key text primary key, value text not null);');
  return db;
}

describe('transcribeAudio', () => {
  it('returns ok:false with no API call when no Gemini key is configured', async () => {
    const { transcribeAudio } = await import('./transcribe');
    const db = makeDb();
    const result = await transcribeAudio(db, 'base64data', 'audio/wav');
    expect(result).toEqual({ ok: false, reason: 'Voice input needs a Gemini API key — add one in Settings.' });
    expect(GoogleGenAI).not.toHaveBeenCalled();
  });

  it('sends the audio as an inlineData part alongside a transcription instruction, using gemini-2.5-flash', async () => {
    const { setGeminiKey } = await import('../providerConfig');
    const db = makeDb();
    setGeminiKey(db, 'gm-test-key');
    const generateContent = vi.fn().mockResolvedValue({ text: 'hello there' });
    vi.mocked(GoogleGenAI).mockReturnValue({ models: { generateContent } } as never);

    const { transcribeAudio } = await import('./transcribe');
    const result = await transcribeAudio(db, 'base64data', 'audio/wav');

    expect(result).toEqual({ ok: true, text: 'hello there' });
    expect(generateContent).toHaveBeenCalledWith({
      model: 'gemini-2.5-flash',
      contents: [
        { inlineData: { mimeType: 'audio/wav', data: 'base64data' } },
        { text: 'Transcribe this audio exactly. Output only the spoken words, nothing else.' },
      ],
    });
  });

  it('returns ok:false when the response has no text (silent/empty recording)', async () => {
    const { setGeminiKey } = await import('../providerConfig');
    const db = makeDb();
    setGeminiKey(db, 'gm-test-key');
    const generateContent = vi.fn().mockResolvedValue({ text: '' });
    vi.mocked(GoogleGenAI).mockReturnValue({ models: { generateContent } } as never);

    const { transcribeAudio } = await import('./transcribe');
    const result = await transcribeAudio(db, 'base64data', 'audio/wav');

    expect(result).toEqual({ ok: false, reason: "Couldn't hear anything in that recording." });
  });

  it('returns ok:false with the error message instead of throwing when the API call fails', async () => {
    const { setGeminiKey } = await import('../providerConfig');
    const db = makeDb();
    setGeminiKey(db, 'gm-test-key');
    const generateContent = vi.fn().mockRejectedValue(new Error('API key not valid.'));
    vi.mocked(GoogleGenAI).mockReturnValue({ models: { generateContent } } as never);

    const { transcribeAudio } = await import('./transcribe');
    const result = await transcribeAudio(db, 'base64data', 'audio/wav');

    expect(result).toEqual({ ok: false, reason: 'API key not valid.' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- transcribe.test.ts`
Expected: FAIL — `./transcribe` does not exist yet.

- [ ] **Step 3: Implement**

Create `src/main/ai/voice/transcribe.ts`:

```ts
import { GoogleGenAI } from '@google/genai';
import type Database from 'better-sqlite3';
import { getGeminiKey } from '../providerConfig';

export type TranscribeAudioResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * One-shot transcription, not the chat provider flow -- this only needs a
 * working Gemini key, never makes Gemini the conversation's answering
 * provider. The transcribed text re-enters handleSendMessage exactly like a
 * typed message, answered by whichever provider is actually active/ranked.
 */
export async function transcribeAudio(db: Database.Database, data: string, mimeType: string): Promise<TranscribeAudioResult> {
  const apiKey = getGeminiKey(db);
  if (!apiKey) {
    return { ok: false, reason: 'Voice input needs a Gemini API key — add one in Settings.' };
  }

  const client = new GoogleGenAI({ apiKey });
  try {
    const response = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        { inlineData: { mimeType, data } },
        { text: 'Transcribe this audio exactly. Output only the spoken words, nothing else.' },
      ],
    });
    const text = response.text?.trim();
    if (!text) return { ok: false, reason: "Couldn't hear anything in that recording." };
    return { ok: true, text };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Transcription failed.' };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- transcribe.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Wire the IPC channel and preload method**

Add a failing test to `src/main/ai/ipc.test.ts`. First add a `vi.mock` for the new module near the file's existing `vi.mock` calls:

```ts
vi.mock('./voice/transcribe', () => ({ transcribeAudio: vi.fn() }));
```

Then add:

```ts
describe('ai:transcribe-audio', () => {
  it('delegates to transcribeAudio and returns its result', async () => {
    const { transcribeAudio } = await import('./voice/transcribe');
    vi.mocked(transcribeAudio).mockResolvedValue({ ok: true, text: 'hello' });
    const { call } = await setup();
    const result = await call('ai:transcribe-audio', 'base64data', 'audio/wav');
    expect(result).toEqual({ ok: true, text: 'hello' });
    expect(transcribeAudio).toHaveBeenCalledWith(expect.anything(), 'base64data', 'audio/wav');
  });
});
```

Run: `npm test -- ipc.test.ts` — Expected: FAIL (`ai:transcribe-audio` not registered).

In `src/main/ai/ipc.ts`, add the import:

```ts
import { transcribeAudio } from './voice/transcribe';
```

Add the handler, after `ai:pick-attachment`:

```ts
  ipcMain.handle('ai:transcribe-audio', (_event, data: string, mimeType: string) => transcribeAudio(db, data, mimeType));
```

In `src/preload/index.ts`, add to the `ai: { ... }` object, immediately after `pickAttachment`:

```ts
    transcribeAudio: (data: string, mimeType: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }> =>
      ipcRenderer.invoke('ai:transcribe-audio', data, mimeType),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- ipc.test.ts`
Expected: PASS, all tests.

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/ai/voice/transcribe.ts src/main/ai/voice/transcribe.test.ts src/main/ai/ipc.ts src/main/ai/ipc.test.ts src/preload/index.ts
git commit -m "Add Gemini-backed audio transcription: ai:transcribe-audio IPC channel"
```

---

### Task 2: Voice-mode-aware system prompt

**Files:**
- Modify: `src/main/ai/viewContext.ts`
- Modify: `src/main/ai/viewContext.test.ts`
- Modify: `src/main/ai/chatController.ts`
- Modify: `src/main/ai/chatController.test.ts`
- Modify: `src/main/ai/ipc.ts`
- Modify: `src/main/ai/ipc.test.ts` (only if a send-message test already exists there — it doesn't today, per Phase 8c/8d; this task adds no new ipc.test.ts test, only touches the handler)
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildSystemPrompt(db, view, now?, voiceMode?)` — new optional 4th param, defaults to `false`. `handleSendMessage`'s `options` object gains an optional `voiceMode?: boolean` field. `ai:send-message` and preload's `sendMessage` gain a 5th argument, `voiceMode: boolean`. Task 4 (`useVoice.ts`) and Task 5 (UI wiring) consume this by passing `voiceModeOn` through `sendMessage`.

- [ ] **Step 1: Write the failing test**

`src/main/ai/viewContext.test.ts` already has a `describe('buildSystemPrompt', ...)` block using a `setup(assignmentName, types)` helper and a fixed `NOW` constant, called as `buildSystemPrompt(setup(), null, NOW)`. Add this test next to the existing ones:

```ts
  it('adds a voice-mode line telling the assistant its response will be spoken aloud', () => {
    const withVoice = buildSystemPrompt(setup(), null, NOW, true);
    const withoutVoice = buildSystemPrompt(setup(), null, NOW, false);
    expect(withVoice).toContain('voice conversation');
    expect(withVoice).toContain('no markdown formatting');
    expect(withoutVoice).not.toContain('voice conversation');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- viewContext.test.ts`
Expected: FAIL — `buildSystemPrompt` doesn't accept a 4th argument and never adds this line.

- [ ] **Step 3: Implement**

In `src/main/ai/viewContext.ts`, change `buildSystemPrompt`'s signature and body:

```ts
export function buildSystemPrompt(
  db: Database.Database,
  view: ViewContext | null,
  now: Date = new Date(),
  voiceMode = false
): string {
  const lines = [BASE_PROMPT, `The current date and time is ${now.toISOString()}.`];
  const where = viewLine(db, view);
  if (where !== null) lines.push(where);
  if (voiceMode) {
    lines.push(
      'The user is in a voice conversation right now — your response will be read aloud. Keep it natural to speak: no markdown formatting, no code blocks, no bullet lists, and keep it reasonably concise.'
    );
  }
  return lines.join('\n\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- viewContext.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Thread voiceMode through handleSendMessage**

Add a failing test to `src/main/ai/chatController.test.ts`, inside the existing `describe('system prompt', ...)` block:

```ts
  it('passes voiceMode through to buildSystemPrompt when the option is set', async () => {
    const { handleSendMessage } = await import('./chatController');
    const db = makeDb();
    setStoredApiKey(db, 'sk-ant-test');
    const conversationId = await makeConversation(db);
    const streamTurn = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { inputTokens: 1, outputTokens: 1 },
      providerId: 'anthropic',
      model: 'claude-sonnet-5',
    });
    await handleSendMessage(db, () => fakeWindow() as never, 'hi', null, conversationId, {
      provider: { streamTurn },
      voiceMode: true,
    });

    const system = streamTurn.mock.calls[0][0].system as string;
    expect(system).toContain('voice conversation');
  });
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- chatController.test.ts`
Expected: FAIL — `options.voiceMode` is accepted (extra property) but never passed to `buildSystemPrompt`.

- [ ] **Step 7: Implement**

In `src/main/ai/chatController.ts`, change the `options` parameter type and the `buildSystemPrompt` call:

```ts
  options: { attachmentIds?: string[]; provider?: AIProvider; voiceMode?: boolean } = {}
): Promise<void> {
  const { attachmentIds = [], provider = getProvider(db), voiceMode = false } = options;
```

Change the `provider.streamTurn` call's `system` field:

```ts
        system: buildSystemPrompt(db, view, undefined, voiceMode),
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test -- chatController.test.ts`
Expected: PASS, all tests.

- [ ] **Step 9: Wire IPC and preload**

In `src/main/ai/ipc.ts`, change the `ai:send-message` handler:

```ts
  ipcMain.handle(
    'ai:send-message',
    (_event, text: string, view: ViewContext | null, attachmentIds: string[] = [], conversationId: string, voiceMode = false) =>
      handleSendMessage(db, getWindow, text, view ?? null, conversationId, { attachmentIds, voiceMode })
  );
```

In `src/preload/index.ts`, change the `ai.sendMessage` entry:

```ts
    sendMessage: (
      text: string,
      view: unknown = null,
      attachmentIds: string[] = [],
      conversationId: string,
      voiceMode = false
    ): Promise<void> => ipcRenderer.invoke('ai:send-message', text, view, attachmentIds, conversationId, voiceMode),
```

- [ ] **Step 10: Run tests to verify nothing regressed**

Run: `npm test -- ipc.test.ts`
Run: `npm run typecheck`
Expected: PASS / clean. (No new `ipc.test.ts` test is added for this step — `ai:send-message` has no dedicated test at the IPC layer today, same as before this phase; the behavior is covered at the `chatController.test.ts` layer above.)

- [ ] **Step 11: Thread voiceMode through useConversation.ts's sendMessage**

Everything through Step 10 makes the backend accept and act on `voiceMode`, but nothing yet actually sets it to `true` from the renderer — `useConversation.ts`'s `sendMessage` only ever calls `window.smartlife.ai.sendMessage(text, view, attachmentIds, activeConversationId)` (4 args; preload's new 5th arg silently defaults to `false` every time). Without this step, Task 2's backend work is unreachable dead code. Fix it here so Tasks 4-5 have a real `voiceMode` parameter to plug into.

In `src/renderer/src/ai/useConversation.test.ts`, update the existing test's assertion (find the line `expect(ai.sendMessage).toHaveBeenCalledWith('hi', null, ['attach-1'], 'conv-1');` inside the test `'sendMessage passes the active conversation id and current attachment ids, and clears attachments afterward'`) to:

```ts
    expect(ai.sendMessage).toHaveBeenCalledWith('hi', null, ['attach-1'], 'conv-1', false);
```

Add a new test in the same `describe('useConversation — attachments', ...)` block (or wherever that test lives — read the file to confirm) proving the true case:

```ts
  it('sendMessage passes voiceMode through as the 5th argument when set', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));

    act(() => {
      result.current.sendMessage('hi', null, true);
    });

    expect(ai.sendMessage).toHaveBeenCalledWith('hi', null, [], 'conv-1', true);
  });
```

Run: `npm test -- useConversation.test.ts` — Expected: FAIL (both the updated assertion and the new test, since `sendMessage` doesn't accept or forward a 3rd argument yet).

In `src/renderer/src/ai/useConversation.ts`, change `sendMessage`'s signature and its IPC call:

```ts
  const sendMessage = useCallback(
    (text: string, view: unknown = null, voiceMode = false) => {
      if (!activeConversationId) return;
      const id = `user-${Date.now()}-${Math.random()}`;
      setMessages((prev) => [...prev, { id, role: 'user', text }]);
      setSending(true);
      streamingIdRef.current = null;
      lastAssistantMessageIdRef.current = null;
      const attachmentIds = attachments.map((a) => a.id);
      setAttachments([]);
      window.smartlife.ai
        .sendMessage(text, view, attachmentIds, activeConversationId, voiceMode)
        .then(() => refreshConversations())
        .catch(() => {
          setSending(false);
          setMessages((prev) => [
            ...prev,
            { id: `assistant-${Date.now()}-${Math.random()}`, role: 'assistant', text: 'Something went wrong — try again.' },
          ]);
        });
    },
    [attachments, activeConversationId, refreshConversations]
  );
```

(Only the function signature's first line and the `.sendMessage(...)` call itself change — everything else in the callback body is unchanged from the current file.)

Run: `npm test -- useConversation.test.ts` — Expected: PASS, all tests.

- [ ] **Step 12: Commit**

```bash
git add src/main/ai/viewContext.ts src/main/ai/viewContext.test.ts src/main/ai/chatController.ts src/main/ai/chatController.test.ts src/main/ai/ipc.ts src/preload/index.ts src/renderer/src/ai/useConversation.ts src/renderer/src/ai/useConversation.test.ts
git commit -m "Thread voiceMode through send-message so the system prompt adapts for spoken responses"
```

---

### Task 3: `textForSpeech` markdown-stripping utility

**Files:**
- Create: `src/renderer/src/ai/textForSpeech.ts`
- Create: `src/renderer/src/ai/textForSpeech.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `textForSpeech(markdown: string): string`. Task 4 (`useVoice.ts`) consumes this.

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/ai/textForSpeech.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { textForSpeech } from './textForSpeech';

describe('textForSpeech', () => {
  it('strips bold and italic markers', () => {
    expect(textForSpeech('This is **bold** and this is *italic*.')).toBe('This is bold and this is italic.');
  });

  it('strips heading markers', () => {
    expect(textForSpeech('# Big Heading\n## Smaller heading\ntext')).toBe('Big Heading\nSmaller heading\ntext');
  });

  it('strips bullet list markers, keeping the item text', () => {
    expect(textForSpeech('- first item\n- second item\n* third item')).toBe('first item\nsecond item\nthird item');
  });

  it('strips inline code backticks and code fences', () => {
    expect(textForSpeech('Run `npm test` to check.\n```\ncode block\n```')).toBe('Run npm test to check.\ncode block');
  });

  it('collapses extra whitespace left behind by stripping', () => {
    expect(textForSpeech('**  spaced  **')).toBe('spaced');
  });

  it('leaves plain prose completely unchanged', () => {
    expect(textForSpeech('Just a normal sentence with no markdown at all.')).toBe(
      'Just a normal sentence with no markdown at all.'
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- textForSpeech.test.ts`
Expected: FAIL — `./textForSpeech` does not exist yet.

- [ ] **Step 3: Implement**

Create `src/renderer/src/ai/textForSpeech.ts`:

```ts
/**
 * Strips markdown syntax before handing text to speechSynthesis -- reading
 * "**bold**" or "- item" aloud verbatim (asterisks, dashes, hashes, backticks)
 * sounds broken. Only affects what gets spoken; the visible chat bubble text
 * is untouched (this function's output is never rendered).
 */
export function textForSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, '').trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- textForSpeech.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/ai/textForSpeech.ts src/renderer/src/ai/textForSpeech.test.ts
git commit -m "Add textForSpeech: strip markdown before speaking assistant replies aloud"
```

---

### Task 4: `useVoice` hook — recording, transcription, and speaking replies

**Files:**
- Create: `src/renderer/src/ai/useVoice.ts`
- Create: `src/renderer/src/ai/useVoice.test.ts`

**Interfaces:**
- Consumes: `window.smartlife.ai.transcribeAudio` (Task 1), `textForSpeech` (Task 3), and `messages`/`sending` from `useConversationContext()`'s return value (Phase 8c/8d, unchanged). Takes `sendMessage` as a caller-supplied callback shaped `(text: string, voiceMode?: boolean) => void` rather than `conversation.sendMessage` directly, so each caller (`AIDock.tsx`, `routes/AI.tsx`) can thread its own `view` through — see Task 2 Step 11, which gave `conversation.sendMessage` a new `voiceMode` 3rd parameter this hook relies on.
- Produces: `useVoice({ messages, sending, sendMessage }): { voiceModeOn: boolean; toggleVoiceMode: () => void; isRecording: boolean; toggleRecording: () => void; voiceError: string | null }`. Task 5 (UI wiring) consumes this.

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/ai/useVoice.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useVoice } from './useVoice';
import type { ChatMessage } from './useConversation';

class FakeAudioParam {
  value = 1;
}

class FakeGainNode {
  gain = new FakeAudioParam();
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeScriptProcessorNode {
  onaudioprocess: ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeMediaStreamAudioSourceNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeAudioContext {
  sampleRate = 48000;
  destination = {};
  close = vi.fn().mockResolvedValue(undefined);
  createMediaStreamSource = vi.fn(() => new FakeMediaStreamAudioSourceNode());
  createScriptProcessor = vi.fn(() => new FakeScriptProcessorNode());
  createGain = vi.fn(() => new FakeGainNode());
}

const fakeTrack = { stop: vi.fn() };
const fakeStream = { getTracks: () => [fakeTrack] };
const getUserMedia = vi.fn().mockResolvedValue(fakeStream);

const ai = {
  transcribeAudio: vi.fn(),
};

const speak = vi.fn();
const cancel = vi.fn();

function makeMessages(overrides: Partial<ChatMessage> = {}): ChatMessage[] {
  return [{ id: 'a1', role: 'assistant', text: 'the reply', ...overrides }];
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'smartlife', { value: { ai }, writable: true, configurable: true });
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, writable: true, configurable: true });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('speechSynthesis', { speak, cancel });
  vi.stubGlobal('SpeechSynthesisUtterance', class {
    text: string;
    constructor(text: string) {
      this.text = text;
    }
  });
  fakeTrack.stop.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useVoice — voice mode toggle', () => {
  it('starts off, and toggling flips it', () => {
    const { result } = renderHook(() => useVoice({ messages: [], sending: false, sendMessage: vi.fn() }));
    expect(result.current.voiceModeOn).toBe(false);
    act(() => result.current.toggleVoiceMode());
    expect(result.current.voiceModeOn).toBe(true);
  });

  it('cancels any in-progress speech when voice mode is turned off', () => {
    const { result } = renderHook(() => useVoice({ messages: [], sending: false, sendMessage: vi.fn() }));
    act(() => result.current.toggleVoiceMode());
    act(() => result.current.toggleVoiceMode());
    expect(cancel).toHaveBeenCalled();
  });
});

describe('useVoice — recording and transcription', () => {
  it('records, encodes a WAV blob, sends it for transcription, and calls sendMessage with the result', async () => {
    ai.transcribeAudio.mockResolvedValue({ ok: true, text: 'hello world' });
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useVoice({ messages: [], sending: false, sendMessage }));

    await act(async () => {
      await result.current.toggleRecording();
    });
    expect(result.current.isRecording).toBe(true);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });

    // No audio chunk is simulated here -- FakeScriptProcessorNode's
    // onaudioprocess is never invoked, so the hook's internal chunk buffer
    // stays empty and encodeWav runs on a zero-length Float32Array,
    // producing a valid (silent) 44-byte WAV. That's exactly what a real
    // near-instant start/stop recording produces, and is enough to prove
    // the record -> encode -> transcribe -> send pipeline end to end
    // without needing to reach into a specific FakeScriptProcessorNode
    // instance from the test.

    await act(async () => {
      await result.current.toggleRecording();
    });

    expect(result.current.isRecording).toBe(false);
    expect(ai.transcribeAudio).toHaveBeenCalledTimes(1);
    const [data, mimeType] = ai.transcribeAudio.mock.calls[0];
    expect(mimeType).toBe('audio/wav');
    expect(typeof data).toBe('string');
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('hello world', true));
    expect(fakeTrack.stop).toHaveBeenCalled();
  });

  it('surfaces the failure reason and does not call sendMessage when transcription fails', async () => {
    ai.transcribeAudio.mockResolvedValue({ ok: false, reason: "Couldn't hear anything in that recording." });
    const sendMessage = vi.fn();
    const { result } = renderHook(() => useVoice({ messages: [], sending: false, sendMessage }));

    await act(async () => {
      await result.current.toggleRecording();
    });
    await act(async () => {
      await result.current.toggleRecording();
    });

    await waitFor(() => expect(result.current.voiceError).toBe("Couldn't hear anything in that recording."));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('surfaces a mic-access error and never starts recording when getUserMedia rejects', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('Permission denied'));
    const { result } = renderHook(() => useVoice({ messages: [], sending: false, sendMessage: vi.fn() }));

    await act(async () => {
      await result.current.toggleRecording();
    });

    expect(result.current.isRecording).toBe(false);
    expect(result.current.voiceError).toBe('Could not access the microphone. Check your system permissions.');
  });
});

describe('useVoice — speaking a completed reply', () => {
  it('speaks the last assistant message once sending flips from true to false, while voice mode is on', async () => {
    let messages: ChatMessage[] = [];
    const { result, rerender } = renderHook(({ msgs, isSending }) => useVoice({ messages: msgs, sending: isSending, sendMessage: vi.fn() }), {
      initialProps: { msgs: messages, isSending: false },
    });
    act(() => result.current.toggleVoiceMode());

    messages = makeMessages({ text: 'here is the answer' });
    rerender({ msgs: messages, isSending: true });
    rerender({ msgs: messages, isSending: false });

    await waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
    const utterance = speak.mock.calls[0][0] as { text: string };
    expect(utterance.text).toBe('here is the answer');
  });

  it('does not speak when voice mode is off', async () => {
    let messages: ChatMessage[] = [];
    const { rerender } = renderHook(({ msgs, isSending }) => useVoice({ messages: msgs, sending: isSending, sendMessage: vi.fn() }), {
      initialProps: { msgs: messages, isSending: false },
    });

    messages = makeMessages({ text: 'here is the answer' });
    rerender({ msgs: messages, isSending: true });
    rerender({ msgs: messages, isSending: false });

    expect(speak).not.toHaveBeenCalled();
  });

  it('does not speak a switch-notice message', async () => {
    let messages: ChatMessage[] = [];
    const { result, rerender } = renderHook(({ msgs, isSending }) => useVoice({ messages: msgs, sending: isSending, sendMessage: vi.fn() }), {
      initialProps: { msgs: messages, isSending: false },
    });
    act(() => result.current.toggleVoiceMode());

    messages = makeMessages({ text: 'Switched to Gemini', kind: 'switch-notice' });
    rerender({ msgs: messages, isSending: true });
    rerender({ msgs: messages, isSending: false });

    expect(speak).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- useVoice.test.ts`
Expected: FAIL — `./useVoice` does not exist yet.

- [ ] **Step 3: Implement**

Create `src/renderer/src/ai/useVoice.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from './useConversation';
import { textForSpeech } from './textForSpeech';

interface UseVoiceParams {
  messages: ChatMessage[];
  sending: boolean;
  /** Caller-supplied so each consumer (AIDock, the /ai route) can thread its
   *  own `view` through to conversation.sendMessage(text, view, voiceMode)
   *  -- this hook only ever calls it with (text, true). */
  sendMessage: (text: string, voiceMode?: boolean) => void;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Gemini's inline audio input accepts audio/wav (and a short documented list
 * of other formats) but NOT the audio/webm;codecs=opus that MediaRecorder
 * produces by default in Chromium/Electron -- verified against
 * ai.google.dev/gemini-api/docs/audio at plan time. So recording captures
 * raw PCM via the Web Audio API instead of MediaRecorder, and this function
 * hand-encodes a plain WAV file -- a well-established, dependency-free
 * technique, and simpler than transcoding in the main process.
 */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  function writeString(offset: number, text: string): void {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

interface RecordingSession {
  audioContext: AudioContext;
  processor: ScriptProcessorNode;
  source: MediaStreamAudioSourceNode;
  silentGain: GainNode;
  stream: MediaStream;
  chunks: Float32Array[];
}

export function useVoice({ messages, sending, sendMessage }: UseVoiceParams) {
  const [voiceModeOn, setVoiceModeOn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const sessionRef = useRef<RecordingSession | null>(null);
  const wasSendingRef = useRef(false);

  // Speaks the just-finished assistant reply once the turn completes, only
  // while voice mode is on. Watches `sending` flip true -> false rather than
  // subscribing to stream events -- by the time it flips, the final
  // assistant message's text is already in `messages`.
  useEffect(() => {
    if (wasSendingRef.current && !sending && voiceModeOn) {
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant' && last.kind !== 'switch-notice' && last.text.trim().length > 0) {
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(textForSpeech(last.text)));
      }
    }
    wasSendingRef.current = sending;
  }, [sending, voiceModeOn, messages]);

  const toggleVoiceMode = useCallback(() => {
    setVoiceModeOn((prev) => {
      if (prev) window.speechSynthesis.cancel();
      return !prev;
    });
  }, []);

  const startRecording = useCallback(async () => {
    setVoiceError(null);
    // Cancel any in-progress speech before recording a new turn -- no
    // attempt at detecting interruption by voice, just a clean handoff.
    window.speechSynthesis.cancel();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      const chunks: Float32Array[] = [];
      processor.onaudioprocess = (event) => {
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);
      sessionRef.current = { audioContext, processor, source, silentGain, stream, chunks };
      setIsRecording(true);
    } catch {
      setVoiceError('Could not access the microphone. Check your system permissions.');
    }
  }, []);

  const stopRecording = useCallback(async () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    setIsRecording(false);
    if (!session) return;

    session.processor.disconnect();
    session.source.disconnect();
    session.silentGain.disconnect();
    session.stream.getTracks().forEach((track) => track.stop());
    const sampleRate = session.audioContext.sampleRate;
    await session.audioContext.close();

    const totalLength = session.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Float32Array(totalLength);
    let position = 0;
    for (const chunk of session.chunks) {
      merged.set(chunk, position);
      position += chunk.length;
    }

    const wavBlob = encodeWav(merged, sampleRate);
    const buffer = await wavBlob.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);

    const result = await window.smartlife.ai.transcribeAudio(base64, 'audio/wav');
    if (!result.ok) {
      setVoiceError(result.reason);
      return;
    }
    // A transcribed send is definitionally a voice-mode send.
    sendMessage(result.text, true);
  }, [sendMessage]);

  const toggleRecording = useCallback(async () => {
    if (isRecording) {
      await stopRecording();
    } else {
      await startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  return { voiceModeOn, toggleVoiceMode, isRecording, toggleRecording, voiceError };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- useVoice.test.ts`
Expected: PASS, all tests.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/ai/useVoice.ts src/renderer/src/ai/useVoice.test.ts
git commit -m "Add useVoice hook: WAV-encoded recording, transcription, and speaking completed replies"
```

---

### Task 5: UI wiring and microphone permission

**Files:**
- Modify: `src/renderer/src/ai/ChatPanel.tsx`
- Modify: `src/renderer/src/ai/ChatPanel.test.tsx`
- Modify: `src/renderer/src/ai/AIDock.tsx`
- Modify: `src/renderer/src/ai/AIDock.test.tsx`
- Modify: `src/renderer/src/routes/AI.tsx`
- Modify: `src/renderer/src/routes/AI.test.tsx`
- Modify: `src/preload/index.ts` (add `transcribeAudio`'s type export usage — already done in Task 1; this task only touches the two route-level files' consumption of the new hook)
- Modify: `electron-builder.yml`

**Interfaces:**
- Consumes: `useVoice` from Task 4.
- Produces: `ChatPanel`'s prop list gains `voiceModeOn`, `onToggleVoiceMode`, `isRecording`, `onToggleRecording`, `voiceError` (all required, matching this file's existing style of explicit required props for dock/route-supplied state).

- [ ] **Step 1: Write the failing tests for ChatPanel.tsx**

In `src/renderer/src/ai/ChatPanel.test.tsx`, every existing `render(...)` call that constructs a full `<ChatPanel ... />` prop set (the `panel(count)` helper, the switch-notices test's inline props, and the `baseProps` object in the attachments/answeredBy describe blocks) needs five new required props added. Read the file first to find every prop-object literal and add these five lines to each:

```ts
    voiceModeOn: false,
    onToggleVoiceMode: vi.fn(),
    isRecording: false,
    onToggleRecording: vi.fn(),
    voiceError: null as string | null,
```

Add a new describe block at the end of the file:

```tsx
describe('ChatPanel voice mode', () => {
  const baseProps = {
    messages: [] as ChatMessage[],
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

  it('does not show a mic button when voice mode is off', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} voiceModeOn={false} onToggleVoiceMode={vi.fn()} isRecording={false} onToggleRecording={vi.fn()} voiceError={null} />
      </MemoryRouter>
    );
    expect(screen.queryByRole('button', { name: /voice input/i })).not.toBeInTheDocument();
  });

  it('shows a mic button when voice mode is on, and toggling it calls onToggleRecording', async () => {
    const onToggleRecording = vi.fn();
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} voiceModeOn={true} onToggleVoiceMode={vi.fn()} isRecording={false} onToggleRecording={onToggleRecording} voiceError={null} />
      </MemoryRouter>
    );
    await userEvent.click(screen.getByRole('button', { name: /start voice input/i }));
    expect(onToggleRecording).toHaveBeenCalled();
  });

  it('shows a visibly different control while recording', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} voiceModeOn={true} onToggleVoiceMode={vi.fn()} isRecording={true} onToggleRecording={vi.fn()} voiceError={null} />
      </MemoryRouter>
    );
    expect(screen.getByRole('button', { name: /stop voice input/i })).toBeInTheDocument();
  });

  it('shows voiceError text when present', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} voiceModeOn={true} onToggleVoiceMode={vi.fn()} isRecording={false} onToggleRecording={vi.fn()} voiceError="Could not access the microphone. Check your system permissions." />
      </MemoryRouter>
    );
    expect(screen.getByText('Could not access the microphone. Check your system permissions.')).toBeInTheDocument();
  });

  it('calls onToggleVoiceMode when the voice mode toggle is clicked', async () => {
    const onToggleVoiceMode = vi.fn();
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} voiceModeOn={false} onToggleVoiceMode={onToggleVoiceMode} isRecording={false} onToggleRecording={vi.fn()} voiceError={null} />
      </MemoryRouter>
    );
    await userEvent.click(screen.getByRole('button', { name: /voice mode/i }));
    expect(onToggleVoiceMode).toHaveBeenCalled();
  });
});
```

Add `import type { ChatMessage } from './useConversation';` to the file's imports if not already present (it is, per the existing switch-notices test's usage — verify by reading the file's current import block first).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- ChatPanel.test.tsx`
Expected: FAIL — `ChatPanel` doesn't accept these props, no mic/voice-mode buttons exist yet, and every existing test's prop object is now missing required props (a TypeScript error, surfaced as a test failure once `ChatPanelProps` requires them).

- [ ] **Step 3: Implement ChatPanel.tsx**

Add the five new props to `ChatPanelProps` and the destructured parameter list:

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
  onNavigateAway?: () => void;
  voiceModeOn: boolean;
  onToggleVoiceMode: () => void;
  isRecording: boolean;
  onToggleRecording: () => void;
  voiceError: string | null;
}
```

```ts
export function ChatPanel({
  messages,
  statusLabel,
  pendingConfirm,
  sending,
  apiKeyConfigured,
  input,
  onInputChange,
  onSubmit,
  onRespondToConfirm,
  attachments,
  attachError,
  onAddAttachment,
  onRemoveAttachment,
  onNavigateAway,
  voiceModeOn,
  onToggleVoiceMode,
  isRecording,
  onToggleRecording,
  voiceError,
}: ChatPanelProps) {
```

Add a voice-mode toggle button to the header area. Find where the header currently renders (immediately before the message-list `<div ref={scrollRef} ...>`), and add, as a sibling right before it:

```tsx
      <div className="flex items-center justify-end gap-2 px-4 pt-3">
        <button
          type="button"
          onClick={onToggleVoiceMode}
          aria-label="Voice mode"
          aria-pressed={voiceModeOn}
          className="rounded-md px-2 py-1 text-xs"
          style={{
            backgroundColor: voiceModeOn ? 'var(--color-text)' : 'var(--color-surface)',
            color: voiceModeOn ? 'var(--color-bg)' : 'var(--color-text)',
            border: '1px solid var(--color-border)',
          }}
        >
          🎙 Voice mode
        </button>
      </div>
```

(Place this only in the non-empty-state return path — after the `if (apiKeyConfigured !== true) { return ...; }` early return, as the very first element inside the outer `<div className="flex h-full flex-col">`.)

Add the mic button and voiceError text to the form area. Find the `<form onSubmit={onSubmit} ...>` block; add the mic button as a sibling immediately before the existing "Attach" button, only when `voiceModeOn` is true:

```tsx
        {voiceModeOn && (
          <button
            type="button"
            onClick={onToggleRecording}
            aria-label={isRecording ? 'Stop voice input' : 'Start voice input'}
            className="rounded-md px-3 py-2 text-sm"
            style={{
              backgroundColor: isRecording ? '#EF4444' : 'var(--color-surface)',
              color: isRecording ? '#ffffff' : 'var(--color-text)',
              border: '1px solid var(--color-border)',
            }}
          >
            {isRecording ? '● Stop' : '🎙'}
          </button>
        )}
```

Add `voiceError` display next to the existing `attachError` display — find the block:

```tsx
      {(attachments.length > 0 || attachError) && (
```

change to:

```tsx
      {(attachments.length > 0 || attachError || voiceError) && (
```

and inside that block, after the existing `{attachError && <span ...>{attachError}</span>}` line, add:

```tsx
          {voiceError && <span style={{ color: '#EF4444', fontSize: 12 }}>{voiceError}</span>}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- ChatPanel.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 5: Wire useVoice into AIDock.tsx and routes/AI.tsx**

In `src/renderer/src/ai/AIDock.test.tsx`, the mocked `window.smartlife.ai` object needs `transcribeAudio: vi.fn().mockResolvedValue({ ok: false, reason: 'not used in this test' })` added (matching the file's existing mock style) so `useVoice` doesn't crash if exercised — read the file's current mock object and add this entry alongside `pickAttachment`.

In `src/renderer/src/ai/AIDock.tsx`, add the import and hook call:

```ts
import { useVoice } from './useVoice';
```

```ts
  const voice = useVoice({
    messages: conversation.messages,
    sending: conversation.sending,
    // Wrapped so a voice-transcribed send carries the same ambient `view`
    // context a typed send in this dock already gets. useVoice calls this
    // as sendMessage(text, true) (see Task 4), so `voiceMode` here is that
    // hook's argument, not `voice.voiceModeOn` (which isn't in scope yet at
    // the point this object literal is constructed).
    sendMessage: (text, voiceMode) => conversation.sendMessage(text, view, voiceMode),
  });
```

(Place this right after `const conversation = useConversationContext();`, and after `const view = useViewContext();` since it references `view`.)

Update `handleSubmit` so a TYPED message also carries voice-mode awareness (not just a voice-transcribed one) when voice mode is toggled on:

```ts
  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!input.trim() || conversation.sending) return;
    conversation.sendMessage(input.trim(), view, voice.voiceModeOn);
    setInput('');
  }
```

Pass the five new props to `<ChatPanel>`:

```tsx
            voiceModeOn={voice.voiceModeOn}
            onToggleVoiceMode={voice.toggleVoiceMode}
            isRecording={voice.isRecording}
            onToggleRecording={voice.toggleRecording}
            voiceError={voice.voiceError}
```

(Add these as new lines inside the existing `<ChatPanel ... />` prop list, anywhere among the other props.)

In `src/renderer/src/routes/AI.test.tsx`, the `mockAi()` helper's returned object needs `transcribeAudio: vi.fn().mockResolvedValue({ ok: false, reason: 'not used in this test' })` added, matching its existing style. Also update the existing assertion `expect(ai.sendMessage).toHaveBeenCalledWith('hi there', null, [], 'conv-1');` to include the new 5th `voiceMode` argument (`false`, since voice mode defaults off and this test never turns it on):

```ts
    expect(ai.sendMessage).toHaveBeenCalledWith('hi there', null, [], 'conv-1', false);
```

In `src/renderer/src/routes/AI.tsx`, make the same two changes as `AIDock.tsx`: import `useVoice`, and pass the same five props to `<ChatPanel>`. The hook call itself is simpler here since this route has no `view` to thread (its own `handleSubmit` already calls `conversation.sendMessage(input.trim())` with no view argument, matching this route's existing always-null-view behavior) — it only needs to forward `voiceMode` straight through:

```ts
  const voice = useVoice({
    messages: conversation.messages,
    sending: conversation.sending,
    sendMessage: (text, voiceMode) => conversation.sendMessage(text, undefined, voiceMode),
  });
```

(Place this right after `const conversation = useConversationContext();`.)

Update `handleSubmit` the same way as `AIDock.tsx`'s, so a typed message on this route also carries voice-mode awareness:

```ts
  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!input.trim() || conversation.sending) return;
    conversation.sendMessage(input.trim(), undefined, voice.voiceModeOn);
    setInput('');
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- AIDock.test.tsx`
Run: `npm test -- AI.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 7: Add the microphone usage description**

In `electron-builder.yml`, add `extendInfo` under the existing `mac:` section:

```yaml
mac:
  category: public.app-category.productivity
  extendInfo:
    NSMicrophoneUsageDescription: "SmartLife uses your microphone to let you talk to the AI assistant."
  target:
    - target: dir
```

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npm test`
Expected: fully green (the previously-known pre-existing flakes were already fixed in Phase 8d — if `ThemeProvider.test.tsx` or `Home.test.tsx` fail, re-run each in isolation once to confirm before treating it as a real regression).

Run: `npm run typecheck`
Expected: clean, project-wide.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/ai/ChatPanel.tsx src/renderer/src/ai/ChatPanel.test.tsx src/renderer/src/ai/AIDock.tsx src/renderer/src/ai/AIDock.test.tsx src/renderer/src/routes/AI.tsx src/renderer/src/routes/AI.test.tsx electron-builder.yml
git commit -m "Wire voice mode into the AI dock and /ai route; add microphone usage description for packaging"
```

---

## Final steps (after all 5 tasks are complete)

- [ ] Run the full test suite: `npm test`. Expected: all tests pass.
- [ ] Run `npm run typecheck` and `npm run lint`. Expected: clean (lint: no new errors beyond whatever pre-existing ones were already present before this phase).
- [ ] Update `ROADMAP.md` to record Phases 8c, 8d, and 8e as built, in one pass covering all three (per the controller's standing instruction to update it once at the end of all three phases, not per-phase).
