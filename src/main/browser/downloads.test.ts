import { describe, expect, it, vi } from 'vitest';
import { createDownloadHandler, type DownloadItemLike, type DownloadRequest } from './downloads';

function fakeItem(overrides: Partial<Record<string, unknown>> = {}): DownloadItemLike & {
  setSavePath: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  return {
    getFilename: () => (overrides.filename as string) ?? 'syllabus.pdf',
    getTotalBytes: () => (overrides.size as number) ?? 1024,
    getURL: () => (overrides.url as string) ?? 'https://uncw.edu/syllabus.pdf',
    setSavePath: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
  };
}

describe('createDownloadHandler', () => {
  it('sets the save path and pauses synchronously, before awaiting the user', () => {
    let resolveConfirm: (value: boolean) => void = () => {};
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirm = resolve;
        })
    );
    const handler = createDownloadHandler({
      downloadsDir: '/Users/test/Downloads',
      confirm,
      onError: vi.fn(),
    });
    const item = fakeItem();

    handler(item);

    // Both must have happened by the time the handler returns.
    expect(item.setSavePath).toHaveBeenCalledWith('/Users/test/Downloads/syllabus.pdf');
    expect(item.pause).toHaveBeenCalledOnce();
    expect(item.resume).not.toHaveBeenCalled();
    resolveConfirm(false);
  });

  it('describes the download accurately in the confirmation request', async () => {
    const requests: DownloadRequest[] = [];
    const confirm = vi.fn(async (request: DownloadRequest) => {
      requests.push(request);
      return false;
    });
    const handler = createDownloadHandler({ downloadsDir: '/d', confirm, onError: vi.fn() });

    handler(fakeItem({ filename: 'notes.pdf', size: 52428800, url: 'https://x.test/notes.pdf' }));
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    expect(requests[0]).toEqual({
      filename: 'notes.pdf',
      sizeBytes: 52428800,
      sourceUrl: 'https://x.test/notes.pdf',
    });
  });

  it('resumes when the user approves', async () => {
    const handler = createDownloadHandler({
      downloadsDir: '/d',
      confirm: async () => true,
      onError: vi.fn(),
    });
    const item = fakeItem();

    handler(item);
    await vi.waitFor(() => expect(item.resume).toHaveBeenCalledOnce());
    expect(item.cancel).not.toHaveBeenCalled();
  });

  it('cancels when the user declines', async () => {
    const handler = createDownloadHandler({
      downloadsDir: '/d',
      confirm: async () => false,
      onError: vi.fn(),
    });
    const item = fakeItem();

    handler(item);
    await vi.waitFor(() => expect(item.cancel).toHaveBeenCalledOnce());
    expect(item.resume).not.toHaveBeenCalled();
  });

  it('cancels and reports when the confirmation itself fails', async () => {
    const onError = vi.fn();
    const handler = createDownloadHandler({
      downloadsDir: '/d',
      confirm: async () => {
        throw new Error('window closed');
      },
      onError,
    });
    const item = fakeItem();

    handler(item);
    await vi.waitFor(() => expect(item.cancel).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledOnce();
  });

  it('sanitizes a traversal filename before building the save path', async () => {
    const requests: DownloadRequest[] = [];
    const handler = createDownloadHandler({
      downloadsDir: '/Users/test/Downloads',
      confirm: async (request) => {
        requests.push(request);
        return false;
      },
      onError: vi.fn(),
    });
    const item = fakeItem({ filename: '../../../../etc/cron.d/evil' });

    handler(item);

    expect(item.setSavePath).toHaveBeenCalledWith('/Users/test/Downloads/evil');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    // The user is shown the name that will actually be written, not the
    // server's claim.
    expect(requests[0].filename).toBe('evil');
  });

  it('falls back to a safe name when nothing usable remains', () => {
    const handler = createDownloadHandler({
      downloadsDir: '/d',
      confirm: async () => false,
      onError: vi.fn(),
    });
    const item = fakeItem({ filename: '../' });

    handler(item);

    expect(item.setSavePath).toHaveBeenCalledWith('/d/download');
  });
});
