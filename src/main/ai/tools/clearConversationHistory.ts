import { clearMessages } from '../conversation';
import { gate } from '../permissions';
import type { ToolDefinition } from './types';

export const clearConversationHistoryTool: ToolDefinition = {
  name: 'clear_conversation_history',
  tier: 'CONSEQUENTIAL',
  label: 'Clearing conversation history',
  schema: {
    name: 'clear_conversation_history',
    description: 'Permanently delete every message in the current conversation. This cannot be undone.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async run(_input, ctx) {
    const approved = await gate(
      'CONSEQUENTIAL',
      ctx.mode,
      'clear_conversation_history',
      'Permanently delete all conversation history. This cannot be undone.',
      ctx.requestConfirmation
    );
    if (!approved) return 'User declined this action.';
    clearMessages(ctx.db, ctx.conversationId);
    return 'Conversation history cleared.';
  },
};
