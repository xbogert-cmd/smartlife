import { useCallback, useEffect, useRef, useState } from 'react';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  kind?: 'switch-notice';
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

export function useConversation(view: unknown = null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [sending, setSending] = useState(false);
  // Despite the name, this reflects "is any provider usable" (Anthropic,
  // Gemini, or Ollama), not specifically an Anthropic key -- see
  // hasUsableProvider in router.ts. Kept as apiKeyConfigured to avoid a
  // rename that would touch ChatPanel's prop type and its tests for no
  // functional benefit.
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);
  const streamingIdRef = useRef<string | null>(null);

  useEffect(() => {
    window.smartlife.ai
      .hasUsableProvider()
      .then(setApiKeyConfigured)
      .catch(() => setApiKeyConfigured(false));
  }, []);

  useEffect(() => {
    window.smartlife.ai
      .getHistory()
      .then((history) => {
        setMessages(history.map((m, index) => ({ id: `history-${index}`, role: m.role, text: extractText(m.content) })));
      })
      .catch(() => {});
  }, []);

  // Recovers a confirmation that became pending while the dock was closed
  // (and thus this hook wasn't mounted to catch the live onConfirmRequest
  // push) -- same pattern as usePendingConfirmationBadge.ts, which recovers
  // it for the sidebar badge. Also clears pendingConfirm if it resolves
  // through some path other than this component's own respondToConfirm,
  // e.g. the 24-hour timeout firing while the dock happens to be open.
  useEffect(() => {
    let cancelled = false;
    window.smartlife.ai
      .getPendingConfirmation()
      .then((current) => {
        // A live onConfirmRequest push (below) always wins over this
        // recovery fetch -- it can only resolve to something more recent.
        // Without this guard, a slow-resolving fetch that lands after a
        // live push already set pendingConfirm would stomp it back out.
        if (!cancelled) setPendingConfirm((prev) => (prev !== null ? prev : current));
      })
      .catch(() => {});

    const stopResolved = window.smartlife.ai.onConfirmResolved((id) => {
      setPendingConfirm((prev) => (prev?.id === id ? null : prev));
    });

    return () => {
      cancelled = true;
      stopResolved();
    };
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
      } else if (event.type === 'provider-switched') {
        // Next text-delta must start a fresh bubble, not append onto the
        // failed provider's partial text.
        streamingIdRef.current = null;
        setMessages((prev) => [
          ...prev,
          {
            id: `switch-${Date.now()}-${Math.random()}`,
            role: 'assistant',
            text: `Switched to ${event.to} — ${event.from} was unavailable${event.reason ? ` (${event.reason})` : ''}.`,
            kind: 'switch-notice',
          },
        ]);
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
    window.smartlife.ai.sendMessage(text, view).catch(() => {
      setSending(false);
      setMessages((prev) => [
        ...prev,
        { id: `assistant-${Date.now()}-${Math.random()}`, role: 'assistant', text: 'Something went wrong — try again.' },
      ]);
    });
  }, [view]);

  const respondToConfirm = useCallback(
    async (approved: boolean) => {
      if (!pendingConfirm) return;
      await window.smartlife.ai.respondToConfirm(pendingConfirm.id, approved).catch(() => {});
      setPendingConfirm(null);
    },
    [pendingConfirm]
  );

  return { messages, statusLabel, pendingConfirm, sending, apiKeyConfigured, sendMessage, respondToConfirm };
}
