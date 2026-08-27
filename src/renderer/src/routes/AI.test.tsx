import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AI } from './AI';
import { ConversationProvider } from '../ai/ConversationProvider';

function renderAI(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <ConversationProvider>
        <AI />
      </ConversationProvider>
    </MemoryRouter>
  );
}

type StreamCb = (event: { type: string; text?: string; toolLabel?: string }) => void;
type ConfirmCb = (req: { id: string; toolName: string; description: string }) => void;

function mockAi(apiKeyConfigured = true) {
  let streamCb: StreamCb | null = null;
  let confirmCb: ConfirmCb | null = null;
  // Mirrors what main persists: turn-complete now triggers a getHistory()
  // refetch (see useConversation.ts) to pick up the just-persisted
  // provider/model, so this mock's history must reflect what sendMessage
  // "sent" or that refetch would wipe the messages the test just rendered.
  let history: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  return {
    hasUsableProvider: vi.fn().mockResolvedValue(apiKeyConfigured),
    getHistory: vi.fn().mockImplementation(() => Promise.resolve(history)),
    sendMessage: vi.fn().mockImplementation((text: string) => {
      history = [...history, { role: 'user', content: [{ type: 'text', text }] }];
      queueMicrotask(() => {
        streamCb?.({ type: 'text-delta', text: 'Hello ' });
        streamCb?.({ type: 'text-delta', text: 'there!' });
        history = [...history, { role: 'assistant', content: [{ type: 'text', text: 'Hello there!' }] }];
        streamCb?.({ type: 'turn-complete' });
      });
      return Promise.resolve();
    }),
    onStreamEvent: vi.fn((cb: StreamCb) => {
      streamCb = cb;
      return () => {
        streamCb = null;
      };
    }),
    onConfirmRequest: vi.fn((cb: ConfirmCb) => {
      confirmCb = cb;
      return () => {
        confirmCb = null;
      };
    }),
    respondToConfirm: vi.fn().mockResolvedValue(undefined),
    getPendingConfirmation: vi.fn().mockResolvedValue(null),
    onConfirmResolved: vi.fn((_cb: (id: string) => void) => () => {}),
    pickAttachment: vi.fn().mockResolvedValue(null),
    createConversation: vi.fn().mockResolvedValue('conv-1'),
    listConversations: vi.fn().mockResolvedValue([]),
    renameConversation: vi.fn().mockResolvedValue(undefined),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    getCatalog: vi.fn().mockResolvedValue([]),
    triggerConfirm: (req: { id: string; toolName: string; description: string }) => confirmCb?.(req),
  };
}

beforeEach(() => {
  (window as unknown as { smartlife: { ai: ReturnType<typeof mockAi> } }).smartlife = { ai: mockAi() };
});

describe('AI chat view', () => {
  it('sends a message and renders the streamed assistant reply', async () => {
    renderAI();
    const input = await screen.findByPlaceholderText('Ask SmartLife…');
    await userEvent.type(input, 'hi there');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    const ai = (window as unknown as { smartlife: { ai: ReturnType<typeof mockAi> } }).smartlife.ai;
    expect(ai.sendMessage).toHaveBeenCalledWith('hi there', null, [], 'conv-1');
    expect(await screen.findByText('hi there')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Hello there!')).toBeInTheDocument());
  });

  it('shows a confirmation card and calls respondToConfirm on approve', async () => {
    renderAI();
    const ai = (window as unknown as { smartlife: { ai: ReturnType<typeof mockAi> } }).smartlife.ai;
    ai.triggerConfirm({ id: 'conf-1', toolName: 'set_theme', description: 'Change theme to "dark"' });

    expect(await screen.findByText('Change theme to "dark"')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(ai.respondToConfirm).toHaveBeenCalledWith('conf-1', true);
  });

  it('shows a Connect provider empty state instead of the chat UI when no AI provider is configured', async () => {
    (window as unknown as { smartlife: { ai: ReturnType<typeof mockAi> } }).smartlife = { ai: mockAi(false) };
    renderAI();

    expect(await screen.findByText('Connect an AI provider in Settings to start chatting.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to Settings' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Ask SmartLife…')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });
});
