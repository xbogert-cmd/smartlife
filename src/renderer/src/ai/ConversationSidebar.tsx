import { useState } from 'react';
import type { ConversationSummary } from './useConversation';

export interface ConversationSidebarProps {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

export function relativeTime(iso: string): string {
  // SQLite's datetime('now') returns UTC in a space-separated, non-ISO
  // format ("2026-01-01 00:00:00"). Parsed directly, V8 reads that as LOCAL
  // time, silently shifting every relative time by the machine's UTC offset.
  // Converting to a real ISO string with an explicit Z fixes that.
  const diffMs = Date.now() - new Date(iso.replace(' ', 'T') + 'Z').getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ConversationSidebar({
  conversations,
  activeConversationId,
  onSwitch,
  onNew,
  onRename,
  onDelete,
}: ConversationSidebarProps): React.JSX.Element {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  function startRename(id: string, currentTitle: string | null): void {
    setRenamingId(id);
    setRenameValue(currentTitle ?? '');
  }

  function commitRename(id: string): void {
    if (renameValue.trim()) onRename(id, renameValue.trim());
    setRenamingId(null);
  }

  return (
    <nav
      aria-label="Conversations"
      className="flex w-48 flex-shrink-0 flex-col overflow-auto border-r"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <button
        type="button"
        onClick={onNew}
        className="m-2 rounded-md px-2 py-1.5 text-left text-sm"
        style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
      >
        + New
      </button>
      <ul className="flex flex-1 flex-col gap-0.5 px-1 pb-2">
        {conversations.map((conversation) => (
          <li key={conversation.id}>
            <div
              className="flex items-center gap-1 rounded-md px-2 py-1.5"
              style={{
                backgroundColor: conversation.id === activeConversationId ? 'var(--color-surface)' : undefined,
              }}
            >
              {renamingId === conversation.id ? (
                <input
                  aria-label="Conversation title"
                  autoFocus
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={() => commitRename(conversation.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitRename(conversation.id);
                    if (event.key === 'Escape') setRenamingId(null);
                  }}
                  className="min-w-0 flex-1 rounded px-1 text-sm"
                  style={{ backgroundColor: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => onSwitch(conversation.id)}
                  className="min-w-0 flex-1 truncate text-left text-sm"
                  style={{ color: 'var(--color-text)', background: 'none', border: 'none' }}
                >
                  {conversation.title ?? 'New conversation'}
                  <span className="block text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {relativeTime(conversation.updatedAt)}
                  </span>
                </button>
              )}
              <button
                type="button"
                aria-label={`Rename ${conversation.title ?? 'conversation'}`}
                onClick={() => startRename(conversation.id, conversation.title)}
                style={{ color: 'var(--color-text-muted)' }}
              >
                ✎
              </button>
              <button
                type="button"
                aria-label={`Delete ${conversation.title ?? 'conversation'}`}
                onClick={() => setConfirmingDeleteId(conversation.id)}
                style={{ color: 'var(--color-text-muted)' }}
              >
                🗑
              </button>
            </div>
            {confirmingDeleteId === conversation.id && (
              <div
                className="mx-2 mb-1 rounded-md p-2 text-xs"
                style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
              >
                <p style={{ color: 'var(--color-text)' }}>Delete this conversation?</p>
                <div className="mt-1 flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      onDelete(conversation.id);
                      setConfirmingDeleteId(null);
                    }}
                    style={{ color: '#EF4444' }}
                  >
                    Delete
                  </button>
                  <button type="button" onClick={() => setConfirmingDeleteId(null)} style={{ color: 'var(--color-text-muted)' }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
