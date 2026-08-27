import { useState, type FormEvent } from 'react';
import { useConversationContext } from '../ai/ConversationProvider';
import { ChatPanel } from '../ai/ChatPanel';
import { useVoice } from '../ai/useVoice';

export function AI() {
  const conversation = useConversationContext();
  const voice = useVoice({
    messages: conversation.messages,
    sending: conversation.sending,
    sendMessage: (text, voiceMode) => conversation.sendMessage(text, undefined, voiceMode),
  });
  const [input, setInput] = useState('');

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!input.trim() || conversation.sending) return;
    conversation.sendMessage(input.trim(), undefined, voice.voiceModeOn);
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
      voiceModeOn={voice.voiceModeOn}
      onToggleVoiceMode={voice.toggleVoiceMode}
      isRecording={voice.isRecording}
      onToggleRecording={voice.toggleRecording}
      voiceError={voice.voiceError}
    />
  );
}
