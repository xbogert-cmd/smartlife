import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ConversationProvider, useConversationContext, useVoiceContext } from './ConversationProvider';

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
  getCatalog: vi.fn().mockResolvedValue([]),
  transcribeAudio: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'smartlife', { value: { ai }, writable: true, configurable: true });
  ai.hasUsableProvider.mockResolvedValue(true);
  ai.getHistory.mockResolvedValue([]);
  ai.getPendingConfirmation.mockResolvedValue(null);
  ai.createConversation.mockResolvedValue('conv-shared');
  ai.listConversations.mockResolvedValue([]);
  ai.getCatalog.mockResolvedValue([]);
  // Minimal stubs so useVoice (now hoisted into ConversationProvider) can
  // mount without crashing -- these tests don't exercise real recording,
  // just the shared-instance property, so getUserMedia/AudioContext never
  // actually need to be invoked.
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, writable: true, configurable: true });
  vi.stubGlobal('AudioContext', class {});
  vi.stubGlobal('speechSynthesis', { speak: vi.fn(), cancel: vi.fn() });
  vi.stubGlobal('SpeechSynthesisUtterance', class {
    text: string;
    constructor(text: string) {
      this.text = text;
    }
  });
});

afterEach(() => {
  // Explicit, ordered cleanup() before unstubbing globals -- see the
  // matching comment in useVoice.test.ts for why order matters here now
  // that useVoice's unmount effect reaches for window.speechSynthesis.
  cleanup();
  vi.unstubAllGlobals();
});

function ConsumerA() {
  const { activeConversationId } = useConversationContext();
  return <div data-testid="a">{activeConversationId ?? 'none'}</div>;
}
function ConsumerB() {
  const { activeConversationId } = useConversationContext();
  return <div data-testid="b">{activeConversationId ?? 'none'}</div>;
}

function VoiceConsumerA() {
  const { voiceModeOn, isRecording, toggleVoiceMode } = useVoiceContext();
  return (
    <div>
      <div data-testid="voice-a">{`${voiceModeOn}:${isRecording}`}</div>
      <button type="button" onClick={toggleVoiceMode}>
        toggle from A
      </button>
    </div>
  );
}
function VoiceConsumerB() {
  const { voiceModeOn, isRecording } = useVoiceContext();
  return <div data-testid="voice-b">{`${voiceModeOn}:${isRecording}`}</div>;
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

  it('throws when useVoiceContext is used outside a provider', () => {
    function Bare() {
      useVoiceContext();
      return null;
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Bare />)).toThrow('useVoiceContext must be used within a ConversationProvider');
    consoleError.mockRestore();
  });

  it('shares the same conversation state across multiple consumers', async () => {
    render(
      <MemoryRouter>
        <ConversationProvider>
          <ConsumerA />
          <ConsumerB />
        </ConversationProvider>
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('conv-shared'));
    expect(screen.getByTestId('b').textContent).toBe('conv-shared');
    expect(ai.createConversation).toHaveBeenCalledTimes(1);
  });

  it('shares the same voice state across multiple consumers', async () => {
    render(
      <MemoryRouter>
        <ConversationProvider>
          <VoiceConsumerA />
          <VoiceConsumerB />
        </ConversationProvider>
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByTestId('voice-a').textContent).toBe('false:false'));
    expect(screen.getByTestId('voice-b').textContent).toBe('false:false');
  });

  // The test above only proves both consumers start with the same value --
  // two independent instances that both default to false:false would pass
  // it too. Prove sharing for real: toggle from one consumer and require
  // the OTHER, never-clicked consumer to observe the change.
  it('propagates a voice-mode toggle made through one consumer to every other consumer', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ConversationProvider>
          <VoiceConsumerA />
          <VoiceConsumerB />
        </ConversationProvider>
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByTestId('voice-a').textContent).toBe('false:false'));
    expect(screen.getByTestId('voice-b').textContent).toBe('false:false');

    await user.click(screen.getByRole('button', { name: 'toggle from A' }));

    expect(screen.getByTestId('voice-a').textContent).toBe('true:false');
    expect(screen.getByTestId('voice-b').textContent).toBe('true:false');
  });
});
