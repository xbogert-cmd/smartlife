import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChatMessage, PendingConfirm } from './useConversation';

export interface ChatPanelProps {
  messages: ChatMessage[];
  statusLabel: string | null;
  pendingConfirm: PendingConfirm | null;
  sending: boolean;
  apiKeyConfigured: boolean | null;
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onRespondToConfirm: (approved: boolean) => void;
  /** Called before navigating to Settings from the empty state — lets AIOverlay close itself first. */
  onNavigateAway?: () => void;
}

export function ChatPanel({
  messages,
  statusLabel,
  pendingConfirm,
  sending,
  apiKeyConfigured,
  input,
  onInputChange,
  onSubmit,
  onRespondToConfirm,
  onNavigateAway,
}: ChatPanelProps) {
  const navigate = useNavigate();

  if (apiKeyConfigured !== true) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p style={{ color: 'var(--color-text)' }}>Connect Claude in Settings to start chatting.</p>
        <p style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
          Add your Claude API key to unlock the AI assistant.
        </p>
        <button
          type="button"
          onClick={() => {
            onNavigateAway?.();
            navigate('/settings');
          }}
          className="rounded-md px-4 py-2 text-sm"
          style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
        >
          Go to Settings
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col gap-3 overflow-auto p-6">
        {messages.map((message) => (
          <div
            key={message.id}
            style={{
              alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '70%',
              padding: '8px 12px',
              borderRadius: 8,
              whiteSpace: 'pre-wrap',
              backgroundColor: message.role === 'user' ? '#22D3EE' : 'var(--color-surface)',
              color: message.role === 'user' ? '#ffffff' : 'var(--color-text)',
              border: message.role === 'assistant' ? '1px solid var(--color-border)' : undefined,
            }}
          >
            {message.text}
          </div>
        ))}
        {statusLabel && <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>{statusLabel}…</div>}
        {pendingConfirm && (
          <div
            style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: 12, backgroundColor: 'var(--color-surface)' }}
          >
            <p style={{ color: 'var(--color-text)', marginBottom: 8 }}>{pendingConfirm.description}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onRespondToConfirm(true)}
                className="rounded-md px-3 py-1.5 text-sm"
                style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => onRespondToConfirm(false)}
                className="rounded-md px-3 py-1.5 text-sm"
                style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
              >
                Deny
              </button>
            </div>
          </div>
        )}
      </div>
      <form onSubmit={onSubmit} className="flex gap-2 p-4" style={{ borderTop: '1px solid var(--color-border)' }}>
        <input
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          placeholder="Ask SmartLife…"
          className="flex-1 rounded-md px-3 py-2 text-sm"
          style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="rounded-md px-4 py-2 text-sm"
          style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
