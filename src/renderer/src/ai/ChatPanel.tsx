import { useLayoutEffect, useRef, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChatMessage, PendingAttachment, PendingConfirm } from './useConversation';
import { ModelPicker } from './ModelPicker';
import { getSectionTheme } from '../nav/sectionThemes';

const SUGGESTIONS = ["What's due this week?", "Summarize today's readings", 'Add a study block'];
const AI_THEME = getSectionTheme('ai');

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
  attachments: PendingAttachment[];
  attachError: string | null;
  onAddAttachment: () => void;
  onRemoveAttachment: (id: string) => void;
  /** Called before navigating to Settings from the empty state — lets AIDock close itself first. */
  onNavigateAway?: () => void;
  voiceModeOn: boolean;
  onToggleVoiceMode: () => void;
  isRecording: boolean;
  onToggleRecording: () => void;
  voiceError: string | null;
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
  attachments,
  attachError,
  onAddAttachment,
  onRemoveAttachment,
  onNavigateAway,
  voiceModeOn,
  onToggleVoiceMode,
  isRecording,
  onToggleRecording,
  voiceError,
}: ChatPanelProps) {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Runs on every mount (the dock unmounts on close, so reopening is always a
  // fresh mount) and whenever the transcript grows, so it lands on the latest
  // message instead of the top. useLayoutEffect fires before paint, so there
  // is no visible top-of-chat flash before the jump.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, statusLabel, pendingConfirm]);

  if (apiKeyConfigured !== true) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p style={{ color: 'var(--color-text)' }}>Connect an AI provider in Settings to start chatting.</p>
        <p style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
          Add a Claude, Gemini, or local Ollama entry to your provider list to unlock the AI assistant.
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
      <div className="flex items-center justify-end gap-2 px-4 pt-3">
        <ModelPicker />
        <button
          type="button"
          onClick={onToggleVoiceMode}
          aria-label="Voice mode"
          aria-pressed={voiceModeOn}
          className="rounded-md px-2 py-1 text-xs"
          style={{
            backgroundColor: voiceModeOn ? 'var(--color-text)' : 'var(--color-surface)',
            color: voiceModeOn ? 'var(--color-bg)' : 'var(--color-text)',
            border: '1px solid var(--color-border)',
          }}
        >
          🎙 Voice mode
        </button>
      </div>
      <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-auto p-6">
        {messages.length === 0 && !statusLabel && !pendingConfirm ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4">
            <div className="h-11 w-11 flex-shrink-0 rounded-xl" style={{ background: AI_THEME.gradient }} />
            <p className="text-base font-semibold" style={{ color: 'var(--color-text)' }}>
              What can I help with?
            </p>
            <div className="flex flex-wrap justify-center gap-2" style={{ maxWidth: 380 }}>
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => onInputChange(suggestion)}
                  className="rounded-full px-3.5 py-1.5 text-xs"
                  style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((message) =>
              message.kind === 'switch-notice' ? (
                <div
                  key={message.id}
                  style={{ alignSelf: 'center', color: 'var(--color-text-muted)', fontSize: 13, textAlign: 'center' }}
                >
                  {message.text}
                </div>
              ) : (
                <div
                  key={message.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
                    alignItems: message.role === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '70%',
                  }}
                >
                  <div
                    style={{
                      padding: '8px 12px',
                      borderRadius: message.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                      boxShadow: '0 2px 6px rgba(0, 0, 0, 0.15)',
                      whiteSpace: 'pre-wrap',
                      backgroundColor: message.role === 'user' ? AI_THEME.accent : 'var(--color-surface)',
                      color: message.role === 'user' ? '#ffffff' : 'var(--color-text)',
                      border: message.role === 'assistant' ? '1px solid var(--color-border)' : undefined,
                    }}
                  >
                    {message.text}
                  </div>
                  {message.role === 'assistant' && message.answeredBy && (
                    <div style={{ color: 'var(--color-text-muted)', fontSize: 11, marginTop: 2 }}>{message.answeredBy}</div>
                  )}
                </div>
              )
            )}
            {statusLabel && <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>{statusLabel}…</div>}
            {pendingConfirm && (
              <div
                style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: 12, backgroundColor: 'var(--color-surface)' }}
              >
                <p style={{ color: 'var(--color-text)', marginBottom: 8, whiteSpace: 'pre-wrap' }}>{pendingConfirm.description}</p>
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
          </>
        )}
      </div>
      {(attachments.length > 0 || attachError || voiceError) && (
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
          {attachments.map((attachment) => (
            <span
              key={attachment.id}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs"
              style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            >
              {attachment.name}
              <button
                type="button"
                onClick={() => onRemoveAttachment(attachment.id)}
                aria-label={`Remove ${attachment.name}`}
                style={{ color: 'var(--color-text-muted)' }}
              >
                ×
              </button>
            </span>
          ))}
          {attachError && <span style={{ color: 'var(--color-danger)', fontSize: 12 }}>{attachError}</span>}
          {voiceError && (
            <span role="alert" style={{ color: 'var(--color-danger)', fontSize: 12 }}>
              {voiceError}
            </span>
          )}
        </div>
      )}
      <form onSubmit={onSubmit} className="p-4" style={{ borderTop: '1px solid var(--color-border)' }}>
        <div
          className="flex items-center gap-1.5 rounded-2xl px-2 py-1.5"
          style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
        >
          {voiceModeOn && (
            <button
              type="button"
              onClick={onToggleRecording}
              aria-label={isRecording ? 'Stop voice input' : 'Start voice input'}
              disabled={!isRecording && sending}
              className="flex-shrink-0 rounded-xl px-3 py-1.5 text-sm"
              style={{
                backgroundColor: isRecording ? 'var(--color-danger)' : 'transparent',
                color: isRecording ? '#ffffff' : 'var(--color-text)',
              }}
            >
              {isRecording ? '● Stop' : '🎙'}
            </button>
          )}
          <button
            type="button"
            onClick={onAddAttachment}
            aria-label="Attach a file"
            className="flex-shrink-0 rounded-xl px-2.5 py-1.5 text-sm"
            style={{ color: 'var(--color-text)' }}
          >
            Attach
          </button>
          <input
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            placeholder="Ask SmartLife…"
            className="flex-1 bg-transparent px-1 py-1.5 text-sm outline-none"
            style={{ color: 'var(--color-text)' }}
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            className="flex-shrink-0 rounded-xl px-4 py-1.5 text-sm"
            style={{ backgroundColor: 'var(--color-text)', color: 'var(--color-bg)' }}
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
