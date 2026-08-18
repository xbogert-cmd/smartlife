import { useCallback, useEffect, useRef, useState } from 'react';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface PendingConfirm {
  id: string;
  toolName: string;
  description: string;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text: string } => {
      return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text';
    })
    .map((block) => block.text)
    .join('');
}

export function useConversation() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [sending, setSending] = useState(false);
  const streamingIdRef = useRef<string | null>(null);

  useEffect(() => {
    window.smartlife.ai
      .getHistory()
      .then((history) => {
        setMessages(history.map((m, index) => ({ id: `history-${index}`, role: m.role, text: extractText(m.content) })));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unsubscribeStream = window.smartlife.ai.onStreamEvent((event) => {
      if (event.type === 'text-delta') {
        setStatusLabel(null);
        setMessages((prev) => {
          if (streamingIdRef.current) {
            return prev.map((m) => (m.id === streamingIdRef.current ? { ...m, text: m.text + (event.text ?? '') } : m));
          }
          const id = `assistant-${Date.now()}-${Math.random()}`;
          streamingIdRef.current = id;
          return [...prev, { id, role: 'assistant', text: event.text ?? '' }];
        });
      } else if (event.type === 'tool-status') {
        setStatusLabel(event.toolLabel ?? null);
      } else if (event.type === 'turn-complete') {
        setStatusLabel(null);
        streamingIdRef.current = null;
        setSending(false);
      }
    });

    const unsubscribeConfirm = window.smartlife.ai.onConfirmRequest((req) => {
      setPendingConfirm(req);
    });

    return () => {
      unsubscribeStream();
      unsubscribeConfirm();
    };
  }, []);

  const sendMessage = useCallback((text: string) => {
    const id = `user-${Date.now()}-${Math.random()}`;
    setMessages((prev) => [...prev, { id, role: 'user', text }]);
    setSending(true);
    streamingIdRef.current = null;
    window.smartlife.ai.sendMessage(text).catch(() => {
      setSending(false);
      setMessages((prev) => [
        ...prev,
        { id: `assistant-${Date.now()}-${Math.random()}`, role: 'assistant', text: 'Something went wrong — try again.' },
      ]);
    });
  }, []);

  const respondToConfirm = useCallback(
    async (approved: boolean) => {
      if (!pendingConfirm) return;
      await window.smartlife.ai.respondToConfirm(pendingConfirm.id, approved).catch(() => {});
      setPendingConfirm(null);
    },
    [pendingConfirm]
  );

  return { messages, statusLabel, pendingConfirm, sending, sendMessage, respondToConfirm };
}
