import { app } from 'electron';
import { join } from 'node:path';

export const WHISPER_MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

export const WHISPER_MODEL_FILENAME = 'ggml-base.en.bin';

/** The bundled whisper.cpp CLI. Dev: the repo's resources/. Packaged:
 *  electron-builder's extraResources drops it under process.resourcesPath. */
export function whisperBinPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'whisper-cli');
  return join(app.getAppPath(), 'resources', 'whisper-cli');
}

/** Runtime-downloaded (see whisperModel.ts) — never bundled. */
export function whisperModelPath(): string {
  return join(app.getPath('userData'), 'models', WHISPER_MODEL_FILENAME);
}
