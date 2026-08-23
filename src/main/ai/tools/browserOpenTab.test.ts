import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserOpenTabTool } from './browserOpenTab';
import { setActiveBrowserHost } from '../../browser/hostRegistry';
import { setActiveNavigator } from '../navigatorRegistry';
import { resolveExecutionMode } from '../permissions';
import type { ToolContext } from './types';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { db: {} as never, conversationId: 'c1', mode: 'auto', requestConfirmation: vi.fn().mockResolvedValue(true), ...overrides };
}

afterEach(() => {
  setActiveBrowserHost(null);
  setActiveNavigator(null);
});

describe('browser_open_tab', () => {
  it('is SAFE_WRITE, matching canvas_open_assignment', () => {
    expect(browserOpenTabTool.tier).toBe('SAFE_WRITE');
    expect(resolveExecutionMode('SAFE_WRITE', 'ask')).toBe('pause');
    expect(resolveExecutionMode('SAFE_WRITE', 'auto')).toBe('auto');
  });

  it('opens the given URL in the background (activate: false)', async () => {
    const openTab = vi.fn().mockReturnValue('t2');
    setActiveBrowserHost({ openTab } as never);

    await browserOpenTabTool.run({ url: 'https://example.edu/reference' }, ctx());

    expect(openTab).toHaveBeenCalledWith('https://example.edu/reference', false);
  });

  it('does NOT activate the tab (keeps user view unchanged)', async () => {
    const openTab = vi.fn().mockReturnValue('t2');
    const activateTab = vi.fn();
    setActiveBrowserHost({ openTab, activateTab } as never);
    const navigate = vi.fn();
    setActiveNavigator(navigate);

    await browserOpenTabTool.run({ url: 'https://example.edu/reference' }, ctx());

    expect(activateTab).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(openTab).toHaveBeenCalledWith('https://example.edu/reference', false);
  });

  it('names the URL in the confirmation before opening it', async () => {
    setActiveBrowserHost({ openTab: vi.fn().mockReturnValue('t2') } as never);
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    await browserOpenTabTool.run({ url: 'https://example.edu/reference' }, ctx({ mode: 'ask', requestConfirmation }));

    expect(requestConfirmation.mock.calls[0][1]).toContain('https://example.edu/reference');
  });

  it('passes a 24-hour timeout to the confirmation', async () => {
    setActiveBrowserHost({ openTab: vi.fn().mockReturnValue('t2') } as never);
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    await browserOpenTabTool.run({ url: 'https://example.edu/reference' }, ctx({ mode: 'ask', requestConfirmation }));

    expect(requestConfirmation).toHaveBeenCalledWith(expect.any(String), expect.any(String), 24 * 60 * 60 * 1000);
  });

  it('opens nothing when the user declines', async () => {
    const openTab = vi.fn();
    setActiveBrowserHost({ openTab } as never);

    const out = await browserOpenTabTool.run({ url: 'https://example.edu/reference' }, ctx({ mode: 'ask', requestConfirmation: vi.fn().mockResolvedValue(false) }));

    expect(out).toMatch(/declined/i);
    expect(openTab).not.toHaveBeenCalled();
  });

  it('rejects a non-http(s) URL before ever asking for confirmation', async () => {
    const requestConfirmation = vi.fn();
    setActiveBrowserHost({ openTab: vi.fn() } as never);

    const out = await browserOpenTabTool.run({ url: 'file:///etc/passwd' }, ctx({ requestConfirmation }));

    expect(out).toMatch(/http/i);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('degrades gracefully when the built-in browser is unavailable', async () => {
    setActiveBrowserHost(null);

    const out = await browserOpenTabTool.run({ url: 'https://example.edu/reference' }, ctx());

    expect(out).toMatch(/not available/i);
  });
});
