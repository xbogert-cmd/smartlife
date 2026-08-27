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
