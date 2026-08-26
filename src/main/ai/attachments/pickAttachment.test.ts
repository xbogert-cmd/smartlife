import { describe, expect, it, vi, beforeEach } from 'vitest';

const showOpenDialog = vi.fn();
vi.mock('electron', () => ({ dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) } }));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const readFile = vi.fn();
  // Matches submit.test.ts's existing pattern: a plain `{ ...actual, readFile }`
  // mock doesn't reach pickAttachment.ts's `import { readFile } from
  // 'node:fs/promises'` in this repo's electron+vite test setup -- the
  // named-export override is only visible when a `default` object carrying
  // the same override is present too.
  return { ...actual, readFile, default: { ...actual, readFile } };
});

describe('pickAttachment', () => {
  beforeEach(async () => {
    showOpenDialog.mockReset();
    // Reset call history too -- the mocked readFile is a single vi.fn()
    // instance shared across every test in this file (module-level, per the
    // vi.mock factory above), so without this a later test asserting
    // `not.toHaveBeenCalled()` sees calls left over from an earlier test.
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockReset();
  });

  it('returns null when the dialog is cancelled', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const { pickAttachment } = await import('./pickAttachment');
    expect(await pickAttachment(null, true)).toBeNull();
  });

  it('extracts .txt content directly and returns an ok result with a text block pending', async () => {
    const { readFile } = await import('node:fs/promises');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/notes.txt'] });
    vi.mocked(readFile).mockResolvedValue('some notes' as never);
    const { pickAttachment, takeAttachments } = await import('./pickAttachment');
    const result = await pickAttachment(null, true);
    expect(result).toMatchObject({ ok: true, name: 'notes.txt', kind: 'text' });
    if (result?.ok !== true) throw new Error('expected ok');
    const { blocks, placeholders } = takeAttachments([result.id]);
    expect(blocks).toEqual([{ type: 'text', text: 'some notes' }]);
    expect(placeholders[0]).toContain('notes.txt');
  });

  it('rejects an image file when supportsVision is false, without opening the file', async () => {
    const { readFile } = await import('node:fs/promises');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/photo.png'] });
    const { pickAttachment } = await import('./pickAttachment');
    const result = await pickAttachment(null, false);
    expect(result).toMatchObject({ ok: false });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('reads an image file into a base64 image block when supportsVision is true', async () => {
    const { readFile } = await import('node:fs/promises');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/photo.png'] });
    vi.mocked(readFile).mockResolvedValue(Buffer.from('fake-bytes') as never);
    const { pickAttachment, takeAttachments } = await import('./pickAttachment');
    const result = await pickAttachment(null, true);
    expect(result).toMatchObject({ ok: true, kind: 'image' });
    if (result?.ok !== true) throw new Error('expected ok');
    const { blocks } = takeAttachments([result.id]);
    expect(blocks).toEqual([{ type: 'image', mimeType: 'image/png', data: Buffer.from('fake-bytes').toString('base64') }]);
  });

  it('rejects an unsupported extension', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/archive.zip'] });
    const { pickAttachment } = await import('./pickAttachment');
    const result = await pickAttachment(null, true);
    expect(result).toMatchObject({ ok: false });
  });

  it('takeAttachments only redeems an id once, and ignores an unknown id', async () => {
    const { readFile } = await import('node:fs/promises');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/notes.txt'] });
    vi.mocked(readFile).mockResolvedValue('x' as never);
    const { pickAttachment, takeAttachments } = await import('./pickAttachment');
    const result = await pickAttachment(null, true);
    if (result?.ok !== true) throw new Error('expected ok');
    expect(takeAttachments([result.id]).blocks).toHaveLength(1);
    expect(takeAttachments([result.id]).blocks).toHaveLength(0);
    expect(takeAttachments(['not-a-real-id']).blocks).toHaveLength(0);
  });
});
