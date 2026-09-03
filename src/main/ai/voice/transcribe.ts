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
