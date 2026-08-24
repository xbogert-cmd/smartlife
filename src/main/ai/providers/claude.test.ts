import { describe, expect, it } from 'vitest';
import { APIError } from '@anthropic-ai/sdk';
import { describeError } from './claude';

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

import { createClaudeProvider } from './claude';

describe('createClaudeProvider', () => {
  it('returns a provider with a streamTurn function', () => {
    const provider = createClaudeProvider('sk-ant-test', 'claude-sonnet-5');
    expect(typeof provider.streamTurn).toBe('function');
  });
});
