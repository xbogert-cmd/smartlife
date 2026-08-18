import { useState, type FormEvent } from 'react';
import { useConversation } from './useConversation';
import { ChatPanel } from './ChatPanel';

export function AIOverlay({ onClose }: { onClose: () => void }) {
  const conversation = useConversation();
  const [input, setInput] = useState('');

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!input.trim() || conversation.sending) return;
    conversation.sendMessage(input.trim());
    setInput('');
  }

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div
        role="dialog"
        aria-label="Ask AI"
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 480,
          height: 560,
          backgroundColor: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        <ChatPanel
          messages={conversation.messages}
          statusLabel={conversation.statusLabel}
          pendingConfirm={conversation.pendingConfirm}
          sending={conversation.sending}
          input={input}
          onInputChange={setInput}
          onSubmit={handleSubmit}
          onRespondToConfirm={conversation.respondToConfirm}
        />
      </div>
    </div>
  );
}
