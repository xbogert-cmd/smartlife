import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AIDock } from './AIDock';
import { ConversationProvider } from './ConversationProvider';

const suspend = vi.fn().mockResolvedValue(undefined);
const resume = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  suspend.mockClear();
  resume.mockClear();
  vi.stubGlobal('window', window);
  (window as unknown as { smartlife: unknown }).smartlife = {
    ai: {
      hasUsableProvider: vi.fn().mockResolvedValue(true),
      getHistory: vi.fn().mockResolvedValue([]),
      onStreamEvent: vi.fn().mockReturnValue(() => {}),
      onConfirmRequest: vi.fn().mockReturnValue(() => {}),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      respondToConfirm: vi.fn().mockResolvedValue(undefined),
      getPendingConfirmation: vi.fn().mockResolvedValue(null),
      onConfirmResolved: vi.fn(() => () => {}),
      pickAttachment: vi.fn().mockResolvedValue(null),
      transcribeAudio: vi.fn().mockResolvedValue({ ok: false, reason: 'not used in this test' }),
      createConversation: vi.fn().mockResolvedValue('conv-1'),
      listConversations: vi.fn().mockResolvedValue([]),
      renameConversation: vi.fn().mockResolvedValue(undefined),
      deleteConversation: vi.fn().mockResolvedValue(undefined),
      getCatalog: vi.fn().mockResolvedValue([]),
    },
    browser: { suspend, resume },
  };
});

describe('AIDock', () => {
  it('renders as a complementary region, not a modal dialog', () => {
    render(
      <MemoryRouter>
        <ConversationProvider>
          <AIDock onClose={() => {}} />
        </ConversationProvider>
      </MemoryRouter>
    );
    expect(screen.getByRole('complementary', { name: /assistant/i })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not suspend the browser view', async () => {
    // A dock shrinks the viewport rather than covering it. Suspending would
    // blank the very page the user is asking about.
    render(
      <MemoryRouter>
        <ConversationProvider>
          <AIDock onClose={() => {}} />
        </ConversationProvider>
      </MemoryRouter>
    );
    await Promise.resolve();
    expect(suspend).not.toHaveBeenCalled();
  });

  it('has no full-screen backdrop that would swallow clicks on the page', () => {
    const { container } = render(
      <MemoryRouter>
        <ConversationProvider>
          <AIDock onClose={() => {}} />
        </ConversationProvider>
      </MemoryRouter>
    );
    const fixedFullScreen = Array.from(container.querySelectorAll('*')).filter((element) => {
      const style = (element as HTMLElement).style;
      return style.position === 'fixed' && style.inset === '0px';
    });
    expect(fixedFullScreen).toHaveLength(0);
  });

  it('toggling the sidebar button reveals the conversation list nav', async () => {
    render(
      <MemoryRouter>
        <ConversationProvider>
          <AIDock onClose={() => {}} />
        </ConversationProvider>
      </MemoryRouter>
    );
    expect(screen.queryByRole('navigation', { name: /conversations/i })).toBeNull();
    await userEvent.click(screen.getByLabelText('Toggle conversation list'));
    expect(screen.getByRole('navigation', { name: /conversations/i })).toBeInTheDocument();
  });
});
