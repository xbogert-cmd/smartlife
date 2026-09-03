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
    await pipeline(
      Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(partial),
    );
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
