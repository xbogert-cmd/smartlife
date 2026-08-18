import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestConfirmation, resolveConfirmation } from './confirmations';

describe('confirmation round-trip', () => {
  it('resolves true when resolveConfirmation is called with approved=true', async () => {
    const sent: Array<{ id: string; toolName: string; description: string }> = [];
    const promise = requestConfirmation((payload) => sent.push(payload), 'set_theme', 'Set theme to dark');
    expect(sent).toHaveLength(1);
    expect(sent[0].toolName).toBe('set_theme');
    resolveConfirmation(sent[0].id, true);
    await expect(promise).resolves.toBe(true);
  });

  it('resolves false when resolveConfirmation is called with approved=false', async () => {
    const sent: Array<{ id: string; toolName: string; description: string }> = [];
    const promise = requestConfirmation((payload) => sent.push(payload), 'clear_conversation_history', 'Clear history');
    resolveConfirmation(sent[0].id, false);
    await expect(promise).resolves.toBe(false);
  });

  it('ignores resolveConfirmation for an unknown id without throwing', () => {
    expect(() => resolveConfirmation('unknown-id', true)).not.toThrow();
  });
});

describe('confirmation timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-resolves to false if resolveConfirmation is never called', async () => {
    const sent: Array<{ id: string; toolName: string; description: string }> = [];
    const promise = requestConfirmation((payload) => sent.push(payload), 'set_theme', 'Set theme to dark');

    await vi.advanceTimersByTimeAsync(120_000);

    await expect(promise).resolves.toBe(false);
  });

  it('does not double-resolve or throw when the timeout fires after resolveConfirmation already settled it', async () => {
    const sent: Array<{ id: string; toolName: string; description: string }> = [];
    const promise = requestConfirmation((payload) => sent.push(payload), 'set_theme', 'Set theme to dark');

    resolveConfirmation(sent[0].id, true);
    await expect(promise).resolves.toBe(true);

    expect(() => vi.advanceTimersByTime(120_000)).not.toThrow();
    await expect(promise).resolves.toBe(true);
  });
});
