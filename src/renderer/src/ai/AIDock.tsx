import { useState, type FormEvent } from 'react';
import { useConversation } from './useConversation';
import { useViewContext } from './useViewContext';
import { ChatPanel } from './ChatPanel';

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
  const conversation = useConversation(view);
  const [input, setInput] = useState('');

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!input.trim() || conversation.sending) return;
    conversation.sendMessage(input.trim());
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
        <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
          Assistant
        </span>
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
        />
      </div>
    </aside>
  );
}
