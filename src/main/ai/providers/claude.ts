import Anthropic, { APIError } from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import type { ToolContext, ToolDefinition } from '../tools/types';
import { ProviderError, type AIProvider, type CanonicalTextBlock, type StreamEvent } from './types';

function toBetaTools(tools: ToolDefinition[], ctx: ToolContext) {
  return tools.map((tool) =>
    betaTool({
      name: tool.schema.name,
      description: tool.schema.description,
      inputSchema: tool.schema.input_schema as { type: 'object'; [key: string]: unknown },
      run: async (input: Record<string, unknown>) => tool.run(input, ctx),
    })
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
  // This code only ever runs in the Electron main process, which never has a
  // `window`/`document`/`navigator` global -- but the repo's vitest config
  // runs every test (main and renderer alike) under a jsdom environment,
  // which does provide those globals and trips the SDK's browser-credential
  // guard on construction. The guard exists to stop this key from being
  // bundled into a page served to a browser, which cannot happen here.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  return {
    async streamTurn({ system, history, userText, tools, ctx, onEvent }) {
      const toolLabels = new Map(tools.map((tool) => [tool.schema.name, tool.label]));

      const messages = [...history, { role: 'user' as const, content: userText }] as unknown as Anthropic.Beta.Messages.BetaMessageParam[];

      const runner = client.beta.messages.toolRunner({
        model,
        max_tokens: 4096,
        system,
        tools: toBetaTools(tools, ctx),
        messages,
        stream: true,
      });

      let finalText = '';

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
