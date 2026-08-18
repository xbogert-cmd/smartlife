import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import type { ToolContext, ToolDefinition } from '../tools/types';
import type { AIProvider, StreamEvent } from './types';

const MODEL = 'claude-sonnet-5';

function toBetaTools(tools: ToolDefinition[], ctx: ToolContext) {
  return tools.map((tool) =>
    betaTool({
      name: tool.schema.name,
      description: tool.schema.description,
      // ToolSchema.input_schema is typed as a loose Record by Task 4; betaTool's helper
      // requires a JSON Schema literal with `type: 'object'` to infer parameter types,
      // which the app-level ToolSchema type doesn't encode. Our tool inputs are always
      // plain objects at runtime, so this cast is safe.
      inputSchema: tool.schema.input_schema as { type: 'object'; [key: string]: unknown },
      run: async (input: Record<string, unknown>) => tool.run(input, ctx),
    })
  );
}

export const claudeProvider: AIProvider = {
  async streamTurn({ apiKey, history, userText, tools, ctx, onEvent }) {
    const client = new Anthropic({ apiKey });
    const toolLabels = new Map(tools.map((tool) => [tool.schema.name, tool.label]));

    // TurnMessage.content is `unknown` (it round-trips through JSON storage in
    // conversation.ts); the tool runner's params expect the SDK's own
    // BetaMessageParam content shape (string | content-block array), which is
    // exactly what's stored there at runtime. Cast through `unknown` since
    // TypeScript can't see that relationship across the module boundary.
    const messages = [...history, { role: 'user' as const, content: userText }] as unknown as Anthropic.Beta.Messages.BetaMessageParam[];

    const runner = client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 4096,
      tools: toBetaTools(tools, ctx),
      messages,
      stream: true,
    });

    let finalContent: unknown = [{ type: 'text', text: '' }];

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
      finalContent = finalMessage.content;
    }

    onEvent({ type: 'turn-complete' } satisfies StreamEvent);
    return finalContent;
  },
};
