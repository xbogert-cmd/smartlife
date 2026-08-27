import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ConversationProvider, useConversationContext } from './ConversationProvider';

const ai = {
  hasUsableProvider: vi.fn().mockResolvedValue(true),
  getHistory: vi.fn().mockResolvedValue([]),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  onStreamEvent: vi.fn().mockReturnValue(() => {}),
  onConfirmRequest: vi.fn().mockReturnValue(() => {}),
  respondToConfirm: vi.fn().mockResolvedValue(undefined),
  getPendingConfirmation: vi.fn().mockResolvedValue(null),
  onConfirmResolved: vi.fn().mockReturnValue(() => {}),
  pickAttachment: vi.fn().mockResolvedValue(null),
  createConversation: vi.fn().mockResolvedValue('conv-shared'),
  listConversations: vi.fn().mockResolvedValue([]),
  renameConversation: vi.fn().mockResolvedValue(undefined),
  deleteConversation: vi.fn().mockResolvedValue(undefined),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'smartlife', { value: { ai }, writable: true, configurable: true });
  ai.hasUsableProvider.mockResolvedValue(true);
  ai.getHistory.mockResolvedValue([]);
  ai.getPendingConfirmation.mockResolvedValue(null);
  ai.createConversation.mockResolvedValue('conv-shared');
  ai.listConversations.mockResolvedValue([]);
});

function ConsumerA() {
  const { activeConversationId } = useConversationContext();
  return <div data-testid="a">{activeConversationId ?? 'none'}</div>;
}
function ConsumerB() {
  const { activeConversationId } = useConversationContext();
  return <div data-testid="b">{activeConversationId ?? 'none'}</div>;
}

describe('ConversationProvider', () => {
  it('throws when useConversationContext is used outside a provider', () => {
    function Bare() {
      useConversationContext();
      return null;
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Bare />)).toThrow('useConversationContext must be used within a ConversationProvider');
    consoleError.mockRestore();
  });

  it('shares the same conversation state across multiple consumers', async () => {
    render(
      <ConversationProvider>
        <ConsumerA />
        <ConsumerB />
      </ConversationProvider>
    );
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('conv-shared'));
    expect(screen.getByTestId('b').textContent).toBe('conv-shared');
    expect(ai.createConversation).toHaveBeenCalledTimes(1);
  });
});
