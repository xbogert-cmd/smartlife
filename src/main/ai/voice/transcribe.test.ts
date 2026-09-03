import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

const execFile = vi.fn();
// This repo's electron+vite test setup only surfaces a node: builtin mock to a
// production `import { x } from 'node:...'` when a matching `default` object is
// returned too (see pickAttachment.test.ts / submit.test.ts for the same dance).
vi.mock('node:child_process', () => {
  const impl = (...a: unknown[]): unknown => execFile(...a);
  return { execFile: impl, default: { execFile: impl } };
});

const ensureWhisperModel = vi.fn();
vi.mock('./whisperModel', () => ({ ensureWhisperModel: () => ensureWhisperModel() }));

vi.mock('./whisperPaths', () => ({
  whisperBinPath: () => '/bin/whisper-cli',
  whisperModelPath: () => '/models/ggml-base.en.bin',
}));

const mkdtemp = vi.fn().mockResolvedValue('/tmp/smartlife-voice-abc');
const writeFile = vi.fn().mockResolvedValue(undefined);
const rm = vi.fn().mockResolvedValue(undefined);
vi.mock('node:fs/promises', () => {
  const members = {
    mkdtemp: (...a: unknown[]) => mkdtemp(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
    rm: (...a: unknown[]) => rm(...a),
  };
  return { ...members, default: members };
});

// promisify(execFile) calls execFile(file, args, opts, cb). Drive cb from the
// queued result so the production code can stay on the promise form.
function execFileYields(result: { stdout?: string; error?: Error & { stderr?: string } }): void {
  execFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (e: unknown, r?: unknown) => void) => {
    if (result.error) cb(result.error);
    else cb(null, { stdout: result.stdout ?? '', stderr: '' });
  });
}

const db = {} as Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  ensureWhisperModel.mockResolvedValue('ready');
  execFileYields({ stdout: 'hello there' });
});

afterEach(() => {
  vi.resetModules();
});

describe('transcribeAudio', () => {
  it('rejects a non-WAV mime type without touching the model or the binary', async () => {
    const { transcribeAudio } = await import('./transcribe');
    const result = await transcribeAudio(db, 'base64', 'audio/webm');
    expect(result).toEqual({ ok: false, reason: 'Unsupported audio format.' });
    expect(ensureWhisperModel).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("returns the setup message and does not run whisper while the model is downloading", async () => {
    ensureWhisperModel.mockResolvedValue('downloading');
    const { transcribeAudio } = await import('./transcribe');
    const result = await transcribeAudio(db, 'base64', 'audio/wav');
    expect(result).toEqual({ ok: false, reason: 'Setting up voice (one-time, ~140 MB download)…' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns a download-failed message when the model could not be fetched', async () => {
    ensureWhisperModel.mockResolvedValue('error');
    const { transcribeAudio } = await import('./transcribe');
    const result = await transcribeAudio(db, 'base64', 'audio/wav');
    expect(result).toEqual({
      ok: false,
      reason: "Couldn't download the voice model. Check your connection and try again.",
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('writes the decoded WAV to a temp file, runs whisper-cli, and returns the trimmed transcript', async () => {
    execFileYields({ stdout: '  hello   there \n' });
    const { transcribeAudio, whisperArgs } = await import('./transcribe');
    const result = await transcribeAudio(db, Buffer.from('wavbytes').toString('base64'), 'audio/wav');

    expect(result).toEqual({ ok: true, text: 'hello there' });
    expect(writeFile).toHaveBeenCalledWith('/tmp/smartlife-voice-abc/audio.wav', expect.any(Buffer));
    expect(execFile).toHaveBeenCalledWith(
      '/bin/whisper-cli',
      whisperArgs('/models/ggml-base.en.bin', '/tmp/smartlife-voice-abc/audio.wav'),
      expect.objectContaining({ timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }),
      expect.any(Function),
    );
  });

  it('reports an empty transcript as "couldn\'t hear anything"', async () => {
    execFileYields({ stdout: '   \n  ' });
    const { transcribeAudio } = await import('./transcribe');
    const result = await transcribeAudio(db, 'base64', 'audio/wav');
    expect(result).toEqual({ ok: false, reason: "Couldn't hear anything in that recording." });
  });

  it('returns a failure with the stderr tail when whisper-cli exits non-zero', async () => {
    execFileYields({ error: Object.assign(new Error('exit 1'), { stderr: 'whisper: init\nfailed to load model\n' }) });
    const { transcribeAudio } = await import('./transcribe');
    const result = await transcribeAudio(db, 'base64', 'audio/wav');
    expect(result).toEqual({ ok: false, reason: 'Voice transcription failed: failed to load model' });
  });

  it('removes the temp dir on success and on failure', async () => {
    const { transcribeAudio } = await import('./transcribe');
    await transcribeAudio(db, 'base64', 'audio/wav');
    expect(rm).toHaveBeenCalledWith('/tmp/smartlife-voice-abc', { recursive: true, force: true });

    rm.mockClear();
    execFileYields({ error: new Error('boom') });
    await transcribeAudio(db, 'base64', 'audio/wav');
    expect(rm).toHaveBeenCalledWith('/tmp/smartlife-voice-abc', { recursive: true, force: true });
  });

  describe('whisperArgs', () => {
    it('pins the flag list', async () => {
      const { whisperArgs } = await import('./transcribe');
      expect(whisperArgs('/m/model.bin', '/t/a.wav')).toEqual([
        '-m', '/m/model.bin', '-f', '/t/a.wav', '-np', '-nt',
      ]);
    });
  });
});
