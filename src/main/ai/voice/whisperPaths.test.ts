import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = { isPackaged: false };

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.isPackaged;
    },
    getAppPath: () => '/repo',
    getPath: (name: string) => `/userdata/${name}`,
  },
}));

const ORIGINAL_RESOURCES_PATH = process.resourcesPath;

beforeEach(() => {
  state.isPackaged = false;
  Object.defineProperty(process, 'resourcesPath', { value: '/app/Contents/Resources', configurable: true });
});

afterEach(() => {
  vi.resetModules();
  Object.defineProperty(process, 'resourcesPath', { value: ORIGINAL_RESOURCES_PATH, configurable: true });
});

describe('whisperPaths', () => {
  it('resolves the binary from the repo resources/ dir in development', async () => {
    const { whisperBinPath } = await import('./whisperPaths');
    expect(whisperBinPath()).toBe('/repo/resources/whisper-cli');
  });

  it('resolves the binary from process.resourcesPath in a packaged app', async () => {
    state.isPackaged = true;
    const { whisperBinPath } = await import('./whisperPaths');
    expect(whisperBinPath()).toBe('/app/Contents/Resources/whisper-cli');
  });

  it('puts the model under userData/models/', async () => {
    const { whisperModelPath } = await import('./whisperPaths');
    expect(whisperModelPath()).toBe('/userdata/userData/models/ggml-base.en.bin');
  });

  it('points the model URL at the ggml base.en weights', async () => {
    const { WHISPER_MODEL_URL } = await import('./whisperPaths');
    expect(WHISPER_MODEL_URL).toBe(
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    );
  });
});
