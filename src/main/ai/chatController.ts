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
import { buildSystemPrompt, type ViewContext } from './viewContext';
import { notifyIfUnfocused } from '../notify';
import { logError } from '../log';

// ponytail: single in-flight flag, only one conversation exists app-wide today.
// Upgrade to a Set keyed by conversation id if multi-conversation support lands.
let turnInFlight = false;

export async function handleSendMessage(
  db: Database.Database,
  getWindow: () => BrowserWindow | null,
  userText: string,
  view: ViewContext | null,
  provider: AIProvider = getProvider()
): Promise<void> {
  const send = (event: StreamEvent): void => getWindow()?.webContents.send('ai:stream-event', event);

  if (turnInFlight) {
    send({ type: 'text-delta', text: 'Still working on the last message — try again in a moment.' });
    send({ type: 'turn-complete' });
    return;
  }

  const apiKey = getStoredApiKey(db);
  if (!apiKey) {
    send({ type: 'text-delta', text: 'No API key configured — add one in Settings.' });
    send({ type: 'turn-complete' });
    return;
  }

  turnInFlight = true;
  try {
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

    try {
      const finalContent = await provider.streamTurn({
        apiKey,
        system: buildSystemPrompt(db, view),
        history,
        userText,
        tools: TOOLS,
        ctx,
        onEvent: send,
      });
      appendMessage(db, conversationId, 'user', [{ type: 'text', text: userText }]);
      appendMessage(db, conversationId, 'assistant', finalContent as unknown[]);
    } catch (error) {
      // Every other main-process error path (browser, sync, downloads) is
      // persisted via logError so it survives past the session that hit it --
      // this one previously only went to console.error, which a packaged app
      // launched outside a terminal has no way to ever show anyone.
      logError('ai:turn-failed', error);
      send({ type: 'text-delta', text: 'Something went wrong — try again.' });
      send({ type: 'turn-complete' });
    }
  } finally {
    turnInFlight = false;
  }
}
