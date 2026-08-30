// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import Anthropic, { APIError } from '@anthropic-ai/sdk';
import { createClaudeProvider, describeError, toBetaTools } from './claude';

vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>();
  return { ...actual, default: vi.fn() };
});

function fakeCtx() {
  // 'assist' so READ-tier tools in these tests run without pausing for
  // confirmation -- these tests are about tool-calling/result formatting,
  // not permission gating. The ask-mode gating case has its own dedicated
  // test below ("Ask mode gates READ-tier tools through runTool").
  return { db: {} as never, conversationId: 'c1', mode: 'assist' as const, requestConfirmation: vi.fn() };
}

/** An empty async-iterable runner -- the streamTurn `for await` loop body
 *  never executes, finalText stays '', and streamTurn resolves cleanly.
 *  Enough to inspect what was PASSED to toolRunner without simulating the
 *  SDK's real streaming/tool-call machinery. */
function emptyRunner() {
  return (async function* () {})();
}

function fakeMessageStream(finalMessage: {
  content: Array<{ type: 'text'; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
}) {
  return {
    [Symbol.asyncIterator]: () => (async function* () {})(),
    finalMessage: async () => finalMessage,
  };
}

describe('describeError', () => {
  it('extracts the nested message from a real Anthropic API error shape', () => {
    const error = new APIError(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } },
      undefined,
      new Headers(),
      'invalid_request_error'
    );
    expect(describeError(error)).toBe('Your credit balance is too low to access the Anthropic API.');
  });

  it('returns null for an error that is not from the Anthropic SDK', () => {
    expect(describeError(new Error('some unrelated bug'))).toBeNull();
    expect(describeError('not even an Error instance')).toBeNull();
  });

  it('returns null when the API error body has no nested message', () => {
    const error = new APIError(500, { type: 'error' }, undefined, new Headers(), null);
    expect(describeError(error)).toBeNull();
  });
});

describe('createClaudeProvider', () => {
  it('returns a provider with a streamTurn function', () => {
    const provider = createClaudeProvider('sk-ant-test', 'claude-sonnet-5');
    expect(typeof provider.streamTurn).toBe('function');
  });
});

describe('createClaudeProvider — usage tracking', () => {
  it('reports usage summed across every round the tool runner yields, and the identity it was constructed with', async () => {
    const round1 = fakeMessageStream({
      content: [{ type: 'text', text: '' }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const round2 = fakeMessageStream({
      content: [{ type: 'text', text: 'final answer' }],
      usage: { input_tokens: 130, output_tokens: 15 },
    });
    const toolRunner = vi.fn().mockReturnValue(
      (async function* () {
        yield round1;
        yield round2;
      })()
    );
    vi.mocked(Anthropic).mockReturnValue({ beta: { messages: { toolRunner } } } as never);

    const provider = createClaudeProvider('sk-ant-test', 'claude-sonnet-5');
    const result = await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'hi',
      tools: [],
      ctx: fakeCtx(),
      onEvent: vi.fn(),
    });

    expect(result.content).toEqual([{ type: 'text', text: 'final answer' }]);
    expect(result.usage).toEqual({ inputTokens: 230, outputTokens: 35 });
    expect(result.providerId).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-5');
  });
});

describe('web search capability', () => {
  it('adds the hosted web_search tool for a model whose catalog entry supports it', async () => {
    const toolRunner = vi.fn().mockReturnValue(emptyRunner());
    vi.mocked(Anthropic).mockReturnValue({ beta: { messages: { toolRunner } } } as never);

    const provider = createClaudeProvider('sk-ant-test', 'claude-sonnet-5');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx: fakeCtx(), onEvent: vi.fn() });

    const passedTools = toolRunner.mock.calls[0][0].tools;
    expect(passedTools).toContainEqual({ type: 'web_search_20260209', name: 'web_search' });
  });

  it('omits web_search for a model whose catalog entry does not support it', async () => {
    const toolRunner = vi.fn().mockReturnValue(emptyRunner());
    vi.mocked(Anthropic).mockReturnValue({ beta: { messages: { toolRunner } } } as never);

    const provider = createClaudeProvider('sk-ant-test', 'claude-haiku-4-5-20251001');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx: fakeCtx(), onEvent: vi.fn() });

    const passedTools = toolRunner.mock.calls[0][0].tools as Array<{ type?: string }>;
    expect(passedTools.some((t) => typeof t.type === 'string' && t.type.startsWith('web_search_'))).toBe(false);
  });
});

describe('toBetaTools vision gating', () => {
  const tools: import('../tools/types').ToolDefinition[] = [
    { name: 'a', tier: 'READ', label: 'A', schema: { name: 'a', description: '', input_schema: { type: 'object', properties: {} } }, run: async () => 'x' },
    {
      name: 'browser_screenshot',
      tier: 'READ',
      label: 'Screenshot',
      schema: { name: 'browser_screenshot', description: '', input_schema: { type: 'object', properties: {} } },
      run: async () => 'x',
    },
  ];

  it('drops browser_screenshot when visionCapable is false', () => {
    const wrapped = toBetaTools(tools, fakeCtx(), false);
    expect(wrapped.map((t) => t.name)).toEqual(['a']);
  });

  it('keeps browser_screenshot when visionCapable is true', () => {
    const wrapped = toBetaTools(tools, fakeCtx(), true);
    expect(wrapped.map((t) => t.name)).toEqual(['a', 'browser_screenshot']);
  });
});

describe('screenshot tool results', () => {
  it("wraps a tool's plain string result as a multi-block array when it attached an image via ctx", async () => {
    const ctx = fakeCtx() as import('../tools/types').ToolContext;
    ctx.pendingImages = [];
    ctx.attachImage = (block) => ctx.pendingImages!.push(block);
    const screenshotTool: import('../tools/types').ToolDefinition = {
      name: 'browser_screenshot',
      tier: 'READ',
      label: 'Screenshot',
      schema: { name: 'browser_screenshot', description: '', input_schema: { type: 'object', properties: {} } },
      run: async (_input, toolCtx) => {
        toolCtx.attachImage?.({ type: 'image', mimeType: 'image/png', data: 'abc123' });
        return 'Screenshot captured.';
      },
    };

    const wrapped = toBetaTools([screenshotTool], ctx, true);
    const result = await wrapped[0].run({});

    expect(result).toEqual([
      { type: 'text', text: 'Screenshot captured.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
    ]);
  });

  it('returns a plain string when the tool attached no image', async () => {
    const ctx = fakeCtx() as import('../tools/types').ToolContext;
    ctx.pendingImages = [];
    const plainTool: import('../tools/types').ToolDefinition = {
      name: 'a',
      tier: 'READ',
      label: 'A',
      schema: { name: 'a', description: '', input_schema: { type: 'object', properties: {} } },
      run: async () => 'plain result',
    };

    const wrapped = toBetaTools([plainTool], ctx, true);
    const result = await wrapped[0].run({});

    expect(result).toBe('plain result');
  });

  it('resets ctx.pendingImages at the start of streamTurn so a stale image from a prior failed attempt never leaks in', async () => {
    const toolRunner = vi.fn().mockReturnValue(emptyRunner());
    vi.mocked(Anthropic).mockReturnValue({ beta: { messages: { toolRunner } } } as never);
    // Built the same way production's chatController.ts builds ctx: attachImage
    // closes over a captured local array, not a dynamic `ctx.pendingImages`
    // lookup. This is what makes the assertion below actually distinguish
    // in-place truncation (`pendingImages.length = 0`, correct) from
    // reassignment (`ctx.pendingImages = []`, would orphan this closure).
    const pendingImages: import('../tools/types').CanonicalImageBlock[] = [
      { type: 'image', mimeType: 'image/png', data: 'stale' },
    ];
    const ctx = {
      ...fakeCtx(),
      pendingImages,
      attachImage: (block: import('../tools/types').CanonicalImageBlock) => pendingImages.push(block),
    } as import('../tools/types').ToolContext;

    const provider = createClaudeProvider('sk-ant-test', 'claude-sonnet-5');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx, onEvent: vi.fn() });

    expect(pendingImages).toEqual([]);
  });
});

describe('attachments', () => {
  it('folds attachments into the first user message as content blocks', async () => {
    const toolRunner = vi.fn().mockReturnValue(emptyRunner());
    vi.mocked(Anthropic).mockReturnValue({ beta: { messages: { toolRunner } } } as never);

    const provider = createClaudeProvider('sk-ant-test', 'claude-sonnet-5');
    await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'summarize this',
      attachments: [
        { type: 'text', text: 'extracted pdf text' },
        { type: 'image', mimeType: 'image/png', data: 'abc123' },
      ],
      tools: [],
      ctx: fakeCtx(),
      onEvent: vi.fn(),
    });

    const messages = toolRunner.mock.calls[0][0].messages as Array<{ content: unknown }>;
    expect(messages[messages.length - 1].content).toEqual([
      { type: 'text', text: 'summarize this' },
      { type: 'text', text: 'extracted pdf text' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
    ]);
  });

  it('sends userText as a plain string when there are no attachments (unchanged behavior)', async () => {
    const toolRunner = vi.fn().mockReturnValue(emptyRunner());
    vi.mocked(Anthropic).mockReturnValue({ beta: { messages: { toolRunner } } } as never);

    const provider = createClaudeProvider('sk-ant-test', 'claude-sonnet-5');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx: fakeCtx(), onEvent: vi.fn() });

    const messages = toolRunner.mock.calls[0][0].messages as Array<{ content: unknown }>;
    expect(messages[messages.length - 1].content).toBe('hi');
  });
});

describe('Ask mode gates READ-tier tools through runTool', () => {
  it('pauses for confirmation before running a READ-tier tool when ctx.mode is ask', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(false);
    const run = vi.fn().mockResolvedValue('should not be reached');
    const tool: import('../tools/types').ToolDefinition = {
      name: 'get_settings',
      tier: 'READ',
      label: 'Reading settings',
      schema: { name: 'get_settings', description: '', input_schema: { type: 'object', properties: {} } },
      run,
    };
    const toolRunner = vi.fn().mockReturnValue(
      (async function* () {
        yield fakeMessageStream({
          content: [{ type: 'text', text: 'declined' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      })()
    );
    vi.mocked(Anthropic).mockReturnValue({ beta: { messages: { toolRunner } } } as never);

    const provider = createClaudeProvider('sk-ant-test', 'claude-sonnet-5');
    const ctx = { db: {} as never, conversationId: 'c1', mode: 'ask' as const, requestConfirmation };
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [tool], ctx, onEvent: vi.fn() });

    // toolRunner is constructed with the tool's `run` wrapped by runTool --
    // invoke it the way the SDK would, to prove gating actually happens.
    const toolsPassed = toolRunner.mock.calls[0][0].tools;
    const wrappedRun = toolsPassed[0].run as (input: Record<string, unknown>) => Promise<unknown>;
    const result = await wrappedRun({});

    expect(requestConfirmation).toHaveBeenCalledWith('get_settings', 'Reading settings', undefined);
    expect(run).not.toHaveBeenCalled();
    expect(result).toBe('The user declined, so this was not checked.');
  });
});
