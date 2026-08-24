import type { ToolContext, ToolDefinition } from '../tools/types';
import { ProviderError, type AIProvider, type CanonicalTextBlock, type StreamEvent, type TurnMessage } from './types';

interface OllamaTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
}

interface OllamaChatChunk {
  message: OllamaMessage;
  done: boolean;
}

export function toOllamaTools(tools: ToolDefinition[]): OllamaTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.schema.name,
      description: tool.schema.description,
      parameters: tool.schema.input_schema,
    },
  }));
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is CanonicalTextBlock => {
      return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text';
    })
    .map((block) => block.text)
    .join('');
}

export function toOllamaMessages(system: string, history: TurnMessage[], userText: string): OllamaMessage[] {
  return [
    { role: 'system', content: system },
    ...history.map((m) => ({ role: m.role, content: textOf(m.content) }) as OllamaMessage),
    { role: 'user', content: userText },
  ];
}

/** Ollama's own body isn't valid JSON as a whole -- one JSON object per
 *  line, the last one carrying done:true. */
async function readChatStream(
  response: Response,
  onTextDelta: (text: string) => void
): Promise<{ content: string; toolCalls: OllamaMessage['tool_calls'] }> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError('Ollama returned no response body.');
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let toolCalls: OllamaMessage['tool_calls'];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const chunk = JSON.parse(line) as OllamaChatChunk;
      if (chunk.message.content) {
        onTextDelta(chunk.message.content);
        content += chunk.message.content;
      }
      if (chunk.message.tool_calls && chunk.message.tool_calls.length > 0) {
        toolCalls = chunk.message.tool_calls;
      }
    }
  }

  return { content, toolCalls };
}

async function runOneTool(
  tools: ToolDefinition[],
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const tool = tools.find((t) => t.schema.name === name);
  if (!tool) return `Unknown tool: ${name}`;
  return tool.run(args, ctx);
}

/**
 * `endpoint` and `model` are fixed at construction. Unlike the cloud
 * providers, there is no API key -- Ollama is trusted purely by which
 * machine can reach the endpoint, same as any other localhost service.
 */
export function createOllamaProvider(endpoint: string, model: string): AIProvider {
  return {
    async streamTurn({ system, history, userText, tools, ctx, onEvent }) {
      const toolLabels = new Map(tools.map((tool) => [tool.schema.name, tool.label]));
      const ollamaTools = toOllamaTools(tools);
      const messages = toOllamaMessages(system, history, userText);

      let finalText = '';
      // Same manual-tool-loop safety valve as gemini.ts -- a hard cap so a
      // model that keeps calling tools can never loop this turn forever.
      const MAX_ROUNDS = 20;

      try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const response = await fetch(`${endpoint}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model,
              messages,
              tools: ollamaTools.length > 0 ? ollamaTools : undefined,
              stream: true,
            }),
          });
          if (!response.ok) {
            throw new ProviderError(
              `Ollama returned an error (${response.status}). Is the model pulled and Ollama running?`
            );
          }

          const { content, toolCalls } = await readChatStream(response, (text) => {
            onEvent({ type: 'text-delta', text } satisfies StreamEvent);
          });
          finalText = content;
          messages.push({ role: 'assistant', content });

          if (!toolCalls || toolCalls.length === 0) break;

          for (const call of toolCalls) {
            const toolLabel = toolLabels.get(call.function.name) ?? call.function.name;
            onEvent({ type: 'tool-status', toolName: call.function.name, toolLabel } satisfies StreamEvent);
            const result = await runOneTool(tools, ctx, call.function.name, call.function.arguments);
            messages.push({ role: 'tool', content: result, tool_name: call.function.name });
          }
        }
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (error instanceof TypeError) {
          // fetch() throws a plain TypeError for a connection-level failure
          // (e.g. nothing listening at this endpoint) -- a normal, expected
          // fallback trigger, not a bug to show a raw stack trace for.
          throw new ProviderError(`Couldn't reach Ollama at ${endpoint}. Is it running?`);
        }
        throw error;
      }

      onEvent({ type: 'turn-complete' } satisfies StreamEvent);
      return [{ type: 'text', text: finalText }] satisfies CanonicalTextBlock[];
    },
  };
}

export interface OllamaModelInfo {
  name: string;
}

/** Powers Settings' live model dropdown -- what's actually pulled locally,
 *  not a static catalog (see catalog.ts). */
export async function listOllamaModels(endpoint: string): Promise<OllamaModelInfo[]> {
  const response = await fetch(`${endpoint}/api/tags`);
  if (!response.ok) throw new Error(`Ollama returned an error (${response.status}).`);
  const body = (await response.json()) as { models?: Array<{ name?: string }> };
  return (body.models ?? [])
    .filter((m): m is { name: string } => typeof m.name === 'string')
    .map((m) => ({ name: m.name }));
}
