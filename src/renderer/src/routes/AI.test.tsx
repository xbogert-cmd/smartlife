import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AI } from './AI';

type StreamCb = (event: { type: string; text?: string; toolLabel?: string }) => void;
type ConfirmCb = (req: { id: string; toolName: string; description: string }) => void;

function mockAi() {
  let streamCb: StreamCb | null = null;
  let confirmCb: ConfirmCb | null = null;
  return {
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
    triggerConfirm: (req: { id: string; toolName: string; description: string }) => confirmCb?.(req),
  };
}

beforeEach(() => {
  (window as unknown as { smartlife: { ai: ReturnType<typeof mockAi> } }).smartlife = { ai: mockAi() };
});

describe('AI chat view', () => {
  it('sends a message and renders the streamed assistant reply', async () => {
    render(<AI />);
    const input = await screen.findByPlaceholderText('Ask SmartLife…');
    await userEvent.type(input, 'hi there');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    const ai = (window as unknown as { smartlife: { ai: ReturnType<typeof mockAi> } }).smartlife.ai;
    expect(ai.sendMessage).toHaveBeenCalledWith('hi there');
    expect(await screen.findByText('hi there')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Hello there!')).toBeInTheDocument());
  });

  it('shows a confirmation card and calls respondToConfirm on approve', async () => {
    render(<AI />);
    const ai = (window as unknown as { smartlife: { ai: ReturnType<typeof mockAi> } }).smartlife.ai;
    ai.triggerConfirm({ id: 'conf-1', toolName: 'set_theme', description: 'Change theme to "dark"' });

    expect(await screen.findByText('Change theme to "dark"')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(ai.respondToConfirm).toHaveBeenCalledWith('conf-1', true);
  });
});
