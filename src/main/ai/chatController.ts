import type { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { getAiMode } from './mode';
import { appendMessage, getMessages, setConversationTitleIfUnset } from './conversation';
import { requestConfirmation as requestToolConfirmation } from './confirmations';
import { TOOLS } from './tools/registry';
import { getProvider } from './router';
import { takeAttachments } from './attachments/pickAttachment';
import type { ToolContext } from './tools/types';
import {
  ProviderError,
  type AIProvider,
  type CanonicalContentBlock,
  type CanonicalImageBlock,
  type StreamEvent,
} from './providers/types';
import { buildSystemPrompt, type ViewContext } from './viewContext';
import { notifyIfUnfocused } from '../notify';
import { logError } from '../log';

/** One entry per conversation currently mid-turn -- lets two different
 *  conversations send concurrently while still serializing turns within the
 *  same conversation (a second send to a conversation already in flight gets
 *  the "still working" reply instead of starting a second stream). */
const conversationsInFlight = new Set<string>();

export async function handleSendMessage(
  db: Database.Database,
  getWindow: () => BrowserWindow | null,
  userText: string,
  view: ViewContext | null,
  conversationId: string,
  options: { attachmentIds?: string[]; provider?: AIProvider } = {}
): Promise<void> {
  const { attachmentIds = [], provider = getProvider(db) } = options;
  const send = (event: StreamEvent): void => getWindow()?.webContents.send('ai:stream-event', event);

  if (conversationsInFlight.has(conversationId)) {
    send({ type: 'text-delta', text: 'Still working on the last message — try again in a moment.' });
    send({ type: 'turn-complete' });
    return;
  }

  conversationsInFlight.add(conversationId);
  try {
    const mode = getAiMode(db);
    const history = getMessages(db, conversationId).map((m) => ({
      role: m.role,
      content: JSON.parse(m.content) as unknown,
    }));

    const pendingImages: CanonicalImageBlock[] = [];
    const ctx: ToolContext = {
      db,
      conversationId,
      mode,
      pendingImages,
      attachImage: (block) => {
        pendingImages.push(block);
      },
      requestConfirmation: (toolName, description, timeoutMs) => {
        // If there's no window to show a confirmation UI in, there's no way for the
        // user to ever approve — resolve as declined instead of parking the promise
        // forever in confirmations.ts's pending map.
        if (!getWindow()) return Promise.resolve(false);
        notifyIfUnfocused(getWindow(), 'SmartLife needs your approval', description);
        return requestToolConfirmation(
          (payload) => getWindow()?.webContents.send('ai:confirm-request', payload),
          toolName,
          description,
          timeoutMs
        );
      },
    };

    const { blocks: attachments, persistedTextBlocks, imagePlaceholders } = takeAttachments(attachmentIds);

    try {
      const finalContent = await provider.streamTurn({
        system: buildSystemPrompt(db, view),
        history,
        userText,
        attachments: attachments.length > 0 ? attachments : undefined,
        tools: TOOLS,
        ctx,
        onEvent: send,
      });
      const userContent: CanonicalContentBlock[] = [
        { type: 'text', text: userText },
        ...persistedTextBlocks,
        ...(imagePlaceholders.length > 0 ? [{ type: 'text' as const, text: imagePlaceholders.join('\n') }] : []),
      ];
      appendMessage(db, conversationId, 'user', userContent);
      setConversationTitleIfUnset(db, conversationId, userText);
      appendMessage(db, conversationId, 'assistant', finalContent);
    } catch (error) {
      // Every other main-process error path (browser, sync, downloads) is
      // persisted via logError so it survives past the session that hit it --
      // this one previously only went to console.error, which a packaged app
      // launched outside a terminal has no way to ever show anyone.
      logError('ai:turn-failed', error);
      // A provider opts into showing its own message (e.g. "credit balance
      // too low") by throwing ProviderError specifically -- anything else,
      // including a genuine bug, stays generic rather than putting a raw
      // internal error message in front of the user.
      const text = error instanceof ProviderError ? error.message : 'Something went wrong — try again.';
      send({ type: 'text-delta', text });
      send({ type: 'turn-complete' });
    }
  } finally {
    conversationsInFlight.delete(conversationId);
  }
}
