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

const createdProcessors: FakeScriptProcessorNode[] = [];

class FakeAudioContext {
  sampleRate = 48000;
  destination = {};
  close = vi.fn().mockResolvedValue(undefined);
  createMediaStreamSource = vi.fn(() => new FakeMediaStreamAudioSourceNode());
  createScriptProcessor = vi.fn(() => {
    const node = new FakeScriptProcessorNode();
    createdProcessors.push(node);
    return node;
  });
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
  createdProcessors.length = 0;
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

  it('encodes captured audio samples into a correct WAV header and PCM data', async () => {
    ai.transcribeAudio.mockResolvedValue({ ok: true, text: 'ok' });
    const { result } = renderHook(() => useVoice({ messages: [], sending: false, sendMessage: vi.fn() }));

    await act(async () => {
      await result.current.toggleRecording();
    });

    const processor = createdProcessors[createdProcessors.length - 1];
    const samples = new Float32Array([0, 1, -1]);
    act(() => {
      processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
    });

    await act(async () => {
      await result.current.toggleRecording();
    });

    const [base64] = ai.transcribeAudio.mock.calls[0];
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunkId = (offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4));

    expect(chunkId(0)).toBe('RIFF');
    expect(chunkId(8)).toBe('WAVE');
    expect(chunkId(12)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM format
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(48000); // FakeAudioContext's sampleRate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(chunkId(36)).toBe('data');
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(bytes.length).toBe(44 + samples.length * 2);

    // Spot-check the actual PCM encoding of known sample values.
    expect(view.getInt16(44 + 0 * 2, true)).toBe(0); // 0 -> 0
    expect(view.getInt16(44 + 1 * 2, true)).toBe(0x7fff); // 1 -> +32767
    expect(view.getInt16(44 + 2 * 2, true)).toBe(-0x8000); // -1 -> -32768
  });

  it('ignores a second toggleRecording call while the first getUserMedia is still in flight', async () => {
    const { result } = renderHook(() => useVoice({ messages: [], sending: false, sendMessage: vi.fn() }));

    let firstCallCount = 0;
    await act(async () => {
      const first = result.current.toggleRecording();
      firstCallCount = getUserMedia.mock.calls.length;
      const second = result.current.toggleRecording();
      await Promise.all([first, second]);
    });

    expect(firstCallCount).toBe(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(result.current.isRecording).toBe(true);
  });

  it('tears down the mic session if the component unmounts while recording', async () => {
    const { result, unmount } = renderHook(() => useVoice({ messages: [], sending: false, sendMessage: vi.fn() }));

    await act(async () => {
      await result.current.toggleRecording();
    });
    expect(result.current.isRecording).toBe(true);

    unmount();

    expect(fakeTrack.stop).toHaveBeenCalled();
  });

  it('does nothing on unmount when no recording is in progress', () => {
    const { unmount } = renderHook(() => useVoice({ messages: [], sending: false, sendMessage: vi.fn() }));
    expect(() => unmount()).not.toThrow();
    expect(fakeTrack.stop).not.toHaveBeenCalled();
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
