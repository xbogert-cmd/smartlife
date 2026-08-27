import Anthropic, { APIError } from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import type { ToolContext, ToolDefinition } from '../tools/types';
import { findCatalogEntry } from './catalog';
import { ProviderError, type AIProvider, type CanonicalTextBlock, type StreamEvent, type TurnResult } from './types';

export function toBetaTools(tools: ToolDefinition[], ctx: ToolContext, visionCapable: boolean) {
  return tools
    .filter((tool) => visionCapable || tool.schema.name !== 'browser_screenshot')
    .map((tool) =>
      betaTool({
        name: tool.schema.name,
        description: tool.schema.description,
        inputSchema: tool.schema.input_schema as { type: 'object'; [key: string]: unknown },
        run: async (input: Record<string, unknown>) => {
          const text = await tool.run(input, ctx);
          const pending = ctx.pendingImages ?? [];
          if (pending.length === 0) return text;
          const images = pending.splice(0, pending.length);
          return [
            { type: 'text' as const, text },
            ...images.map((image) => ({
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: image.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                data: image.data,
              },
            })),
          ];
        },
      })
    );
}

function toAnthropicContentBlocks(attachments: import('./types').CanonicalContentBlock[]) {
  return attachments.map((block) =>
    block.type === 'text'
      ? { type: 'text' as const, text: block.text }
      : {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: block.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
            data: block.data,
          },
        }
  );
}

/**
 * The SDK's own Error.message is the raw response JSON stringified (its
 * makeMessage() only reads a top-level `.message`, but Anthropic's actual
 * error body nests it one level deeper under `.error.message`) -- not
 * something to show a person. Anthropic-specific error shape stays here,
 * not in chatController.ts, so a second provider never has to know about it.
 */
export function describeError(error: unknown): string | null {
  if (!(error instanceof APIError)) return null;
  const body = error.error as { error?: { message?: unknown } } | undefined;
  const message = body?.error?.message;
  return typeof message === 'string' ? message : null;
}

/**
 * `apiKey` and `model` are fixed at construction, not passed per-call -- a
 * ranked fallback list can hold more than one Claude entry at different
 * models, each needing its own provider instance, and every other provider
 * needs a differently-shaped credential the generic AIProvider interface has
 * no business knowing about.
 */
export function createClaudeProvider(apiKey: string, model: string): AIProvider {
  const client = new Anthropic({ apiKey });

  return {
    async streamTurn({ system, history, userText, attachments, tools, ctx, onEvent }) {
      if (ctx.pendingImages) ctx.pendingImages.length = 0;

      const toolLabels = new Map(tools.map((tool) => [tool.schema.name, tool.label]));
      const visionCapable = findCatalogEntry('anthropic', model)?.supportsVision ?? false;
      const webSearchCapable = findCatalogEntry('anthropic', model)?.supportsWebSearch ?? false;

      const userContent =
        attachments && attachments.length > 0
          ? [{ type: 'text' as const, text: userText }, ...toAnthropicContentBlocks(attachments)]
          : userText;

      const messages = [...history, { role: 'user' as const, content: userContent }] as unknown as Anthropic.Beta.Messages.BetaMessageParam[];

      const runnerTools: Array<ReturnType<typeof betaTool> | { type: 'web_search_20260209'; name: 'web_search' }> = [
        ...toBetaTools(tools, ctx, visionCapable),
      ];
      if (webSearchCapable) runnerTools.push({ type: 'web_search_20260209', name: 'web_search' });

      const runner = client.beta.messages.toolRunner({
        model,
        max_tokens: 4096,
        system,
        tools: runnerTools,
        messages,
        stream: true,
      });

      let finalText = '';
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      try {
        for await (const messageStream of runner) {
          for await (const event of messageStream) {
            if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
              const toolName = event.content_block.name;
              const toolLabel = toolLabels.get(toolName) ?? toolName;
              onEvent({ type: 'tool-status', toolName, toolLabel } satisfies StreamEvent);
            }
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              onEvent({ type: 'text-delta', text: event.delta.text } satisfies StreamEvent);
            }
          }
          const finalMessage = await messageStream.finalMessage();
          finalText = finalMessage.content
            .filter((block): block is Anthropic.Beta.Messages.BetaTextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('');
          totalInputTokens += finalMessage.usage.input_tokens;
          totalOutputTokens += finalMessage.usage.output_tokens;
        }
      } catch (error) {
        const message = describeError(error);
        throw message !== null ? new ProviderError(message) : error;
      }

      onEvent({ type: 'turn-complete' } satisfies StreamEvent);
      return {
        content: [{ type: 'text', text: finalText }],
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        providerId: 'anthropic',
        model,
      } satisfies TurnResult;
    },
  };
}
