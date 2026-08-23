import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useConversation } from './useConversation';

const ai = {
  getApiKeyStatus: vi.fn(),
  getHistory: vi.fn(),
  sendMessage: vi.fn(),
  onStreamEvent: vi.fn((_cb: (event: unknown) => void) => () => {}),
  onConfirmRequest: vi.fn((_cb: (req: unknown) => void) => () => {}),
  respondToConfirm: vi.fn(),
  getPendingConfirmation: vi.fn(),
  onConfirmResolved: vi.fn((_cb: (id: string) => void) => () => {}),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'smartlife', { value: { ai }, writable: true, configurable: true });
  ai.getApiKeyStatus.mockResolvedValue(true);
  ai.getHistory.mockResolvedValue([]);
  ai.getPendingConfirmation.mockResolvedValue(null);
  ai.onStreamEvent.mockReturnValue(() => {});
  ai.onConfirmRequest.mockReturnValue(() => {});
  ai.onConfirmResolved.mockReturnValue(() => {});
  ai.respondToConfirm.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useConversation — pending confirmation recovery', () => {
  it('shows no pending confirmation when nothing is outstanding on mount', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(ai.getPendingConfirmation).toHaveBeenCalled());
    expect(result.current.pendingConfirm).toBeNull();
  });

  it('recovers an already-pending confirmation on mount, e.g. the dock was closed while one was outstanding', async () => {
    ai.getPendingConfirmation.mockResolvedValue({ id: 'c1', toolName: 'browser_click', description: 'On https://x.test: Click Submit' });

    const { result } = renderHook(() => useConversation());

    await waitFor(() =>
      expect(result.current.pendingConfirm).toEqual({ id: 'c1', toolName: 'browser_click', description: 'On https://x.test: Click Submit' })
    );
  });

  it('still updates from a live onConfirmRequest push after mounting with nothing pending', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(ai.getPendingConfirmation).toHaveBeenCalled());
    const onRequest = ai.onConfirmRequest.mock.calls[0][0] as (req: unknown) => void;

    onRequest({ id: 'c2', toolName: 'browser_type', description: 'Type X' });

    await waitFor(() => expect(result.current.pendingConfirm?.id).toBe('c2'));
  });

  it('clears pendingConfirm when it resolves through onConfirmResolved rather than this component’s own respondToConfirm, e.g. a timeout firing while the dock is open', async () => {
    ai.getPendingConfirmation.mockResolvedValue({ id: 'c1', toolName: 'browser_click', description: 'Click Submit' });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.pendingConfirm?.id).toBe('c1'));
    const onResolved = ai.onConfirmResolved.mock.calls[0][0] as (id: string) => void;

    onResolved('c1');

    await waitFor(() => expect(result.current.pendingConfirm).toBeNull());
  });

  it('does not clear an unrelated pendingConfirm when a different confirmation id resolves', async () => {
    ai.getPendingConfirmation.mockResolvedValue({ id: 'c1', toolName: 'browser_click', description: 'Click Submit' });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.pendingConfirm?.id).toBe('c1'));
    const onResolved = ai.onConfirmResolved.mock.calls[0][0] as (id: string) => void;

    onResolved('some-other-id');

    expect(result.current.pendingConfirm?.id).toBe('c1');
  });

  it('unsubscribes the confirmation-resolved listener on unmount', async () => {
    const stopResolved = vi.fn();
    ai.onConfirmResolved.mockReturnValue(stopResolved);

    const { unmount } = renderHook(() => useConversation());
    await waitFor(() => expect(ai.getPendingConfirmation).toHaveBeenCalled());
    unmount();

    expect(stopResolved).toHaveBeenCalled();
  });

  it('respondToConfirm still clears pendingConfirm locally after the user approves or declines', async () => {
    ai.getPendingConfirmation.mockResolvedValue({ id: 'c1', toolName: 'browser_click', description: 'Click Submit' });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.pendingConfirm?.id).toBe('c1'));

    await result.current.respondToConfirm(true);

    expect(ai.respondToConfirm).toHaveBeenCalledWith('c1', true);
    await waitFor(() => expect(result.current.pendingConfirm).toBeNull());
  });
});
