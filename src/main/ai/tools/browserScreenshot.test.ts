import { describe, expect, it, vi } from 'vitest';
import { setActiveBrowserHost } from '../../browser/hostRegistry';
import type { CanonicalImageBlock } from './types';

function fakeCtx() {
  const pendingImages: CanonicalImageBlock[] = [];
  return {
    db: {} as never,
    conversationId: 'c1',
    mode: 'ask' as const,
    requestConfirmation: vi.fn(),
    pendingImages,
    attachImage: (block: CanonicalImageBlock) => pendingImages.push(block),
  };
}

describe('browserScreenshotTool', () => {
  it('captures the active tab and attaches it as an image via ctx.attachImage', async () => {
    const { browserScreenshotTool } = await import('./browserScreenshot');
    const ctx = fakeCtx();
    setActiveBrowserHost({
      getState: () => ({ tabs: [{ id: 'tab-1', url: 'https://example.com', title: '', canGoBack: false, canGoForward: false, loading: false, error: null }], activeTabId: 'tab-1' }),
      captureScreenshot: vi.fn().mockResolvedValue({ mimeType: 'image/png', data: 'ZmFrZQ==' }),
    } as never);

    const result = await browserScreenshotTool.run({}, ctx);

    expect(result).toBe('Screenshot captured.');
    expect(ctx.pendingImages).toEqual([{ type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' }]);
    setActiveBrowserHost(null);
  });

  it('reports when the browser is unavailable', async () => {
    const { browserScreenshotTool } = await import('./browserScreenshot');
    setActiveBrowserHost(null);
    const result = await browserScreenshotTool.run({}, fakeCtx());
    expect(result).toContain('not available');
  });

  it('reports an unknown tab index without capturing', async () => {
    const { browserScreenshotTool } = await import('./browserScreenshot');
    const capture = vi.fn();
    setActiveBrowserHost({
      getState: () => ({ tabs: [], activeTabId: 'tab-1' }),
      captureScreenshot: capture,
    } as never);
    const result = await browserScreenshotTool.run({ tabIndex: 5 }, fakeCtx());
    expect(result).toContain('No tab 5');
    expect(capture).not.toHaveBeenCalled();
    setActiveBrowserHost(null);
  });

  it('reports a failed capture without attaching anything', async () => {
    const { browserScreenshotTool } = await import('./browserScreenshot');
    const ctx = fakeCtx();
    setActiveBrowserHost({
      getState: () => ({ tabs: [{ id: 'tab-1', url: 'https://example.com', title: '', canGoBack: false, canGoForward: false, loading: false, error: null }], activeTabId: 'tab-1' }),
      captureScreenshot: vi.fn().mockResolvedValue(null),
    } as never);
    const result = await browserScreenshotTool.run({}, ctx);
    expect(result).toContain("Couldn't capture");
    expect(ctx.pendingImages).toHaveLength(0);
    setActiveBrowserHost(null);
  });
});
