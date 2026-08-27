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

export interface PendingAttachment {
  id: string;
  name: string;
  kind: 'text' | 'image';
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: string;
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
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const streamingIdRef = useRef<string | null>(null);

  useEffect(() => {
    window.smartlife.ai
      .hasUsableProvider()
      .then(setApiKeyConfigured)
      .catch(() => setApiKeyConfigured(false));
  }, []);

  const refreshConversations = useCallback(async () => {
    const list = await window.smartlife.ai.listConversations().catch(() => []);
    setConversations(list);
  }, []);

  // Launch always starts a brand-new conversation -- old ones wait in the
  // sidebar until switched to, never auto-opened.
  useEffect(() => {
    window.smartlife.ai
      .createConversation()
      .then(async (id) => {
        setActiveConversationId(id);
        setMessages([]);
        await refreshConversations();
      })
      .catch(() => {});
  }, [refreshConversations]);

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

  const addAttachment = useCallback(async () => {
    const result = await window.smartlife.ai.pickAttachment().catch(() => null);
    if (!result) return;
    if (!result.ok) {
      setAttachError(result.reason);
      return;
    }
    setAttachError(null);
    setAttachments((prev) => [...prev, { id: result.id, name: result.name, kind: result.kind }]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const sendMessage = useCallback(
    (text: string) => {
      if (!activeConversationId) return;
      const id = `user-${Date.now()}-${Math.random()}`;
      setMessages((prev) => [...prev, { id, role: 'user', text }]);
      setSending(true);
      streamingIdRef.current = null;
      const attachmentIds = attachments.map((a) => a.id);
      setAttachments([]);
      window.smartlife.ai
        .sendMessage(text, view, attachmentIds, activeConversationId)
        .then(() => refreshConversations())
        .catch(() => {
          setSending(false);
          setMessages((prev) => [
            ...prev,
            { id: `assistant-${Date.now()}-${Math.random()}`, role: 'assistant', text: 'Something went wrong — try again.' },
          ]);
        });
    },
    [view, attachments, activeConversationId, refreshConversations]
  );

  const respondToConfirm = useCallback(
    async (approved: boolean) => {
      if (!pendingConfirm) return;
      await window.smartlife.ai.respondToConfirm(pendingConfirm.id, approved).catch(() => {});
      setPendingConfirm(null);
    },
    [pendingConfirm]
  );

  const switchConversation = useCallback(async (id: string) => {
    setActiveConversationId(id);
    streamingIdRef.current = null;
    setStatusLabel(null);
    const history = await window.smartlife.ai.getHistory(id).catch(() => []);
    setMessages(history.map((m, index) => ({ id: `history-${index}`, role: m.role, text: extractText(m.content) })));
  }, []);

  const startNewConversation = useCallback(async () => {
    const id = await window.smartlife.ai.createConversation();
    setActiveConversationId(id);
    setMessages([]);
    streamingIdRef.current = null;
    setStatusLabel(null);
    await refreshConversations();
  }, [refreshConversations]);

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      await window.smartlife.ai.renameConversation(id, title);
      await refreshConversations();
    },
    [refreshConversations]
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      await window.smartlife.ai.deleteConversation(id);
      if (id === activeConversationId) {
        await startNewConversation();
      } else {
        await refreshConversations();
      }
    },
    [activeConversationId, startNewConversation, refreshConversations]
  );

  return {
    messages,
    statusLabel,
    pendingConfirm,
    sending,
    apiKeyConfigured,
    attachments,
    attachError,
    addAttachment,
    removeAttachment,
    sendMessage,
    respondToConfirm,
    conversations,
    activeConversationId,
    switchConversation,
    startNewConversation,
    renameConversation,
    deleteConversation,
  };
}
