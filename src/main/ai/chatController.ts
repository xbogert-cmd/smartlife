import type { BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { getStoredApiKey } from './apiKey';
import { getAiMode } from './mode';
import { getOrCreateConversationId, appendMessage, getMessages } from './conversation';
import { requestConfirmation as requestToolConfirmation } from './confirmations';
import { TOOLS } from './tools/registry';
import { getProvider } from './router';
import type { ToolContext } from './tools/types';
import type { AIProvider, StreamEvent } from './providers/types';

export async function handleSendMessage(
  db: Database.Database,
  getWindow: () => BrowserWindow | null,
  userText: string,
  provider: AIProvider = getProvider()
): Promise<void> {
  const send = (event: StreamEvent): void => getWindow()?.webContents.send('ai:stream-event', event);

  const apiKey = getStoredApiKey(db);
  if (!apiKey) {
    send({ type: 'text-delta', text: 'No API key configured — add one in Settings.' });
    send({ type: 'turn-complete' });
    return;
  }

  const conversationId = getOrCreateConversationId(db);
  const mode = getAiMode(db);
  const history = getMessages(db, conversationId).map((m) => ({
    role: m.role,
    content: JSON.parse(m.content) as unknown,
  }));

  const ctx: ToolContext = {
    db,
    conversationId,
    mode,
    requestConfirmation: (toolName, description) => {
      // If there's no window to show a confirmation UI in, there's no way for the
      // user to ever approve — resolve as declined instead of parking the promise
      // forever in confirmations.ts's pending map.
      if (!getWindow()) return Promise.resolve(false);
      return requestToolConfirmation((payload) => getWindow()?.webContents.send('ai:confirm-request', payload), toolName, description);
    },
  };

  try {
    const finalContent = await provider.streamTurn({ apiKey, history, userText, tools: TOOLS, ctx, onEvent: send });
    appendMessage(db, conversationId, 'user', [{ type: 'text', text: userText }]);
    appendMessage(db, conversationId, 'assistant', finalContent as unknown[]);
  } catch (error) {
    console.error('AI turn failed:', error);
    send({ type: 'text-delta', text: 'Something went wrong — try again.' });
    send({ type: 'turn-complete' });
  }
}
