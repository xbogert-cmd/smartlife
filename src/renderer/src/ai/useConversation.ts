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

/**
 * Conversation state and every action on it. Deliberately has NO `view`
 * parameter -- unlike the pre-Phase-8c version, `view` is no longer baked in
 * at hook-construction time. This hook is meant to be called exactly ONCE
 * per app session (see ConversationProvider.tsx) and shared between every
 * consumer that wants to talk to the assistant (the AIDock, the /ai route);
 * those consumers can be looking at completely different parts of the app
 * (or none at all) at the moment they send a message, so `view` is supplied
 * per-call by sendMessage() instead.
 */
export function useConversation() {
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

  // Kept in sync with activeConversationId via the effect below so the
  // stream-event handler (a useEffect with an empty dep array, subscribed
  // once) can read the CURRENT active conversation instead of whatever it
  // was at mount time -- a plain closure over the state variable would stay
  // stuck at its initial value (null) forever.
  const activeConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

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
  // sidebar until switched to, never auto-opened. This hook is meant to run
  // exactly once per app session (see the module doc comment above), so
  // "launch" here really does mean once, not once per mount.
  useEffect(() => {
    let cancelled = false;
    window.smartlife.ai
      .createConversation()
      .then(async (id) => {
        // StrictMode double-invokes this effect in dev: the first
        // invocation's cleanup runs (setting cancelled) before its own
        // create call resolves. Without this guard both invocations would
        // apply, leaving an orphan conversation behind every launch.
        if (cancelled) return;
        setActiveConversationId(id);
        setMessages([]);
        await refreshConversations();
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
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
      // main tags every event with the conversation it belongs to
      // (chatController.ts's `send` wrapper). A conversation-tagged event for
      // a conversation that isn't the one currently displayed is discarded --
      // this is what stops a still-streaming reply from a conversation the
      // user switched away from bleeding into whatever they switched to. An
      // event with no conversationId at all (older callers, or a test mock
      // that doesn't set one) is applied unconditionally, same as before this
      // guard existed.
      if (event.conversationId !== undefined && event.conversationId !== activeConversationIdRef.current) {
        return;
      }
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
    (text: string, view: unknown = null) => {
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
    [attachments, activeConversationId, refreshConversations]
  );

  const respondToConfirm = useCallback(
    async (approved: boolean) => {
      if (!pendingConfirm) return;
      await window.smartlife.ai.respondToConfirm(pendingConfirm.id, approved).catch(() => {});
      setPendingConfirm(null);
    },
    [pendingConfirm]
  );

  const latestSwitchRequestRef = useRef<string | null>(null);

  const switchConversation = useCallback(async (id: string) => {
    latestSwitchRequestRef.current = id;
    setActiveConversationId(id);
    streamingIdRef.current = null;
    setStatusLabel(null);
    const history = await window.smartlife.ai.getHistory(id).catch(() => []);
    // A later switchConversation call may have already superseded this one
    // (its getHistory can resolve first) -- only apply this result if it's
    // still the most recently requested conversation.
    if (latestSwitchRequestRef.current !== id) return;
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
