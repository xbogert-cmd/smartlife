import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openExternal, handlers } = vi.hoisted(() => ({
  openExternal: vi.fn().mockResolvedValue(undefined),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
  shell: { openExternal },
}));

import { registerCanvasIpcHandlers } from './ipc';

describe('canvas:open-external protocol allowlist', () => {
  beforeEach(() => {
    handlers.clear();
    openExternal.mockClear();
    registerCanvasIpcHandlers(
      {} as never,
      () => null,
      {} as never
    );
  });

  function invoke(url: string): Promise<{ ok: boolean; error?: string }> {
    const handler = handlers.get('canvas:open-external');
    if (!handler) throw new Error('canvas:open-external was not registered');
    return handler({}, url) as Promise<{ ok: boolean; error?: string }>;
  }

  it('opens an https URL', async () => {
    const result = await invoke('https://example.edu/stats');
    expect(result).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith('https://example.edu/stats');
  });

  it('opens an http URL', async () => {
    const result = await invoke('http://example.edu/stats');
    expect(result).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith('http://example.edu/stats');
  });

  it('rejects a file: URL without calling shell.openExternal', async () => {
    const result = await invoke('file:///etc/passwd');
    expect(result.ok).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects a javascript: URL without calling shell.openExternal', async () => {
    const result = await invoke('javascript:alert(1)');
    expect(result.ok).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects a custom app-registered scheme without calling shell.openExternal', async () => {
    const result = await invoke('smartlife-evil://payload');
    expect(result.ok).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects a malformed URL without throwing', async () => {
    const result = await invoke('not a url');
    expect(result.ok).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });
});
