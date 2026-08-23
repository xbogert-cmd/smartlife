import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const actual = await vi.importActual<typeof import('electron')>('electron');
  return {
    ...actual,
    Notification: vi.fn(),
  };
});

import { notifyIfUnfocused } from './notify';
import { Notification } from 'electron';

const NotificationMock = vi.mocked(Notification);

beforeEach(() => {
  NotificationMock.mockClear();
  NotificationMock.mockImplementation(() => ({ show: vi.fn() } as never));
});

describe('notifyIfUnfocused', () => {
  it('shows a notification when the window is unfocused', () => {
    const win = { isFocused: () => false } as never;

    notifyIfUnfocused(win, 'Waiting for you', 'Click the button labeled "Submit"');

    expect(NotificationMock).toHaveBeenCalledWith({ title: 'Waiting for you', body: 'Click the button labeled "Submit"' });
  });

  it('does nothing when the window is focused', () => {
    const win = { isFocused: () => true } as never;

    notifyIfUnfocused(win, 'Waiting for you', 'Click the button labeled "Submit"');

    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('does nothing when there is no window at all', () => {
    notifyIfUnfocused(null, 'Waiting for you', 'Click the button labeled "Submit"');

    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('calls show() on the created notification', () => {
    const show = vi.fn();
    NotificationMock.mockImplementation(() => ({ show } as never));
    const win = { isFocused: () => false } as never;

    notifyIfUnfocused(win, 'Waiting for you', 'Click the button labeled "Submit"');

    expect(show).toHaveBeenCalled();
  });
});
