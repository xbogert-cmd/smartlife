import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConversationSidebar, relativeTime } from './ConversationSidebar';

const conversations = [
  { id: 'conv-1', title: 'Homework help', updatedAt: '2026-01-01 00:00:00' },
  { id: 'conv-2', title: null, updatedAt: '2026-01-02 00:00:00' },
];

describe('ConversationSidebar', () => {
  it('lists every conversation by title, falling back to a placeholder for an unset title', () => {
    render(
      <ConversationSidebar
        conversations={conversations}
        activeConversationId="conv-1"
        onSwitch={() => {}}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
      />
    );
    expect(screen.getByText('Homework help')).toBeInTheDocument();
    expect(screen.getByText('New conversation')).toBeInTheDocument();
  });

  it('calls onSwitch when a conversation row is clicked', async () => {
    const onSwitch = vi.fn();
    render(
      <ConversationSidebar
        conversations={conversations}
        activeConversationId="conv-1"
        onSwitch={onSwitch}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
      />
    );
    await userEvent.click(screen.getByText('Homework help'));
    expect(onSwitch).toHaveBeenCalledWith('conv-1');
  });

  it('calls onNew when the New button is clicked', async () => {
    const onNew = vi.fn();
    render(
      <ConversationSidebar
        conversations={conversations}
        activeConversationId="conv-1"
        onSwitch={() => {}}
        onNew={onNew}
        onRename={() => {}}
        onDelete={() => {}}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: '+ New' }));
    expect(onNew).toHaveBeenCalled();
  });

  it('shows an inline confirm before calling onDelete', async () => {
    const onDelete = vi.fn();
    render(
      <ConversationSidebar
        conversations={conversations}
        activeConversationId="conv-1"
        onSwitch={() => {}}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={onDelete}
      />
    );
    await userEvent.click(screen.getByLabelText('Delete Homework help'));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText('Delete this conversation?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith('conv-1');
  });

  it('commits a rename on Enter', async () => {
    const onRename = vi.fn();
    render(
      <ConversationSidebar
        conversations={conversations}
        activeConversationId="conv-1"
        onSwitch={() => {}}
        onNew={() => {}}
        onRename={onRename}
        onDelete={() => {}}
      />
    );
    await userEvent.click(screen.getByLabelText('Rename Homework help'));
    const input = screen.getByDisplayValue('Homework help');
    await userEvent.clear(input);
    await userEvent.type(input, 'New Title{Enter}');
    expect(onRename).toHaveBeenCalledWith('conv-1', 'New Title');
  });

  it('parses SQLite UTC timestamps correctly regardless of the local machine timezone', () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
      // 90 minutes before "now" in UTC, formatted the way SQLite's datetime('now') would (space-separated, no Z).
      // Parsed naively (as local time by V8) this would shift by the machine's UTC offset and land on a
      // different bucket than "1h ago" on most timezones -- the fix makes it timezone-independent.
      expect(relativeTime('2026-01-01 10:30:00')).toBe('1h ago');
      vi.useRealTimers();
    } finally {
      process.env.TZ = originalTz;
    }
  });
});
