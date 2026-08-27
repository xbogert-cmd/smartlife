import { useState, type FormEvent } from 'react';
import { useConversationContext } from '../ai/ConversationProvider';
import { ChatPanel } from '../ai/ChatPanel';

export function AI() {
  const conversation = useConversationContext();
  const [input, setInput] = useState('');

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!input.trim() || conversation.sending) return;
    conversation.sendMessage(input.trim());
    setInput('');
  }

  return (
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
      attachments={conversation.attachments}
      attachError={conversation.attachError}
      onAddAttachment={conversation.addAttachment}
      onRemoveAttachment={conversation.removeAttachment}
    />
  );
}
