import type { ToolContext, ToolDefinition } from '../tools/types';

export interface StreamEvent {
  type: 'text-delta' | 'tool-status' | 'turn-complete';
  text?: string;
  toolName?: string;
  toolLabel?: string;
}

export interface TurnMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

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
    apiKey: string;
    system: string;
    history: TurnMessage[];
    userText: string;
    tools: ToolDefinition[];
    ctx: ToolContext;
    onEvent: (event: StreamEvent) => void;
  }): Promise<unknown>; // resolves to the final assistant message's content blocks
}
