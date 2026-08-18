import { useState, type FormEvent } from 'react';
import { useConversation } from '../ai/useConversation';
import { ChatPanel } from '../ai/ChatPanel';

export function AI() {
  const conversation = useConversation();
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
    />
  );
}
