import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePendingConfirmationBadge } from './usePendingConfirmationBadge';

const ai = {
  getPendingConfirmation: vi.fn(),
  // Typed with an explicit callback param (unused) so TS infers a non-empty
  // parameter tuple for the mock -- otherwise `.mock.calls[0][0]` below has
  // no element to index, since `() => () => {}` infers as a zero-arg mock.
  onConfirmRequest: vi.fn((_cb: (req: unknown) => void) => () => {}),
  onConfirmResolved: vi.fn((_cb: (id: string) => void) => () => {}),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'smartlife', { value: { ai }, writable: true, configurable: true });
  ai.getPendingConfirmation.mockResolvedValue(null);
  ai.onConfirmRequest.mockReturnValue(() => {});
  ai.onConfirmResolved.mockReturnValue(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('usePendingConfirmationBadge', () => {
  it('is false when nothing is pending on mount', async () => {
    const { result } = renderHook(() => usePendingConfirmationBadge());
    await waitFor(() => expect(ai.getPendingConfirmation).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('picks up an already-pending confirmation on mount, e.g. the dock was closed while one was outstanding', async () => {
    ai.getPendingConfirmation.mockResolvedValue({ id: 'c1', toolName: 'browser_click', description: 'Click Submit' });
    const { result } = renderHook(() => usePendingConfirmationBadge());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('becomes true when a new confirmation is requested', async () => {
    const { result } = renderHook(() => usePendingConfirmationBadge());
    await waitFor(() => expect(ai.getPendingConfirmation).toHaveBeenCalled());
    const onRequest = ai.onConfirmRequest.mock.calls[0][0] as (req: unknown) => void;

    onRequest({ id: 'c1', toolName: 'browser_click', description: 'Click Submit' });

    await waitFor(() => expect(result.current).toBe(true));
  });

  it('becomes false again once the confirmation resolves', async () => {
    const { result } = renderHook(() => usePendingConfirmationBadge());
    await waitFor(() => expect(ai.getPendingConfirmation).toHaveBeenCalled());
    const onRequest = ai.onConfirmRequest.mock.calls[0][0] as (req: unknown) => void;
    const onResolved = ai.onConfirmResolved.mock.calls[0][0] as (id: string) => void;

    onRequest({ id: 'c1', toolName: 'browser_click', description: 'Click Submit' });
    await waitFor(() => expect(result.current).toBe(true));

    onResolved('c1');
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('unsubscribes both listeners on unmount', async () => {
    const stopRequest = vi.fn();
    const stopResolved = vi.fn();
    ai.onConfirmRequest.mockReturnValue(stopRequest);
    ai.onConfirmResolved.mockReturnValue(stopResolved);

    const { unmount } = renderHook(() => usePendingConfirmationBadge());
    unmount();

    expect(stopRequest).toHaveBeenCalled();
    expect(stopResolved).toHaveBeenCalled();
  });
});
