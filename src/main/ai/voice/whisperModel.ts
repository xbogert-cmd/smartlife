import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { logError } from '../../log';
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
    // res.ok can't catch a captive-portal 200 that hands back an HTML login
    // page instead of the weights. Sanity-check the bytes on disk before we
    // commit them -- a thrown error flows through the same cleanup + retry
    // path as any other download failure.
    const { size } = await stat(partial);
    const expected = Number(res.headers.get('content-length')) || 0;
    if (size < 1_000_000 || (expected && size !== expected)) {
      throw new Error(`model download looks wrong: ${size} bytes${expected ? ` (expected ${expected})` : ''}`);
    }
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
    .catch((err) => {
      // logError must not shadow the failure it's reporting -- a throwing
      // sync file write here would skip `lastFailed = true` and the next
      // call would retry instead of surfacing 'error'.
      try {
        logError('voice:model-download', err);
      } catch {
        /* best effort */
      }
      lastFailed = true;
    })
    .finally(() => {
      inFlight = null;
    });
  return 'downloading';
}
