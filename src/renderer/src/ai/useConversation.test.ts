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

describe('useConversation — provider-switched stream event', () => {
  it('starts a fresh message for the new provider instead of appending to the failed provider’s partial text', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(ai.getPendingConfirmation).toHaveBeenCalled());
    const onEvent = ai.onStreamEvent.mock.calls[0][0] as (event: unknown) => void;

    // Provider A streams partial text -- accumulates into one message.
    onEvent({ type: 'text-delta', text: 'Hello, I' });
    onEvent({ type: 'text-delta', text: 'm working on' });

    await waitFor(() => {
      const assistantMessages = result.current.messages.filter((m) => m.role === 'assistant');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].text).toBe('Hello, Im working on');
    });

    // Provider A fails; FallbackProvider switches to Provider B.
    onEvent({ type: 'provider-switched', from: 'Claude Sonnet 5', to: 'Gemini Flash', reason: 'credit balance too low' });

    await waitFor(() => {
      const switchNotices = result.current.messages.filter((m) => m.kind === 'switch-notice');
      expect(switchNotices).toHaveLength(1);
      expect(switchNotices[0].text).toContain('Gemini Flash');
    });

    // Provider B streams its own fresh answer -- this must land in a NEW
    // message, not get appended onto Provider A's partial text.
    onEvent({ type: 'text-delta', text: 'I can help with that.' });

    await waitFor(() => {
      const assistantMessages = result.current.messages.filter((m) => m.role === 'assistant' && m.kind !== 'switch-notice');
      expect(assistantMessages).toHaveLength(2);
      expect(assistantMessages[0].text).toBe('Hello, Im working on');
      expect(assistantMessages[1].text).toBe('I can help with that.');
    });
  });
});
