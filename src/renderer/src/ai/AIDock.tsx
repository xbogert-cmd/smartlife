import { useState, type FormEvent } from 'react';
import { useConversationContext, useVoiceContext } from './ConversationProvider';
import { useViewContext } from './useViewContext';
import { ChatPanel } from './ChatPanel';
import { ConversationSidebar } from './ConversationSidebar';

/**
 * The assistant as a docked side panel rather than a modal overlay.
 *
 * Deliberately NOT a dialog and deliberately without a backdrop: the user is
 * meant to keep reading and clicking the page while asking about it. It also
 * must not suspend the native browser view -- a dock shrinks the viewport
 * instead of covering it, and hiding the page would defeat the whole purpose.
 */
export function AIDock({ onClose }: { onClose: () => void }): React.JSX.Element {
  const view = useViewContext();
  const conversation = useConversationContext();
  const voice = useVoiceContext();
  const [input, setInput] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!input.trim() || conversation.sending) return;
    conversation.sendMessage(input.trim(), view, voice.voiceModeOn);
    setInput('');
  }

  return (
    <aside
      aria-label="Assistant"
      className="flex w-96 flex-shrink-0 flex-col border-l"
      style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-bg)' }}
    >
      <div
        className="flex items-center justify-between border-b px-3 py-2"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSidebarOpen((prev) => !prev)}
            aria-label="Toggle conversation list"
            aria-pressed={sidebarOpen}
            className="rounded px-1.5 py-0.5 text-sm"
            style={{ color: 'var(--color-text-muted)' }}
          >
            ☰
          </button>
          <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            Assistant
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close assistant"
          className="rounded px-2 py-0.5 text-sm"
          style={{ color: 'var(--color-text-muted)' }}
        >
          ×
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <ConversationSidebar
            conversations={conversation.conversations}
            activeConversationId={conversation.activeConversationId}
            onSwitch={conversation.switchConversation}
            onNew={conversation.startNewConversation}
            onRename={conversation.renameConversation}
            onDelete={conversation.deleteConversation}
          />
        )}
        <div className="min-h-0 flex-1">
          <ChatPanel
            messages={conversation.messages}
            statusLabel={conversation.statusLabel}
            pendingConfirm={conversation.pendingConfirm}
            sending={conversation.sending}
            apiKeyConfigured={conversation.apiKeyConfigured}
            input={input}
            onInputChange={setInput}
            onSubmit={handleSubmit}
            onRespondToConfirm={conversation.respondToConfirm}
            onNavigateAway={onClose}
            attachments={conversation.attachments}
            attachError={conversation.attachError}
            onAddAttachment={conversation.addAttachment}
            onRemoveAttachment={conversation.removeAttachment}
            voiceModeOn={voice.voiceModeOn}
            onToggleVoiceMode={voice.toggleVoiceMode}
            isRecording={voice.isRecording}
            onToggleRecording={voice.toggleRecording}
            voiceError={voice.voiceError}
          />
        </div>
      </div>
    </aside>
  );
}
