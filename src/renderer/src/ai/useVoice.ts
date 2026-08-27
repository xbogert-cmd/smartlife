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
 * technique, and simpler than transcoding in the main process. Returns the
 * raw ArrayBuffer directly (rather than wrapping it in a Blob) since the
 * only thing done with it is base64-encoding for IPC -- jsdom's Blob also
 * doesn't implement arrayBuffer(), which this sidesteps for free.
 */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
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

  return buffer;
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

    const buffer = encodeWav(merged, sampleRate);
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
