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
