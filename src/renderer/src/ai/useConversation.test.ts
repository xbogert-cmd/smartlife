import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useConversation } from './useConversation';

const ai = {
  hasUsableProvider: vi.fn(),
  getHistory: vi.fn(),
  sendMessage: vi.fn(),
  onStreamEvent: vi.fn((_cb: (event: unknown) => void) => () => {}),
  onConfirmRequest: vi.fn((_cb: (req: unknown) => void) => () => {}),
  respondToConfirm: vi.fn(),
  getPendingConfirmation: vi.fn(),
  onConfirmResolved: vi.fn((_cb: (id: string) => void) => () => {}),
  pickAttachment: vi.fn(),
  createConversation: vi.fn(),
  listConversations: vi.fn(),
  renameConversation: vi.fn(),
  deleteConversation: vi.fn(),
  getCatalog: vi.fn().mockResolvedValue([
    { providerId: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', costRank: 3 },
  ]),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'smartlife', { value: { ai }, writable: true, configurable: true });
  ai.hasUsableProvider.mockResolvedValue(true);
  ai.getHistory.mockResolvedValue([]);
  ai.getPendingConfirmation.mockResolvedValue(null);
  ai.onStreamEvent.mockReturnValue(() => {});
  ai.onConfirmRequest.mockReturnValue(() => {});
  ai.onConfirmResolved.mockReturnValue(() => {});
  ai.respondToConfirm.mockResolvedValue(undefined);
  ai.sendMessage.mockResolvedValue(undefined);
  ai.createConversation.mockResolvedValue('conv-1');
  ai.listConversations.mockResolvedValue([{ id: 'conv-1', title: null, updatedAt: '2026-01-01 00:00:00' }]);
  ai.renameConversation.mockResolvedValue(undefined);
  ai.deleteConversation.mockResolvedValue(undefined);
  ai.getCatalog.mockResolvedValue([{ providerId: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', costRank: 3 }]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useConversation — launch always starts a new conversation', () => {
  it('creates a new conversation on mount and sets it active', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(ai.createConversation).toHaveBeenCalled());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));
    expect(result.current.messages).toEqual([]);
  });

  it('populates the conversations list from listConversations after creating the new one', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.conversations).toEqual([{ id: 'conv-1', title: null, updatedAt: '2026-01-01 00:00:00' }]));
  });

  it('does not leave an orphan conversation when StrictMode double-invokes the mount effect', async () => {
    ai.createConversation.mockResolvedValueOnce('conv-a').mockResolvedValueOnce('conv-b');
    const { result } = renderHook(() => useConversation(), { wrapper: StrictMode });

    await waitFor(() => expect(ai.createConversation).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-b'));
    // Only the surviving (non-cancelled) effect invocation should refresh the
    // conversation list -- the cancelled first invocation's resolution must
    // be a no-op, otherwise it also created and surfaced an orphan.
    expect(ai.listConversations).toHaveBeenCalledTimes(1);
  });
});

describe('useConversation — switching conversations', () => {
  it('switchConversation sets the active id and loads that conversation’s history', async () => {
    ai.getHistory.mockImplementation((id: string) =>
      Promise.resolve(id === 'conv-2' ? [{ role: 'user', content: [{ type: 'text', text: 'old message' }] }] : [])
    );
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));

    await act(async () => {
      await result.current.switchConversation('conv-2');
    });

    expect(result.current.activeConversationId).toBe('conv-2');
    expect(result.current.messages).toEqual([{ id: 'history-0', role: 'user', text: 'old message' }]);
  });

  it('ignores a stale getHistory response from an earlier switchConversation call that resolves late', async () => {
    let resolveConv2: (v: Array<{ role: 'user' | 'assistant'; content: unknown }>) => void;
    const conv2History = new Promise<Array<{ role: 'user' | 'assistant'; content: unknown }>>((resolve) => {
      resolveConv2 = resolve;
    });
    ai.getHistory.mockImplementation((id: string) => {
      if (id === 'conv-2') return conv2History;
      if (id === 'conv-3') return Promise.resolve([{ role: 'user', content: [{ type: 'text', text: 'fresh message' }] }]);
      return Promise.resolve([]);
    });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));

    let switch2Done: Promise<void>;
    act(() => {
      switch2Done = result.current.switchConversation('conv-2');
    });
    await act(async () => {
      await result.current.switchConversation('conv-3');
    });

    // conv-3's getHistory already resolved and won; now let conv-2's late
    // response land and confirm it does not stomp conv-3's messages.
    await act(async () => {
      resolveConv2([{ role: 'user', content: [{ type: 'text', text: 'old message' }] }]);
      await switch2Done;
    });

    expect(result.current.activeConversationId).toBe('conv-3');
    expect(result.current.messages).toEqual([{ id: 'history-0', role: 'user', text: 'fresh message' }]);
  });

  it('switching away from a still-streaming conversation releases the sending lock', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));

    act(() => {
      result.current.sendMessage('hi');
    });
    expect(result.current.sending).toBe(true);

    // No turn-complete ever arrives for conv-1 -- switch away before it does.
    await act(async () => {
      await result.current.switchConversation('conv-2');
    });

    expect(result.current.sending).toBe(false);
  });

  it('switchConversation attaches an answeredBy caption to assistant messages, looked up from the catalog', async () => {
    ai.getHistory.mockImplementation((id: string) =>
      Promise.resolve(
        id === 'conv-2'
          ? [
              { role: 'user', content: [{ type: 'text', text: 'question' }], providerId: null, model: null },
              {
                role: 'assistant',
                content: [{ type: 'text', text: 'answer' }],
                providerId: 'anthropic',
                model: 'claude-sonnet-5',
              },
            ]
          : []
      )
    );
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));

    await act(async () => {
      await result.current.switchConversation('conv-2');
    });

    const assistantMessage = result.current.messages.find((m) => m.role === 'assistant');
    expect(assistantMessage?.answeredBy).toBe('Claude Sonnet 5');
    const userMessage = result.current.messages.find((m) => m.role === 'user');
    expect(userMessage?.answeredBy).toBeUndefined();
  });

  it('falls back to the raw model name in answeredBy when it is not in the catalog (e.g. Ollama)', async () => {
    ai.getHistory.mockImplementation((id: string) =>
      Promise.resolve(
        id === 'conv-2'
          ? [{ role: 'assistant', content: [{ type: 'text', text: 'answer' }], providerId: 'ollama', model: 'llama3.1' }]
          : []
      )
    );
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));

    await act(async () => {
      await result.current.switchConversation('conv-2');
    });

    expect(result.current.messages[0].answeredBy).toBe('llama3.1');
  });

  it('startNewConversation creates and switches to a fresh, empty conversation', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));
    ai.createConversation.mockResolvedValue('conv-3');

    await act(async () => {
      await result.current.startNewConversation();
    });

    expect(result.current.activeConversationId).toBe('conv-3');
    expect(result.current.messages).toEqual([]);
  });
});

describe('useConversation — rename and delete', () => {
  it('renameConversation calls the IPC method and refreshes the list', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));
    ai.listConversations.mockResolvedValue([{ id: 'conv-1', title: 'Renamed', updatedAt: '2026-01-01 00:00:00' }]);

    await act(async () => {
      await result.current.renameConversation('conv-1', 'Renamed');
    });

    expect(ai.renameConversation).toHaveBeenCalledWith('conv-1', 'Renamed');
    expect(result.current.conversations).toEqual([{ id: 'conv-1', title: 'Renamed', updatedAt: '2026-01-01 00:00:00' }]);
  });

  it('deleteConversation on a non-active conversation just refreshes the list', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));
    ai.listConversations.mockResolvedValue([]);

    await act(async () => {
      await result.current.deleteConversation('conv-2');
    });

    expect(ai.deleteConversation).toHaveBeenCalledWith('conv-2');
    expect(ai.createConversation).toHaveBeenCalledTimes(1); // only the initial mount call, not a fallback
    expect(result.current.activeConversationId).toBe('conv-1');
  });

  it('deleting the ACTIVE conversation falls through to a fresh new one', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));
    ai.createConversation.mockResolvedValue('conv-fresh');

    await act(async () => {
      await result.current.deleteConversation('conv-1');
    });

    expect(ai.deleteConversation).toHaveBeenCalledWith('conv-1');
    expect(result.current.activeConversationId).toBe('conv-fresh');
    expect(result.current.messages).toEqual([]);
  });
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

describe('useConversation — apiKeyConfigured reflects any usable provider', () => {
  it('becomes true from hasUsableProvider even for a Gemini/Ollama-only setup with no Anthropic key', async () => {
    ai.hasUsableProvider.mockResolvedValue(true);
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.apiKeyConfigured).toBe(true));
    expect(ai.hasUsableProvider).toHaveBeenCalled();
  });

  it('becomes false when hasUsableProvider resolves false', async () => {
    ai.hasUsableProvider.mockResolvedValue(false);
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.apiKeyConfigured).toBe(false));
  });
});

describe('useConversation — provider-switched stream event', () => {
  it('starts a fresh message for the new provider instead of appending to the failed provider’s partial text', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(ai.getPendingConfirmation).toHaveBeenCalled());
    const onEvent = ai.onStreamEvent.mock.calls[0][0] as (event: unknown) => void;

    onEvent({ type: 'text-delta', text: 'Hello, I' });
    onEvent({ type: 'text-delta', text: 'm working on' });

    await waitFor(() => {
      const assistantMessages = result.current.messages.filter((m) => m.role === 'assistant');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].text).toBe('Hello, Im working on');
    });

    onEvent({ type: 'provider-switched', from: 'Claude Sonnet 5', to: 'Gemini Flash', reason: 'credit balance too low' });

    await waitFor(() => {
      const switchNotices = result.current.messages.filter((m) => m.kind === 'switch-notice');
      expect(switchNotices).toHaveLength(1);
      expect(switchNotices[0].text).toContain('Gemini Flash');
    });

    onEvent({ type: 'text-delta', text: 'I can help with that.' });

    await waitFor(() => {
      const assistantMessages = result.current.messages.filter((m) => m.role === 'assistant' && m.kind !== 'switch-notice');
      expect(assistantMessages).toHaveLength(2);
      expect(assistantMessages[0].text).toBe('Hello, Im working on');
      expect(assistantMessages[1].text).toBe('I can help with that.');
    });
  });
});

describe('useConversation — stream events scoped to the active conversation', () => {
  it('ignores a text-delta event tagged for a different conversation', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));
    const onEvent = ai.onStreamEvent.mock.calls[0][0] as (event: unknown) => void;

    await act(async () => {
      onEvent({ type: 'text-delta', text: 'not for you', conversationId: 'some-other-conversation' });
      await Promise.resolve();
    });

    expect(result.current.messages).toEqual([]);
  });

  it('applies a text-delta event tagged for the active conversation', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));
    const onEvent = ai.onStreamEvent.mock.calls[0][0] as (event: unknown) => void;

    onEvent({ type: 'text-delta', text: 'for you', conversationId: 'conv-1' });

    await waitFor(() => {
      const assistantMessages = result.current.messages.filter((m) => m.role === 'assistant');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].text).toBe('for you');
    });
  });

  it('applies an event with no conversationId at all (backward compatible)', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));
    const onEvent = ai.onStreamEvent.mock.calls[0][0] as (event: unknown) => void;

    onEvent({ type: 'text-delta', text: 'untagged' });

    await waitFor(() => {
      const assistantMessages = result.current.messages.filter((m) => m.role === 'assistant');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].text).toBe('untagged');
    });
  });

  it('tags the just-completed assistant message with answeredBy once the assistant-answered event arrives, without touching earlier messages', async () => {
    ai.getCatalog.mockResolvedValue([
      { providerId: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', costRank: 3 },
    ]);
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));
    const onEvent = ai.onStreamEvent.mock.calls[0][0] as (event: unknown) => void;

    act(() => {
      result.current.sendMessage('hi');
    });

    onEvent({ type: 'text-delta', text: 'partial answer', conversationId: 'conv-1' });
    await waitFor(() => {
      const assistantMessages = result.current.messages.filter((m) => m.role === 'assistant');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].text).toBe('partial answer');
    });

    onEvent({ type: 'turn-complete', conversationId: 'conv-1' });
    onEvent({ type: 'assistant-answered', providerId: 'anthropic', model: 'claude-sonnet-5', conversationId: 'conv-1' });

    await waitFor(() => {
      const assistantMessages = result.current.messages.filter((m) => m.role === 'assistant');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].answeredBy).toBe('Claude Sonnet 5');
    });

    // The user's own message from sendMessage must still be present, unlike
    // the previous (reverted) history-refetch approach which would have
    // temporarily replaced the whole array.
    expect(result.current.messages.some((m) => m.role === 'user' && m.text === 'hi')).toBe(true);
  });

  it('does not wipe a provider-switched notice when the turn subsequently completes', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));
    const onEvent = ai.onStreamEvent.mock.calls[0][0] as (event: unknown) => void;

    act(() => {
      onEvent({ type: 'provider-switched', from: 'Claude Sonnet 5', to: 'Gemini Flash', reason: 'credit balance too low', conversationId: 'conv-1' });
      onEvent({ type: 'text-delta', text: 'answer from gemini', conversationId: 'conv-1' });
      onEvent({ type: 'turn-complete', conversationId: 'conv-1' });
    });

    await act(async () => {});

    await waitFor(() => {
      const notices = result.current.messages.filter((m) => m.kind === 'switch-notice');
      expect(notices).toHaveLength(1);
    });
  });
});

describe('useConversation — attachments', () => {
  it('addAttachment appends a successful pick result to attachments', async () => {
    ai.pickAttachment.mockResolvedValue({ ok: true, id: 'attach-1', name: 'notes.txt', kind: 'text' });
    const { result } = renderHook(() => useConversation());

    await act(async () => {
      await result.current.addAttachment();
    });

    expect(result.current.attachments).toEqual([{ id: 'attach-1', name: 'notes.txt', kind: 'text' }]);
  });

  it('addAttachment sets attachError and adds nothing when the pick fails', async () => {
    ai.pickAttachment.mockResolvedValue({ ok: false, reason: "can't see images" });
    const { result } = renderHook(() => useConversation());

    await act(async () => {
      await result.current.addAttachment();
    });

    expect(result.current.attachments).toEqual([]);
    expect(result.current.attachError).toBe("can't see images");
  });

  it('addAttachment does nothing when the dialog is cancelled (null result)', async () => {
    ai.pickAttachment.mockResolvedValue(null);
    const { result } = renderHook(() => useConversation());

    await act(async () => {
      await result.current.addAttachment();
    });

    expect(result.current.attachments).toEqual([]);
  });

  it('removeAttachment removes one attachment by id', async () => {
    ai.pickAttachment.mockResolvedValue({ ok: true, id: 'attach-1', name: 'notes.txt', kind: 'text' });
    const { result } = renderHook(() => useConversation());
    await act(async () => {
      await result.current.addAttachment();
    });

    act(() => {
      result.current.removeAttachment('attach-1');
    });

    expect(result.current.attachments).toEqual([]);
  });

  it('sendMessage passes the active conversation id and current attachment ids, and clears attachments afterward', async () => {
    ai.pickAttachment.mockResolvedValue({ ok: true, id: 'attach-1', name: 'notes.txt', kind: 'text' });
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));
    await act(async () => {
      await result.current.addAttachment();
    });

    act(() => {
      result.current.sendMessage('hi');
    });

    expect(ai.sendMessage).toHaveBeenCalledWith('hi', null, ['attach-1'], 'conv-1', false);
    expect(result.current.attachments).toEqual([]);
  });

  it('sendMessage passes voiceMode through as the 5th argument when set', async () => {
    const { result } = renderHook(() => useConversation());
    await waitFor(() => expect(result.current.activeConversationId).toBe('conv-1'));

    act(() => {
      result.current.sendMessage('hi', null, true);
    });

    expect(ai.sendMessage).toHaveBeenCalledWith('hi', null, [], 'conv-1', true);
  });
});
