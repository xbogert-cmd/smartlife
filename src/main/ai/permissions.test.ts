import { describe, expect, it, vi } from 'vitest';
import { resolveExecutionMode, gate } from './permissions';
import type { AiMode, ToolTier } from './permissions';

describe('resolveExecutionMode', () => {
  const cases: Array<[ToolTier, AiMode, 'auto' | 'pause']> = [
    ['READ', 'ask', 'auto'],
    ['READ', 'assist', 'auto'],
    ['READ', 'auto', 'auto'],
    ['SAFE_WRITE', 'ask', 'pause'],
    ['SAFE_WRITE', 'assist', 'auto'],
    ['SAFE_WRITE', 'auto', 'auto'],
    ['CONSEQUENTIAL', 'ask', 'pause'],
    ['CONSEQUENTIAL', 'assist', 'pause'],
    ['CONSEQUENTIAL', 'auto', 'auto'],
  ];

  it.each(cases)('tier=%s mode=%s -> %s', (tier, mode, expected) => {
    expect(resolveExecutionMode(tier, mode)).toBe(expected);
  });
});

describe('gate', () => {
  it('resolves true immediately without confirming when the tier auto-executes', async () => {
    const requestConfirmation = vi.fn();
    const approved = await gate('READ', 'ask', 'get_settings', 'Read settings', requestConfirmation);
    expect(approved).toBe(true);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('calls requestConfirmation and returns its result when the tier requires a pause', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(true);
    const approved = await gate('SAFE_WRITE', 'ask', 'set_theme', 'Set theme to dark', requestConfirmation);
    expect(approved).toBe(true);
    expect(requestConfirmation).toHaveBeenCalledWith('set_theme', 'Set theme to dark');
  });

  it('propagates a denial from requestConfirmation', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(false);
    const approved = await gate('CONSEQUENTIAL', 'assist', 'clear_conversation_history', 'Clear all history', requestConfirmation);
    expect(approved).toBe(false);
  });
});
