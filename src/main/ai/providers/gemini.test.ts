import { describe, expect, it, vi } from 'vitest';
import { ApiError, GoogleGenAI } from '@google/genai';
import type { ToolContext, ToolDefinition } from '../tools/types';
import { createGeminiProvider, describeError, toFunctionDeclarations, toGeminiHistory } from './gemini';

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return { ...actual, GoogleGenAI: vi.fn() };
});

function fakeStream(
  chunks: Array<{
    text?: string;
    functionCalls?: Array<{ name: string; args: Record<string, unknown> }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  }>
) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

function fakeCtx() {
  return { db: {} as never, conversationId: 'c1', mode: 'ask' as const, requestConfirmation: vi.fn() };
}

describe('describeError', () => {
  it('returns the message from a real Gemini ApiError', () => {
    const error = new ApiError({ message: 'API key not valid.', status: 400 });
    expect(describeError(error)).toBe('API key not valid.');
  });

  it('returns null for an error that is not from the Gemini SDK', () => {
    expect(describeError(new Error('some unrelated bug'))).toBeNull();
    expect(describeError('not even an Error instance')).toBeNull();
  });
});

describe('toFunctionDeclarations', () => {
  it('translates a ToolDefinition into a Gemini function declaration using the JSON Schema verbatim', () => {
    const tool: ToolDefinition = {
      name: 'get_weather',
      tier: 'READ',
      label: 'Get weather',
      schema: {
        name: 'get_weather',
        description: 'Gets the weather for a city',
        input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
      run: async () => 'sunny',
    };
    expect(toFunctionDeclarations([tool], true)).toEqual([
      {
        name: 'get_weather',
        description: 'Gets the weather for a city',
        parametersJsonSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    ]);
  });
});

describe('toGeminiHistory', () => {
  it('maps assistant to the "model" role and keeps user as "user"', () => {
    const history = toGeminiHistory([
      { role: 'user', content: [{ type: 'text', text: 'question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ]);
    expect(history).toEqual([
      { role: 'user', parts: [{ text: 'question' }] },
      { role: 'model', parts: [{ text: 'answer' }] },
    ]);
  });

  it('ignores a non-text block rather than throwing', () => {
    const history = toGeminiHistory([{ role: 'assistant', content: [{ type: 'tool_use', id: 'x' }] }]);
    expect(history).toEqual([{ role: 'model', parts: [] }]);
  });
});

describe('createGeminiProvider', () => {
  it('returns a provider with a streamTurn function', () => {
    const provider = createGeminiProvider('test-gemini-key', 'gemini-2.5-flash');
    expect(typeof provider.streamTurn).toBe('function');
  });
});

describe('createGeminiProvider — streamTurn tool-calling loop', () => {
  it('streams text and returns it as a canonical text block when no tools are called', async () => {
    const sendMessageStream = vi.fn().mockResolvedValue(fakeStream([{ text: 'Hel' }, { text: 'lo!' }]));
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    vi.mocked(GoogleGenAI).mockReturnValue({ chats: { create } } as never);

    const provider = createGeminiProvider('test-key', 'gemini-2.5-flash');
    const onEvent = vi.fn();
    const result = await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx: fakeCtx(), onEvent });

    expect(result.content).toEqual([{ type: 'text', text: 'Hello!' }]);
    expect(onEvent).toHaveBeenCalledWith({ type: 'text-delta', text: 'Hel' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'text-delta', text: 'lo!' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'turn-complete' });
    expect(sendMessageStream).toHaveBeenCalledTimes(1);
  });

  it('runs a called tool and sends its result back before producing the final answer', async () => {
    const tool: import('../tools/types').ToolDefinition = {
      name: 'get_weather',
      tier: 'READ',
      label: 'Get weather',
      schema: { name: 'get_weather', description: 'd', input_schema: { type: 'object', properties: {} } },
      run: async () => 'Sunny, 72F',
    };
    const sendMessageStream = vi
      .fn()
      .mockResolvedValueOnce(fakeStream([{ functionCalls: [{ name: 'get_weather', args: { city: 'Tokyo' } }] }]))
      .mockResolvedValueOnce(fakeStream([{ text: 'It is sunny.' }]));
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    vi.mocked(GoogleGenAI).mockReturnValue({ chats: { create } } as never);

    const provider = createGeminiProvider('test-key', 'gemini-2.5-flash');
    const onEvent = vi.fn();
    const result = await provider.streamTurn({ system: 's', history: [], userText: 'weather?', tools: [tool], ctx: fakeCtx(), onEvent });

    expect(result.content).toEqual([{ type: 'text', text: 'It is sunny.' }]);
    expect(sendMessageStream).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledWith({ type: 'tool-status', toolName: 'get_weather', toolLabel: 'Get weather' });
    // The second call's message must carry the tool's real result back as a functionResponse Part.
    const secondCallArgs = sendMessageStream.mock.calls[1][0];
    expect(secondCallArgs.message).toEqual([
      { functionResponse: { name: 'get_weather', response: { output: 'Sunny, 72F' } } },
    ]);
  });

  it('stops at MAX_ROUNDS instead of looping forever against a model that keeps calling tools', async () => {
    const tool: import('../tools/types').ToolDefinition = {
      name: 'loop_tool',
      tier: 'READ',
      label: 'Loop tool',
      schema: { name: 'loop_tool', description: 'd', input_schema: { type: 'object', properties: {} } },
      run: async () => 'called again',
    };
    // Every round returns another function call, never a final text-only response.
    const sendMessageStream = vi.fn().mockImplementation(() =>
      Promise.resolve(fakeStream([{ functionCalls: [{ name: 'loop_tool', args: {} }] }]))
    );
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    vi.mocked(GoogleGenAI).mockReturnValue({ chats: { create } } as never);

    const provider = createGeminiProvider('test-key', 'gemini-2.5-flash');
    const result = await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [tool], ctx: fakeCtx(), onEvent: vi.fn() });

    // Never crashes or hangs -- terminates at the cap and returns whatever
    // text existed at that point (empty here, since every round was a
    // function call with no text).
    expect(result.content).toEqual([{ type: 'text', text: '' }]);
    expect(sendMessageStream).toHaveBeenCalledTimes(20);
  });

  it('reports usage summed across every round of a multi-round function-calling turn', async () => {
    const tool: import('../tools/types').ToolDefinition = {
      name: 'get_weather',
      tier: 'READ',
      label: 'Get weather',
      schema: { name: 'get_weather', description: 'd', input_schema: { type: 'object', properties: {} } },
      run: async () => 'Sunny, 72F',
    };
    const sendMessageStream = vi
      .fn()
      .mockResolvedValueOnce(
        fakeStream([
          { functionCalls: [{ name: 'get_weather', args: { city: 'Tokyo' } }] },
          { usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 10 } },
        ])
      )
      .mockResolvedValueOnce(
        fakeStream([
          { text: 'It is sunny.' },
          { usageMetadata: { promptTokenCount: 95, candidatesTokenCount: 12 } },
        ])
      );
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    vi.mocked(GoogleGenAI).mockReturnValue({ chats: { create } } as never);

    const provider = createGeminiProvider('test-key', 'gemini-2.5-flash');
    const result = await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'weather?',
      tools: [tool],
      ctx: fakeCtx(),
      onEvent: vi.fn(),
    });

    expect(result.content).toEqual([{ type: 'text', text: 'It is sunny.' }]);
    expect(result.usage).toEqual({ inputTokens: 175, outputTokens: 22 });
    expect(result.providerId).toBe('gemini');
    expect(result.model).toBe('gemini-2.5-flash');
  });
});

describe('toFunctionDeclarations vision gating', () => {
  const tools: ToolDefinition[] = [
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
    expect(toFunctionDeclarations(tools, false).map((d) => d.name)).toEqual(['a']);
  });

  it('keeps browser_screenshot when visionCapable is true', () => {
    expect(toFunctionDeclarations(tools, true).map((d) => d.name)).toEqual(['a', 'browser_screenshot']);
  });
});

describe('search grounding', () => {
  it('adds googleSearch to the tools config when supportsWebSearch is true for the model', async () => {
    const sendMessageStream = vi.fn().mockResolvedValue(fakeStream([{ text: 'hi' }]));
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    vi.mocked(GoogleGenAI).mockReturnValue({ chats: { create } } as never);

    const provider = createGeminiProvider('test-key', 'gemini-2.5-flash'); // supportsWebSearch: true per catalog.ts
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx: fakeCtx(), onEvent: vi.fn() });

    const configTools = create.mock.calls[0][0].config.tools as Array<Record<string, unknown>>;
    expect(configTools.some((t) => 'googleSearch' in t)).toBe(true);
  });

  it('omits googleSearch and sends no tools config at all for a model not in the static catalog (findCatalogEntry returns undefined, defaulting supportsWebSearch to false)', async () => {
    const sendMessageStream = vi.fn().mockResolvedValue(fakeStream([{ text: 'hi' }]));
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    vi.mocked(GoogleGenAI).mockReturnValue({ chats: { create } } as never);

    const provider = createGeminiProvider('test-key', 'some-future-gemini-model');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx: fakeCtx(), onEvent: vi.fn() });

    expect(create.mock.calls[0][0].config.tools).toBeUndefined();
  });
});

describe('attachments', () => {
  it('folds text and image attachments into the first sendMessageStream call as extra Parts', async () => {
    const sendMessageStream = vi.fn().mockResolvedValue(fakeStream([{ text: 'ok' }]));
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    vi.mocked(GoogleGenAI).mockReturnValue({ chats: { create } } as never);

    const provider = createGeminiProvider('test-key', 'gemini-2.5-flash');
    await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'summarize this',
      attachments: [
        { type: 'text', text: 'pdf text' },
        { type: 'image', mimeType: 'image/png', data: 'abc' },
      ],
      tools: [],
      ctx: fakeCtx(),
      onEvent: vi.fn(),
    });

    expect(sendMessageStream.mock.calls[0][0].message).toEqual([
      { text: 'summarize this' },
      { text: 'pdf text' },
      { inlineData: { mimeType: 'image/png', data: 'abc' } },
    ]);
  });

  it('sends userText as a plain string when there are no attachments (unchanged behavior)', async () => {
    const sendMessageStream = vi.fn().mockResolvedValue(fakeStream([{ text: 'ok' }]));
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    vi.mocked(GoogleGenAI).mockReturnValue({ chats: { create } } as never);

    const provider = createGeminiProvider('test-key', 'gemini-2.5-flash');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx: fakeCtx(), onEvent: vi.fn() });

    expect(sendMessageStream.mock.calls[0][0].message).toBe('hi');
  });
});

describe('screenshot round-trip', () => {
  it('injects a pending screenshot image as an inlineData Part in the round AFTER the tool call that attached it', async () => {
    const screenshotTool: ToolDefinition = {
      name: 'browser_screenshot',
      tier: 'READ',
      label: 'Screenshot',
      schema: { name: 'browser_screenshot', description: '', input_schema: { type: 'object', properties: {} } },
      run: async (_input, toolCtx) => {
        toolCtx.attachImage?.({ type: 'image', mimeType: 'image/png', data: 'xyz' });
        return 'Screenshot captured.';
      },
    };
    const sendMessageStream = vi
      .fn()
      .mockResolvedValueOnce(fakeStream([{ functionCalls: [{ name: 'browser_screenshot', args: {} }] }]))
      .mockResolvedValueOnce(fakeStream([{ text: 'I can see the page now.' }]));
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    vi.mocked(GoogleGenAI).mockReturnValue({ chats: { create } } as never);

    const ctx = fakeCtx() as ToolContext;
    ctx.pendingImages = [];
    ctx.attachImage = (block) => ctx.pendingImages!.push(block);

    const provider = createGeminiProvider('test-key', 'gemini-2.5-flash');
    const result = await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'what do you see?',
      tools: [screenshotTool],
      ctx,
      onEvent: vi.fn(),
    });

    expect(result.content).toEqual([{ type: 'text', text: 'I can see the page now.' }]);
    expect(sendMessageStream.mock.calls[1][0].message).toEqual([
      { functionResponse: { name: 'browser_screenshot', response: { output: 'Screenshot captured.' } } },
      { inlineData: { mimeType: 'image/png', data: 'xyz' } },
    ]);
    expect(ctx.pendingImages).toEqual([]);
  });

  it('resets ctx.pendingImages at the start of streamTurn so a stale image from a prior failed attempt never leaks in', async () => {
    const sendMessageStream = vi.fn().mockResolvedValue(fakeStream([{ text: 'ok' }]));
    const create = vi.fn().mockReturnValue({ sendMessageStream });
    vi.mocked(GoogleGenAI).mockReturnValue({ chats: { create } } as never);

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
    } as ToolContext;

    const provider = createGeminiProvider('test-key', 'gemini-2.5-flash');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx, onEvent: vi.fn() });

    expect(pendingImages).toEqual([]);
  });
});
