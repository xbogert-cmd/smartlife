import type { ToolContext, ToolDefinition } from '../tools/types';

export interface StreamEvent {
  type: 'text-delta' | 'tool-status' | 'turn-complete' | 'provider-switched';
  text?: string;
  toolName?: string;
  toolLabel?: string;
  from?: string;
  to?: string;
  reason?: string;
}

export interface TurnMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

/**
 * The only content-block shape any provider may read from or write to
 * conversation history. This -- not any provider's own SDK-native blocks --
 * is what gets persisted to ai_messages and handed back as `history` on a
 * later turn, so a second provider (whether on the next turn or after a
 * fallback) never needs to understand a different provider's format.
 */
export interface CanonicalTextBlock {
  type: 'text';
  text: string;
}

export type ProviderId = 'anthropic' | 'gemini' | 'ollama';

/**
 * Thrown by a provider to show its own message to the user verbatim, instead
 * of the generic "Something went wrong" fallback -- e.g. Anthropic's "credit
 * balance too low", which the user needs to actually read to know what to do
 * next. Anything else a provider throws stays generic; a raw error message
 * from an unrelated bug is not something to show a person.
 */
export class ProviderError extends Error {}

export interface AIProvider {
  streamTurn(params: {
    system: string;
    history: TurnMessage[];
    userText: string;
    tools: ToolDefinition[];
    ctx: ToolContext;
    onEvent: (event: StreamEvent) => void;
  }): Promise<CanonicalTextBlock[]>;
}
