import { createContext, useContext, type ReactNode } from 'react';
import { useConversation } from './useConversation';
import { useVoice } from './useVoice';
import { useViewContext } from './useViewContext';

type ConversationContextValue = ReturnType<typeof useConversation>;
type VoiceContextValue = ReturnType<typeof useVoice>;

const ConversationContext = createContext<ConversationContextValue | null>(null);
const VoiceContext = createContext<VoiceContextValue | null>(null);

/**
 * Calls useConversation() AND useVoice() exactly ONCE for the whole app
 * session and shares both via context. Must wrap every consumer that talks
 * to the assistant -- AIDock and the /ai route are SIBLINGS that can both be
 * mounted simultaneously (the dock can be open while the /ai route is also
 * showing), not alternatives. Two independent useVoice instances used to
 * mean: two independently-toggled "voice mode" states that could disagree,
 * and -- worse -- a completed reply spoken twice if both happened to have
 * voice mode on, since each instance's own turn-complete effect would fire.
 */
export function ConversationProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const conversation = useConversation();
  const view = useViewContext();
  const voice = useVoice({
    messages: conversation.messages,
    sending: conversation.sending,
    sendMessage: (text, voiceMode) => conversation.sendMessage(text, view, voiceMode),
  });
  return (
    <ConversationContext.Provider value={conversation}>
      <VoiceContext.Provider value={voice}>{children}</VoiceContext.Provider>
    </ConversationContext.Provider>
  );
}

export function useConversationContext(): ConversationContextValue {
  const value = useContext(ConversationContext);
  if (value === null) {
    throw new Error('useConversationContext must be used within a ConversationProvider');
  }
  return value;
}

export function useVoiceContext(): VoiceContextValue {
  const value = useContext(VoiceContext);
  if (value === null) {
    throw new Error('useVoiceContext must be used within a ConversationProvider');
  }
  return value;
}
