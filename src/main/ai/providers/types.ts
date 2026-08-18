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

export interface AIProvider {
  streamTurn(params: {
    apiKey: string;
    history: TurnMessage[];
    userText: string;
    tools: ToolDefinition[];
    ctx: ToolContext;
    onEvent: (event: StreamEvent) => void;
  }): Promise<unknown>; // resolves to the final assistant message's content blocks
}
