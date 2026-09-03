// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./whisperPaths', () => ({
  WHISPER_MODEL_URL: 'https://example.test/ggml-base.en.bin',
  whisperModelPath: () => '/userdata/models/ggml-base.en.bin',
}));

vi.mock('../../log', () => ({ logError: vi.fn() }));

const stat = vi.fn();
const mkdir = vi.fn().mockResolvedValue(undefined);
const rm = vi.fn().mockResolvedValue(undefined);
const rename = vi.fn().mockResolvedValue(undefined);
vi.mock('node:fs/promises', () => ({
  stat: (...a: unknown[]) => stat(...(a as Parameters<typeof stat>)),
  mkdir: (...a: unknown[]) => mkdir(...(a as Parameters<typeof mkdir>)),
  rm: (...a: unknown[]) => rm(...(a as Parameters<typeof rm>)),
  rename: (...a: unknown[]) => rename(...(a as Parameters<typeof rename>)),
}));

const createWriteStream = vi.fn(() => ({ __isFakeWritable: true }));
vi.mock('node:fs', () => ({
  createWriteStream: (...a: unknown[]) =>
    createWriteStream(...(a as Parameters<typeof createWriteStream>)),
}));

const pipeline = vi.fn().mockResolvedValue(undefined);
vi.mock('node:stream/promises', () => ({
  pipeline: (...a: unknown[]) => pipeline(...(a as Parameters<typeof pipeline>)),
}));

vi.mock('node:stream', () => ({ Readable: { fromWeb: (b: unknown) => ({ __webStream: b }) } }));

const GOOD_SIZE = 142_000_000;

// stat is consulted for two things now: fileReady(model) before/after a
// download, and the post-pipeline stat(partial) integrity check. Keep the
// mock path-aware so a "model missing, partial written" state is expressible.
function fileMissing(partialSize = GOOD_SIZE): void {
  stat.mockImplementation((p: string) =>
    p.endsWith('.partial')
      ? Promise.resolve({ isFile: () => true, size: partialSize })
      : Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
}
function filePresent(): void {
  stat.mockResolvedValue({ isFile: () => true, size: GOOD_SIZE });
}

function okFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    body: {},
    headers: { get: (h: string) => (h === 'content-length' ? String(GOOD_SIZE) : null) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  pipeline.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', okFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ensureWhisperModel', () => {
  it("returns 'ready' without fetching when the model file exists", async () => {
    filePresent();
    const { ensureWhisperModel } = await import('./whisperModel');
    await expect(ensureWhisperModel()).resolves.toBe('ready');
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 'downloading' and starts exactly one download when the file is missing", async () => {
    fileMissing();
    const { ensureWhisperModel } = await import('./whisperModel');
    const [a, b] = await Promise.all([ensureWhisperModel(), ensureWhisperModel()]);
    expect(a).toBe('downloading');
    expect(b).toBe('downloading');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(mkdir).toHaveBeenCalledWith('/userdata/models', { recursive: true });
  });

  it("writes to a .partial file and renames it into place on success", async () => {
    fileMissing();
    const { ensureWhisperModel } = await import('./whisperModel');
    await ensureWhisperModel();
    await vi.waitFor(() => expect(rename).toHaveBeenCalled());
    expect(createWriteStream).toHaveBeenCalledWith('/userdata/models/ggml-base.en.bin.partial');
    expect(rename).toHaveBeenCalledWith(
      '/userdata/models/ggml-base.en.bin.partial',
      '/userdata/models/ggml-base.en.bin',
    );
  });

  it("returns 'ready' on the next call once the downloaded file has landed", async () => {
    fileMissing();
    const { ensureWhisperModel } = await import('./whisperModel');
    await ensureWhisperModel();
    await vi.waitFor(() => expect(rename).toHaveBeenCalled());
    filePresent();
    await vi.waitFor(async () => {
      expect(await ensureWhisperModel()).toBe('ready');
    });
  });

  it("removes the .partial file and later returns 'error' when the download fails", async () => {
    fileMissing();
    pipeline.mockRejectedValue(new Error('socket hang up'));
    const { ensureWhisperModel } = await import('./whisperModel');

    expect(await ensureWhisperModel()).toBe('downloading');
    await vi.waitFor(() => expect(rm).toHaveBeenCalledWith('/userdata/models/ggml-base.en.bin.partial', { force: true }));

    // Poll: the download promise's .catch (sets lastFailed) and .finally
    // (clears inFlight) run a few microtasks after rm; until both settle
    // the call still reports 'downloading'. waitFor stops on the first
    // non-throwing run, and the inFlight guard means these polls start no
    // extra download.
    await vi.waitFor(async () => {
      expect(await ensureWhisperModel()).toBe('error');
    });
    // flag cleared by that successful call: the next one retries afresh
    expect(await ensureWhisperModel()).toBe('downloading');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("rejects an implausibly small download body and later returns 'error'", async () => {
    fileMissing(500);
    const { ensureWhisperModel } = await import('./whisperModel');

    expect(await ensureWhisperModel()).toBe('downloading');
    await vi.waitFor(() => expect(rm).toHaveBeenCalledWith('/userdata/models/ggml-base.en.bin.partial', { force: true }));
    expect(rename).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      expect(await ensureWhisperModel()).toBe('error');
    });
  });

  it("returns 'error' when fetch resolves non-ok", async () => {
    fileMissing();
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 503, body: null });
    const { ensureWhisperModel } = await import('./whisperModel');

    expect(await ensureWhisperModel()).toBe('downloading');
    await vi.waitFor(() => expect(rm).toHaveBeenCalled());
    await vi.waitFor(async () => {
      expect(await ensureWhisperModel()).toBe('error');
    });
  });
});
