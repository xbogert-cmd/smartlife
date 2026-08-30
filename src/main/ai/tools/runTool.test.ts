import { describe, expect, it, vi } from 'vitest';
import { runTool } from './runTool';
import type { ToolContext, ToolDefinition } from './types';

function fakeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    db: {} as never,
    conversationId: 'c1',
    mode: 'ask',
    requestConfirmation: vi.fn(),
    ...overrides,
  };
}

const readTool: ToolDefinition = {
  name: 'get_settings',
  tier: 'READ',
  label: 'Reading settings',
  schema: { name: 'get_settings', description: '', input_schema: { type: 'object', properties: {} } },
  run: vi.fn().mockResolvedValue('the settings'),
};

const writeTool: ToolDefinition = {
  name: 'set_theme',
  tier: 'SAFE_WRITE',
  label: 'Set theme',
  schema: { name: 'set_theme', description: '', input_schema: { type: 'object', properties: {} } },
  run: vi.fn().mockResolvedValue('theme set'),
};

describe('runTool', () => {
  it('gates a READ-tier tool through requestConfirmation using its label, in ask mode', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue(true);
    const ctx = fakeCtx({ mode: 'ask', requestConfirmation });

    const result = await runTool(readTool, {}, ctx);

    expect(requestConfirmation).toHaveBeenCalledWith('get_settings', 'Reading settings', undefined);
    expect(result).toBe('the settings');
  });

  it('returns the decline string and never calls tool.run when the user declines a READ-tier confirmation', async () => {
    const run = vi.fn().mockResolvedValue('the settings');
    const declinedReadTool: ToolDefinition = { ...readTool, run };
    const requestConfirmation = vi.fn().mockResolvedValue(false);
    const ctx = fakeCtx({ mode: 'ask', requestConfirmation });

    const result = await runTool(declinedReadTool, {}, ctx);

    expect(result).toBe('The user declined, so this was not checked.');
    expect(run).not.toHaveBeenCalled();
  });

  it('does not gate a READ-tier tool in assist mode', async () => {
    const requestConfirmation = vi.fn();
    const ctx = fakeCtx({ mode: 'assist', requestConfirmation });

    const result = await runTool(readTool, {}, ctx);

    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(result).toBe('the settings');
  });

  it('does not gate a READ-tier tool in auto mode', async () => {
    const requestConfirmation = vi.fn();
    const ctx = fakeCtx({ mode: 'auto', requestConfirmation });

    const result = await runTool(readTool, {}, ctx);

    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(result).toBe('the settings');
  });

  it('always calls tool.run for a non-READ tier tool, in every mode, without ever calling requestConfirmation itself', async () => {
    const requestConfirmation = vi.fn();
    const ctx = fakeCtx({ mode: 'ask', requestConfirmation });

    const result = await runTool(writeTool, {}, ctx);

    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(result).toBe('theme set');
  });

  it('gates using tool.schema.name, not tool.name, since that is what providers dispatch by', async () => {
    const mismatchedTool: ToolDefinition = {
      name: 'internal_id',
      tier: 'READ',
      label: 'Get settings',
      schema: { name: 'get_settings', description: '', input_schema: { type: 'object', properties: {} } },
      run: vi.fn().mockResolvedValue('the settings'),
    };
    const requestConfirmation = vi.fn().mockResolvedValue(true);
    const ctx = fakeCtx({ mode: 'ask', requestConfirmation });

    await runTool(mismatchedTool, {}, ctx);

    expect(requestConfirmation).toHaveBeenCalledWith('get_settings', 'Get settings', undefined);
  });

  it('passes input through to tool.run unchanged', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    const tool: ToolDefinition = { ...writeTool, run };
    const ctx = fakeCtx({ mode: 'auto' });
    const input = { theme: 'dark' };

    await runTool(tool, input, ctx);

    expect(run).toHaveBeenCalledWith(input, ctx);
  });
});
