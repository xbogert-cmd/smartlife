import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@google/genai';
import type { ToolDefinition } from '../tools/types';
import { createGeminiProvider, describeError, toFunctionDeclarations, toGeminiHistory } from './gemini';

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
