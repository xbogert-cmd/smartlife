import { describe, expect, it, vi } from 'vitest';
import { ApiError, GoogleGenAI } from '@google/genai';
import type { ToolDefinition } from '../tools/types';
import { createGeminiProvider, describeError, toFunctionDeclarations, toGeminiHistory } from './gemini';

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return { ...actual, GoogleGenAI: vi.fn() };
});

function fakeStream(chunks: Array<{ text?: string; functionCalls?: Array<{ name: string; args: Record<string, unknown> }> }>) {
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
    expect(toFunctionDeclarations([tool])).toEqual([
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

    expect(result).toEqual([{ type: 'text', text: 'Hello!' }]);
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

    expect(result).toEqual([{ type: 'text', text: 'It is sunny.' }]);
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
    expect(result).toEqual([{ type: 'text', text: '' }]);
    expect(sendMessageStream).toHaveBeenCalledTimes(20);
  });
});
