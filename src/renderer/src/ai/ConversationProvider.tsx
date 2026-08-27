import { createContext, useContext, type ReactNode } from 'react';
import { useConversation } from './useConversation';

type ConversationContextValue = ReturnType<typeof useConversation>;

const ConversationContext = createContext<ConversationContextValue | null>(null);

/**
 * Calls useConversation() exactly ONCE for the whole app session and shares
 * it via context. Must wrap every consumer that talks to the assistant --
 * AIDock and the /ai route both render a ChatPanel backed by this same
 * conversation, not two independent ones. Two independent hook instances
 * used to mean: two separate `ai:create-conversation` calls (a fresh,
 * empty conversation every time either one mounted, instead of once per
 * launch), and two separate `onStreamEvent` subscriptions each rendering
 * into their own transcript from the same global event stream.
 */
export function ConversationProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const conversation = useConversation();
  return <ConversationContext.Provider value={conversation}>{children}</ConversationContext.Provider>;
}

export function useConversationContext(): ConversationContextValue {
  const value = useContext(ConversationContext);
  if (value === null) {
    throw new Error('useConversationContext must be used within a ConversationProvider');
  }
  return value;
}
