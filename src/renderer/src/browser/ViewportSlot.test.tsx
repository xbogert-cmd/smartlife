import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ViewportSlot } from './ViewportSlot';

const setBounds = vi.fn(async () => {});
let observerCallback: (() => void) | null = null;

class FakeResizeObserver {
  constructor(callback: () => void) {
    observerCallback = callback;
  }
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.clearAllMocks();
  observerCallback = null;
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  (window as unknown as { smartlife: unknown }).smartlife = { browser: { setBounds } };
});

describe('ViewportSlot', () => {
  it('reports its rectangle on mount', () => {
    render(<ViewportSlot />);
    expect(setBounds).toHaveBeenCalledOnce();
    expect(setBounds).toHaveBeenCalledWith(
      expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
      })
    );
  });

  it('reports again when the element resizes', () => {
    render(<ViewportSlot />);
    setBounds.mockClear();
    observerCallback?.();
    expect(setBounds).toHaveBeenCalledOnce();
  });

  it('reports again when the window resizes', () => {
    render(<ViewportSlot />);
    setBounds.mockClear();
    window.dispatchEvent(new Event('resize'));
    expect(setBounds).toHaveBeenCalledOnce();
  });
});
