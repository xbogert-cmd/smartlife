import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ChatPanel } from './ChatPanel';
import type { ChatMessage } from './useConversation';

function messages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `message ${i}`,
  }));
}

function panel(count: number) {
  return (
    <MemoryRouter>
      <ChatPanel
        messages={messages(count)}
        statusLabel={null}
        pendingConfirm={null}
        sending={false}
        apiKeyConfigured={true}
        input=""
        onInputChange={() => {}}
        onSubmit={() => {}}
        onRespondToConfirm={() => {}}
        attachments={[]}
        attachError={null}
        onAddAttachment={() => {}}
        onRemoveAttachment={() => {}}
        voiceModeOn={false}
        onToggleVoiceMode={vi.fn()}
        isRecording={false}
        onToggleRecording={vi.fn()}
        voiceError={null as string | null}
      />
    </MemoryRouter>
  );
}

// jsdom never lays out content, so every element's real scrollHeight is
// always 0 -- stub it on the prototype so the transcript container reports
// something taller than its (also-zero) clientHeight, giving the
// scroll-to-bottom effect something real to move to.
const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');

function stubScrollHeight(value: number): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => value });
}

afterEach(() => {
  if (scrollHeightDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeightDescriptor);
});

describe('ChatPanel scroll position', () => {
  it('scrolls the transcript to the bottom on mount', () => {
    stubScrollHeight(5000);
    const { container } = render(panel(20));
    const scrollable = container.querySelector('.overflow-auto') as HTMLDivElement;
    expect(scrollable.scrollTop).toBe(5000);
  });

  it('scrolls to the bottom again as new messages arrive', () => {
    stubScrollHeight(3000);
    const { container, rerender } = render(panel(2));
    const scrollable = container.querySelector('.overflow-auto') as HTMLDivElement;
    expect(scrollable.scrollTop).toBe(3000);

    stubScrollHeight(9000);
    rerender(panel(3));
    expect(scrollable.scrollTop).toBe(9000);
  });
});

describe('ChatPanel switch notices', () => {
  it('renders a switch-notice message centered and muted, not as a normal chat bubble', () => {
    render(
      <MemoryRouter>
        <ChatPanel
          messages={[
            { id: '1', role: 'assistant', text: 'Partial answer from the first provider' },
            { id: '2', role: 'assistant', text: 'Switched to Gemini — Claude Sonnet 5 was unavailable (credit balance too low).', kind: 'switch-notice' },
            { id: '3', role: 'assistant', text: 'Full fresh answer from Gemini' },
          ]}
          statusLabel={null}
          pendingConfirm={null}
          sending={false}
          apiKeyConfigured={true}
          input=""
          onInputChange={vi.fn()}
          onSubmit={vi.fn()}
          onRespondToConfirm={vi.fn()}
          attachments={[]}
          attachError={null}
          onAddAttachment={vi.fn()}
          onRemoveAttachment={vi.fn()}
          voiceModeOn={false}
          onToggleVoiceMode={vi.fn()}
          isRecording={false}
          onToggleRecording={vi.fn()}
          voiceError={null as string | null}
        />
      </MemoryRouter>
    );
    expect(screen.getByText(/switched to gemini/i)).toBeInTheDocument();
    expect(screen.getByText('Partial answer from the first provider')).toBeInTheDocument();
    expect(screen.getByText('Full fresh answer from Gemini')).toBeInTheDocument();
  });
});

describe('ChatPanel attachments', () => {
  const baseProps = {
    messages: [],
    statusLabel: null,
    pendingConfirm: null,
    sending: false,
    apiKeyConfigured: true,
    input: '',
    onInputChange: vi.fn(),
    onSubmit: vi.fn(),
    onRespondToConfirm: vi.fn(),
    attachments: [] as { id: string; name: string; kind: 'text' | 'image' }[],
    attachError: null as string | null,
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    voiceModeOn: false,
    onToggleVoiceMode: vi.fn(),
    isRecording: false,
    onToggleRecording: vi.fn(),
    voiceError: null as string | null,
  };

  it('renders an attach chip per pending attachment with a remove control', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} attachments={[{ id: 'a1', name: 'notes.txt', kind: 'text' }]} />
      </MemoryRouter>
    );
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
  });

  it('calls onRemoveAttachment with the chip’s id', async () => {
    const onRemoveAttachment = vi.fn();
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} attachments={[{ id: 'a1', name: 'notes.txt', kind: 'text' }]} onRemoveAttachment={onRemoveAttachment} />
      </MemoryRouter>
    );
    await userEvent.click(screen.getByRole('button', { name: /remove notes.txt/i }));
    expect(onRemoveAttachment).toHaveBeenCalledWith('a1');
  });

  it('calls onAddAttachment when the attach button is clicked', async () => {
    const onAddAttachment = vi.fn();
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} onAddAttachment={onAddAttachment} />
      </MemoryRouter>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Attach a file' }));
    expect(onAddAttachment).toHaveBeenCalled();
  });

  it('shows attachError when present', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} attachError="can't see images" />
      </MemoryRouter>
    );
    expect(screen.getByText("can't see images")).toBeInTheDocument();
  });
});

describe('ChatPanel answeredBy caption', () => {
  const baseProps = {
    statusLabel: null,
    pendingConfirm: null,
    sending: false,
    apiKeyConfigured: true,
    input: '',
    onInputChange: vi.fn(),
    onSubmit: vi.fn(),
    onRespondToConfirm: vi.fn(),
    attachments: [] as { id: string; name: string; kind: 'text' | 'image' }[],
    attachError: null as string | null,
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    voiceModeOn: false,
    onToggleVoiceMode: vi.fn(),
    isRecording: false,
    onToggleRecording: vi.fn(),
    voiceError: null as string | null,
  };

  it('renders an answeredBy caption under an assistant message that has one', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} messages={[{ id: '1', role: 'assistant', text: 'hello', answeredBy: 'Claude Sonnet 5' }]} />
      </MemoryRouter>
    );
    expect(screen.getByText('Claude Sonnet 5')).toBeInTheDocument();
  });

  it('renders no caption under an assistant message that has none', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} messages={[{ id: '1', role: 'assistant', text: 'hello' }]} />
      </MemoryRouter>
    );
    expect(screen.queryByText('Claude Sonnet 5')).not.toBeInTheDocument();
  });
});

describe('ChatPanel voice mode', () => {
  const baseProps = {
    messages: [] as ChatMessage[],
    statusLabel: null,
    pendingConfirm: null,
    sending: false,
    apiKeyConfigured: true,
    input: '',
    onInputChange: vi.fn(),
    onSubmit: vi.fn(),
    onRespondToConfirm: vi.fn(),
    attachments: [] as { id: string; name: string; kind: 'text' | 'image' }[],
    attachError: null as string | null,
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
  };

  it('does not show a mic button when voice mode is off', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} voiceModeOn={false} onToggleVoiceMode={vi.fn()} isRecording={false} onToggleRecording={vi.fn()} voiceError={null} />
      </MemoryRouter>
    );
    expect(screen.queryByRole('button', { name: /voice input/i })).not.toBeInTheDocument();
  });

  it('shows a mic button when voice mode is on, and toggling it calls onToggleRecording', async () => {
    const onToggleRecording = vi.fn();
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} voiceModeOn={true} onToggleVoiceMode={vi.fn()} isRecording={false} onToggleRecording={onToggleRecording} voiceError={null} />
      </MemoryRouter>
    );
    await userEvent.click(screen.getByRole('button', { name: /start voice input/i }));
    expect(onToggleRecording).toHaveBeenCalled();
  });

  it('shows a visibly different control while recording', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} voiceModeOn={true} onToggleVoiceMode={vi.fn()} isRecording={true} onToggleRecording={vi.fn()} voiceError={null} />
      </MemoryRouter>
    );
    expect(screen.getByRole('button', { name: /stop voice input/i })).toBeInTheDocument();
  });

  it('shows voiceError text when present', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} voiceModeOn={true} onToggleVoiceMode={vi.fn()} isRecording={false} onToggleRecording={vi.fn()} voiceError="Could not access the microphone. Check your system permissions." />
      </MemoryRouter>
    );
    expect(screen.getByText('Could not access the microphone. Check your system permissions.')).toBeInTheDocument();
  });

  it('announces voiceError to assistive tech via role="alert"', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} voiceModeOn={true} onToggleVoiceMode={vi.fn()} isRecording={false} onToggleRecording={vi.fn()} voiceError="Could not access the microphone. Check your system permissions." />
      </MemoryRouter>
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not access the microphone. Check your system permissions.');
  });

  it('disables the mic button while a turn is in flight and nothing is recording', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} sending={true} voiceModeOn={true} onToggleVoiceMode={vi.fn()} isRecording={false} onToggleRecording={vi.fn()} voiceError={null} />
      </MemoryRouter>
    );
    expect(screen.getByRole('button', { name: /start voice input/i })).toBeDisabled();
  });

  it('does not disable the mic button while recording, even if sending is true', () => {
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} sending={true} voiceModeOn={true} onToggleVoiceMode={vi.fn()} isRecording={true} onToggleRecording={vi.fn()} voiceError={null} />
      </MemoryRouter>
    );
    expect(screen.getByRole('button', { name: /stop voice input/i })).not.toBeDisabled();
  });

  it('calls onToggleVoiceMode when the voice mode toggle is clicked', async () => {
    const onToggleVoiceMode = vi.fn();
    render(
      <MemoryRouter>
        <ChatPanel {...baseProps} voiceModeOn={false} onToggleVoiceMode={onToggleVoiceMode} isRecording={false} onToggleRecording={vi.fn()} voiceError={null} />
      </MemoryRouter>
    );
    await userEvent.click(screen.getByRole('button', { name: /voice mode/i }));
    expect(onToggleVoiceMode).toHaveBeenCalled();
  });
});
