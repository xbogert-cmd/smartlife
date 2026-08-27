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
  return {
    hasUsableProvider: vi.fn().mockResolvedValue(apiKeyConfigured),
    // Only switchConversation's own use needs this to resolve sensibly --
    // turn-complete no longer refetches history, so no conversation-tracking
    // mock state is needed here.
    getHistory: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockImplementation(() => {
      queueMicrotask(() => {
        streamCb?.({ type: 'text-delta', text: 'Hello ' });
        streamCb?.({ type: 'text-delta', text: 'there!' });
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
    transcribeAudio: vi.fn().mockResolvedValue({ ok: false, reason: 'not used in this test' }),
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
    expect(ai.sendMessage).toHaveBeenCalledWith('hi there', null, [], 'conv-1', false);
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
