import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { CanonicalContentBlock, CanonicalTextBlock } from '../providers/types';
import { extractDocxText, extractPdfText } from './extractText';

interface PendingAttachment {
  placeholder: string;
  block: CanonicalContentBlock;
}

export type PickAttachmentResult =
  | { ok: true; id: string; name: string; kind: 'text' | 'image' }
  | { ok: false; reason: string };

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// Same allow-list-by-id pattern as canvas/ipc.ts's pickedFilePaths -- an id
// only exists here if this module's own picker issued it.
const pending = new Map<string, PendingAttachment>();
let counter = 0;

export async function pickAttachment(
  window: BrowserWindow | null,
  supportsVision: boolean
): Promise<PickAttachmentResult | null> {
  const dialogOptions: OpenDialogOptions = {
    properties: ['openFile'],
    filters: [{ name: 'Documents & Images', extensions: ['pdf', 'docx', 'txt', 'png', 'jpg', 'jpeg', 'gif', 'webp'] }],
  };
  const result = window ? await dialog.showOpenDialog(window, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];
  const name = basename(filePath);
  const ext = extname(filePath).toLowerCase();

  try {
    if (ext in IMAGE_MIME) {
      if (!supportsVision) {
        return {
          ok: false,
          reason: "The current AI model can't see images — switch to a vision-capable model in Settings to attach images.",
        };
      }
      const buffer = await readFile(filePath);
      const id = `attach-${++counter}`;
      pending.set(id, {
        placeholder: `[attached: ${name} — image]`,
        block: { type: 'image', mimeType: IMAGE_MIME[ext], data: buffer.toString('base64') },
      });
      return { ok: true, id, name, kind: 'image' };
    }

    let text: string;
    if (ext === '.pdf') text = await extractPdfText(await readFile(filePath));
    else if (ext === '.docx') text = await extractDocxText(await readFile(filePath));
    else if (ext === '.txt') text = (await readFile(filePath, 'utf8')) as string;
    else return { ok: false, reason: `Unsupported file type: ${ext || 'unknown'}.` };

    const trimmed = text.trim();
    if (trimmed.length === 0) return { ok: false, reason: `Couldn't find any readable text in ${name}.` };

    const id = `attach-${++counter}`;
    pending.set(id, {
      placeholder: `[attached: ${name} — ${trimmed.length.toLocaleString()} chars extracted]`,
      block: { type: 'text', text: trimmed },
    });
    return { ok: true, id, name, kind: 'text' };
  } catch {
    return { ok: false, reason: `Couldn't read ${name}.` };
  }
}

/** Redeems each id at most once -- an unknown or already-redeemed id is
 *  silently skipped rather than erroring, since a send that races a stale
 *  attachment chip in the renderer should still succeed with what's left.
 *  Text attachments' full content is returned for persistence
 *  (persistedTextBlocks); image attachments only ever leave a placeholder
 *  note behind (imagePlaceholders) -- their bytes are turn-scoped only, see
 *  CanonicalContentBlock's doc comment in providers/types.ts. */
export function takeAttachments(ids: string[]): {
  blocks: CanonicalContentBlock[];
  persistedTextBlocks: CanonicalTextBlock[];
  imagePlaceholders: string[];
} {
  const blocks: CanonicalContentBlock[] = [];
  const persistedTextBlocks: CanonicalTextBlock[] = [];
  const imagePlaceholders: string[] = [];
  for (const id of ids) {
    const attachment = pending.get(id);
    if (!attachment) continue;
    blocks.push(attachment.block);
    if (attachment.block.type === 'text') {
      persistedTextBlocks.push(attachment.block);
    } else {
      imagePlaceholders.push(attachment.placeholder);
    }
    pending.delete(id);
  }
  return { blocks, persistedTextBlocks, imagePlaceholders };
}
