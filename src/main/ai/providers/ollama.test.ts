import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../tools/types';
import { createOllamaProvider, listOllamaModels, toOllamaMessages, toOllamaTools } from './ollama';
import { ProviderError } from './types';

afterEach(() => {
  vi.unstubAllGlobals();
});

function ndjsonResponse(lines: object[]): Response {
  const body = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  return new Response(body, { status: 200 });
}

function fakeCtx() {
  return { db: {} as never, conversationId: 'c1', mode: 'ask' as const, requestConfirmation: vi.fn() };
}

describe('toOllamaTools', () => {
  it('translates a ToolDefinition into an OpenAI-shaped function tool', () => {
    const tool: ToolDefinition = {
      name: 'get_weather',
      tier: 'READ',
      label: 'Get weather',
      schema: { name: 'get_weather', description: 'Gets the weather', input_schema: { type: 'object', properties: {} } },
      run: async () => 'sunny',
    };
    expect(toOllamaTools([tool])).toEqual([
      {
        type: 'function',
        function: { name: 'get_weather', description: 'Gets the weather', parameters: { type: 'object', properties: {} } },
      },
    ]);
  });
});

describe('toOllamaMessages', () => {
  it('puts the system prompt first, translates history text blocks, then the new user message', () => {
    const messages = toOllamaMessages(
      'You are helpful.',
      [
        { role: 'user', content: [{ type: 'text', text: 'earlier question' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] },
      ],
      'new question'
    );
    expect(messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'new question' },
    ]);
  });
});

describe('createOllamaProvider', () => {
  it('streams text and returns it as a canonical text block when no tools are called', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      ndjsonResponse([
        { message: { role: 'assistant', content: 'Hel' }, done: false },
        { message: { role: 'assistant', content: 'lo!' }, done: true },
      ])
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOllamaProvider('http://localhost:11434', 'llama3.1');
    const onEvent = vi.fn();
    const result = await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'hi',
      tools: [],
      ctx: fakeCtx(),
      onEvent,
    });

    expect(result).toEqual([{ type: 'text', text: 'Hello!' }]);
    expect(onEvent).toHaveBeenCalledWith({ type: 'text-delta', text: 'Hel' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'text-delta', text: 'lo!' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'turn-complete' });
  });

  it('runs a called tool and sends its result back before producing the final answer', async () => {
    const tool: ToolDefinition = {
      name: 'get_weather',
      tier: 'READ',
      label: 'Get weather',
      schema: { name: 'get_weather', description: 'd', input_schema: { type: 'object', properties: {} } },
      run: async () => 'Sunny, 72F',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        ndjsonResponse([
          {
            message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: {} } }] },
            done: true,
          },
        ])
      )
      .mockResolvedValueOnce(ndjsonResponse([{ message: { role: 'assistant', content: 'It is sunny.' }, done: true }]));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOllamaProvider('http://localhost:11434', 'llama3.1');
    const onEvent = vi.fn();
    const result = await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'weather?',
      tools: [tool],
      ctx: fakeCtx(),
      onEvent,
    });

    expect(result).toEqual([{ type: 'text', text: 'It is sunny.' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCallBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(secondCallBody.messages).toContainEqual({ role: 'tool', content: 'Sunny, 72F', tool_name: 'get_weather' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'tool-status', toolName: 'get_weather', toolLabel: 'Get weather' });
  });

  it('correctly reassembles an NDJSON line that arrives split across two stream reads', async () => {
    // Deliberately split a single JSON line mid-object, across two enqueued
    // chunks, to force the reader to receive it over two separate read()
    // calls -- proving the partial-line buffering logic actually works,
    // not just that a single-chunk Response happens to parse fine.
    const fullLine = JSON.stringify({ message: { role: 'assistant', content: 'Hello!' }, done: true }) + '\n';
    const splitPoint = Math.floor(fullLine.length / 2);
    const firstHalf = fullLine.slice(0, splitPoint);
    const secondHalf = fullLine.slice(splitPoint);

    // A `pull` callback (rather than enqueuing both chunks in `start`) is
    // required here: some ReadableStream/fetch implementations coalesce
    // chunks enqueued synchronously in `start` into a single reader.read(),
    // which would defeat the point of this test. `pull` is invoked once per
    // reader.read() call, so returning one chunk per pull genuinely forces
    // two separate reads.
    let chunksSent = 0;
    const chunks = [firstHalf, secondHalf].map((half) => new TextEncoder().encode(half));
    const stream = new ReadableStream({
      pull(controller) {
        if (chunksSent < chunks.length) {
          controller.enqueue(chunks[chunksSent]);
          chunksSent++;
        } else {
          controller.close();
        }
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    const provider = createOllamaProvider('http://localhost:11434', 'llama3.1');
    const onEvent = vi.fn();
    const result = await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'hi',
      tools: [],
      ctx: fakeCtx(),
      onEvent,
    });

    expect(result).toEqual([{ type: 'text', text: 'Hello!' }]);
    expect(onEvent).toHaveBeenCalledWith({ type: 'text-delta', text: 'Hello!' });
  });

  it('throws a clear ProviderError when Ollama is not reachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const provider = createOllamaProvider('http://localhost:11434', 'llama3.1');
    await expect(
      provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx: fakeCtx(), onEvent: vi.fn() })
    ).rejects.toThrow(ProviderError);
  });

  it('throws a clear ProviderError on a non-ok HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    const provider = createOllamaProvider('http://localhost:11434', 'not-pulled-model');
    await expect(
      provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx: fakeCtx(), onEvent: vi.fn() })
    ).rejects.toThrow(ProviderError);
  });
});

describe('listOllamaModels', () => {
  it('returns the locally-pulled model names', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5:7b' }] }), { status: 200 }))
    );
    const models = await listOllamaModels('http://localhost:11434');
    expect(models).toEqual([{ name: 'llama3.1:8b' }, { name: 'qwen2.5:7b' }]);
  });
});
