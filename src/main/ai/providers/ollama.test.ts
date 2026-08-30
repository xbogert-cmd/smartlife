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
  // 'assist' so READ-tier tools in these tests run without pausing for
  // confirmation -- these tests are about tool-calling/result formatting,
  // not permission gating. The ask-mode gating case has its own dedicated
  // test below ("Ask mode gates READ-tier tools through runTool").
  return { db: {} as never, conversationId: 'c1', mode: 'assist' as const, requestConfirmation: vi.fn() };
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
    expect(toOllamaTools([tool], false)).toEqual([
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

    expect(result.content).toEqual([{ type: 'text', text: 'Hello!' }]);
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

    expect(result.content).toEqual([{ type: 'text', text: 'It is sunny.' }]);
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

    expect(result.content).toEqual([{ type: 'text', text: 'Hello!' }]);
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

  it('reports usage from the final done:true chunk of each round, summed across multiple rounds', async () => {
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
            prompt_eval_count: 50,
            eval_count: 8,
          },
        ])
      )
      .mockResolvedValueOnce(
        ndjsonResponse([
          { message: { role: 'assistant', content: 'It is sunny.' }, done: true, prompt_eval_count: 65, eval_count: 9 },
        ])
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOllamaProvider('http://localhost:11434', 'llama3.1');
    const result = await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'weather?',
      tools: [tool],
      ctx: fakeCtx(),
      onEvent: vi.fn(),
    });

    expect(result.content).toEqual([{ type: 'text', text: 'It is sunny.' }]);
    expect(result.usage).toEqual({ inputTokens: 115, outputTokens: 17 });
    expect(result.providerId).toBe('ollama');
    expect(result.model).toBe('llama3.1');
  });
});

describe('toOllamaTools vision gating', () => {
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
    expect(toOllamaTools(tools, false).map((t) => t.function.name)).toEqual(['a']);
  });

  it('keeps browser_screenshot when visionCapable is true', () => {
    expect(toOllamaTools(tools, true).map((t) => t.function.name)).toEqual(['a', 'browser_screenshot']);
  });
});

describe('vision via model-name detection', () => {
  const screenshotTool: ToolDefinition = {
    name: 'browser_screenshot',
    tier: 'READ',
    label: 'Screenshot',
    schema: { name: 'browser_screenshot', description: '', input_schema: { type: 'object', properties: {} } },
    run: async () => 'x',
  };

  it('offers browser_screenshot for a known vision model (e.g. llava)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([{ message: { role: 'assistant', content: 'ok' }, done: true }]));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOllamaProvider('http://localhost:11434', 'llava:13b');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [screenshotTool], ctx: fakeCtx(), onEvent: vi.fn() });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toContain('browser_screenshot');
  });

  it('does not offer browser_screenshot for a text-only model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([{ message: { role: 'assistant', content: 'ok' }, done: true }]));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOllamaProvider('http://localhost:11434', 'llama3.1');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [screenshotTool], ctx: fakeCtx(), onEvent: vi.fn() });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    // body.tools is `undefined` here, not `[]` -- the pre-existing
    // `tools: ollamaTools.length > 0 ? ollamaTools : undefined` line in
    // streamTurn (untouched by this task) omits an empty tools array
    // entirely rather than sending one. Either way the assertion's intent
    // holds: browser_screenshot is not offered.
    expect((body.tools ?? []).map((t: { function: { name: string } }) => t.function.name)).not.toContain('browser_screenshot');
  });

  it('does not send base64 image attachment data to a text-only model (Finding 1)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([{ message: { role: 'assistant', content: 'ok' }, done: true }]));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOllamaProvider('http://localhost:11434', 'llama3.1');
    await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'what is in this image?',
      attachments: [{ type: 'image', mimeType: 'image/png', data: 'abc' }],
      tools: [],
      ctx: fakeCtx(),
      onEvent: vi.fn(),
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const lastMessage = body.messages[body.messages.length - 1];
    expect(lastMessage.images).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('abc');
    expect(lastMessage.content).toContain('cannot see images');
  });

  it('does send base64 image attachment data to a known vision model (Finding 1)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjsonResponse([{ message: { role: 'assistant', content: 'ok' }, done: true }]));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOllamaProvider('http://localhost:11434', 'llava:13b');
    await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'what is in this image?',
      attachments: [{ type: 'image', mimeType: 'image/png', data: 'abc' }],
      tools: [],
      ctx: fakeCtx(),
      onEvent: vi.fn(),
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const lastMessage = body.messages[body.messages.length - 1];
    expect(lastMessage.images).toEqual(['abc']);
  });
});

describe('toOllamaMessages with attachments', () => {
  it('appends attachment text to the user message content and collects image data into the images field', () => {
    const messages = toOllamaMessages('sys', [], 'summarize this', [
      { type: 'text', text: 'pdf text' },
      { type: 'image', mimeType: 'image/png', data: 'abc' },
    ]);
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'summarize this\n\npdf text', images: ['abc'] });
  });

  it('leaves the user message unchanged when there are no attachments', () => {
    const messages = toOllamaMessages('sys', [], 'hi');
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('omits base64 image data and appends a short note instead when visionCapable is false', () => {
    const messages = toOllamaMessages(
      'sys',
      [],
      'what is in this image?',
      [{ type: 'image', mimeType: 'image/png', data: 'abc' }],
      false
    );
    const last = messages[messages.length - 1];
    expect(last.images).toBeUndefined();
    expect(last.content).toBe('what is in this image?\n\n(1 image attached, but this model cannot see images)');
  });

  it('still sends base64 image data in the images field when visionCapable is true', () => {
    const messages = toOllamaMessages(
      'sys',
      [],
      'what is in this image?',
      [{ type: 'image', mimeType: 'image/png', data: 'abc' }],
      true
    );
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'what is in this image?', images: ['abc'] });
  });
});

describe('screenshot round-trip', () => {
  it("injects a follow-up user message carrying the screenshot's base64 data after the tool call that attached it", async () => {
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        ndjsonResponse([
          {
            message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'browser_screenshot', arguments: {} } }] },
            done: true,
          },
        ])
      )
      .mockResolvedValueOnce(ndjsonResponse([{ message: { role: 'assistant', content: 'I can see the page now.' }, done: true }]));
    vi.stubGlobal('fetch', fetchMock);

    const ctx = fakeCtx() as import('../tools/types').ToolContext;
    ctx.pendingImages = [];
    ctx.attachImage = (block) => ctx.pendingImages!.push(block);

    const provider = createOllamaProvider('http://localhost:11434', 'llava:13b');
    const result = await provider.streamTurn({
      system: 's',
      history: [],
      userText: 'what do you see?',
      tools: [screenshotTool],
      ctx,
      onEvent: vi.fn(),
    });

    expect(result.content).toEqual([{ type: 'text', text: 'I can see the page now.' }]);
    const secondCallBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(secondCallBody.messages).toContainEqual({ role: 'user', content: '(image attached)', images: ['xyz'] });
    expect(ctx.pendingImages).toEqual([]);
  });

  it('resets ctx.pendingImages at the start of streamTurn so a stale image from a prior failed attempt never leaks in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ndjsonResponse([{ message: { role: 'assistant', content: 'ok' }, done: true }])));
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

    const provider = createOllamaProvider('http://localhost:11434', 'llama3.1');
    await provider.streamTurn({ system: 's', history: [], userText: 'hi', tools: [], ctx, onEvent: vi.fn() });

    expect(pendingImages).toEqual([]);
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

describe('Ask mode gates READ-tier tools through runTool', () => {
  it('pauses for confirmation before running a READ-tier tool when ctx.mode is ask', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(false);
    const run = vi.fn().mockResolvedValue('should not be reached');
    const tool: ToolDefinition = {
      name: 'get_settings',
      tier: 'READ',
      label: 'Reading settings',
      schema: { name: 'get_settings', description: '', input_schema: { type: 'object', properties: {} } },
      run,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        ndjsonResponse([
          {
            message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_settings', arguments: {} } }] },
            done: true,
          },
        ])
      )
      .mockResolvedValueOnce(ndjsonResponse([{ message: { role: 'assistant', content: 'declined' }, done: true }]));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createOllamaProvider('http://localhost:11434', 'llama3.1');
    const ctx = { db: {} as never, conversationId: 'c1', mode: 'ask' as const, requestConfirmation };
    await provider.streamTurn({ system: 's', history: [], userText: 'settings?', tools: [tool], ctx, onEvent: vi.fn() });

    expect(requestConfirmation).toHaveBeenCalledWith('get_settings', 'Reading settings', undefined);
    expect(run).not.toHaveBeenCalled();
  });
});
