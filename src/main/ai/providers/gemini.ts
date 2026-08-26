import { ApiError, GoogleGenAI, type Content, type FunctionDeclaration, type Part } from '@google/genai';
import type { ToolContext, ToolDefinition } from '../tools/types';
import { findCatalogEntry } from './catalog';
import {
  ProviderError,
  type AIProvider,
  type CanonicalContentBlock,
  type CanonicalTextBlock,
  type StreamEvent,
  type TurnMessage,
} from './types';

export function toFunctionDeclarations(tools: ToolDefinition[], visionCapable: boolean): FunctionDeclaration[] {
  return tools
    .filter((tool) => visionCapable || tool.schema.name !== 'browser_screenshot')
    .map((tool) => ({
      name: tool.schema.name,
      description: tool.schema.description,
      parametersJsonSchema: tool.schema.input_schema,
    }));
}

function attachmentsToParts(attachments: CanonicalContentBlock[]): Part[] {
  return attachments.map((block) =>
    block.type === 'text' ? { text: block.text } : { inlineData: { mimeType: block.mimeType, data: block.data } }
  );
}

/** Only plain text blocks ever cross the history boundary (see
 *  CanonicalTextBlock in types.ts) -- a canonical assistant turn becomes one
 *  'model'-role Content with a text Part per block. */
export function toGeminiHistory(history: TurnMessage[]): Content[] {
  return history.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: (Array.isArray(message.content) ? message.content : [])
      .filter((block): block is CanonicalTextBlock => {
        return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text';
      })
      .map((block) => ({ text: block.text })),
  }));
}

/** Gemini's own ApiError.message is already a clean, human-readable string --
 *  unlike Anthropic's, which nests it inside a stringified JSON body. */
export function describeError(error: unknown): string | null {
  return error instanceof ApiError ? error.message : null;
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
 * `apiKey` and `model` are fixed at construction -- same reasoning as
 * createClaudeProvider: a ranked fallback list can hold more than one Gemini
 * entry at different models, each needing its own instance.
 */
export function createGeminiProvider(apiKey: string, model: string): AIProvider {
  const client = new GoogleGenAI({ apiKey });

  return {
    async streamTurn({ system, history, userText, attachments, tools, ctx, onEvent }) {
      if (ctx.pendingImages) ctx.pendingImages.length = 0;

      const toolLabels = new Map(tools.map((tool) => [tool.schema.name, tool.label]));
      const visionCapable = findCatalogEntry('gemini', model)?.supportsVision ?? false;
      const webSearchCapable = findCatalogEntry('gemini', model)?.supportsWebSearch ?? false;
      const functionDeclarations = toFunctionDeclarations(tools, visionCapable);

      const configTools = [
        ...(functionDeclarations.length > 0 ? [{ functionDeclarations }] : []),
        ...(webSearchCapable ? [{ googleSearch: {} }] : []),
      ];

      const chat = client.chats.create({
        model,
        history: toGeminiHistory(history),
        config: {
          systemInstruction: system,
          tools: configTools.length > 0 ? configTools : undefined,
        },
      });

      let finalText = '';
      let nextMessage: Part[] | string =
        attachments && attachments.length > 0 ? [{ text: userText }, ...attachmentsToParts(attachments)] : userText;
      // Gemini's tool loop is manual, unlike Anthropic's toolRunner -- each
      // round sends one message and gets back either text or function calls
      // that must be answered before the model will continue. A hard cap
      // avoids ever looping forever against a model that keeps calling tools.
      const MAX_ROUNDS = 20;

      try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const stream = await chat.sendMessageStream({ message: nextMessage });
          let roundText = '';
          const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

          for await (const chunk of stream) {
            if (chunk.text) {
              onEvent({ type: 'text-delta', text: chunk.text } satisfies StreamEvent);
              roundText += chunk.text;
            }
            for (const call of chunk.functionCalls ?? []) {
              if (call.name) functionCalls.push({ name: call.name, args: call.args ?? {} });
            }
          }

          finalText = roundText;

          if (functionCalls.length === 0) break;

          for (const call of functionCalls) {
            const toolLabel = toolLabels.get(call.name) ?? call.name;
            onEvent({ type: 'tool-status', toolName: call.name, toolLabel } satisfies StreamEvent);
          }

          const responseParts: Part[] = await Promise.all(
            functionCalls.map(async (call) => ({
              functionResponse: {
                name: call.name,
                response: { output: await runOneTool(tools, ctx, call.name, call.args) },
              },
            }))
          );
          const pending = ctx.pendingImages ?? [];
          if (pending.length > 0) {
            responseParts.push(...pending.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } })));
            pending.length = 0;
          }
          nextMessage = responseParts;
        }
      } catch (error) {
        const message = describeError(error);
        throw message !== null ? new ProviderError(message) : error;
      }

      onEvent({ type: 'turn-complete' } satisfies StreamEvent);
      return [{ type: 'text', text: finalText }] satisfies CanonicalTextBlock[];
    },
  };
}
