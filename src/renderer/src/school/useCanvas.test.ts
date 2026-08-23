import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useCanvas } from './useCanvas';

const canvas = {
  getStatus: vi.fn(),
  getUpcoming: vi.fn(),
  getGrades: vi.fn(),
  getAnnouncements: vi.fn(),
  syncNow: vi.fn(),
  onSyncChanged: vi.fn(() => () => {}),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'smartlife', {
    value: { canvas },
    writable: true,
    configurable: true,
  });
  canvas.getStatus.mockResolvedValue({ tokenConfigured: true, baseUrlConfigured: true });
  canvas.getUpcoming.mockResolvedValue([{ id: 1, name: 'Essay' }]);
  canvas.getGrades.mockResolvedValue([{ id: 3, name: 'Accounting' }]);
  canvas.getAnnouncements.mockResolvedValue([{ id: 4, title: 'Class cancelled' }]);
  canvas.syncNow.mockResolvedValue({});
  canvas.onSyncChanged.mockReturnValue(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useCanvas', () => {
  it('loads every source', async () => {
    const { result } = renderHook(() => useCanvas());
    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(result.current.upcoming).toHaveLength(1);
    expect(result.current.grades).toHaveLength(1);
    expect(result.current.announcements).toHaveLength(1);
  });

  it('clears syncing even when the sync call rejects', async () => {
    canvas.syncNow.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useCanvas());
    await waitFor(() => expect(result.current.status).not.toBeNull());

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.syncing).toBe(false);
  });

  it('keeps the newer load result when an older, slower load resolves after it', async () => {
    // canvas:sync-now broadcasts canvas:sync-changed before syncNow()
    // resolves, so refresh() can have two load() calls racing: the
    // onSyncChanged listener's and refresh()'s own explicit one. A slow
    // first load must not clobber a faster, newer second load.
    const { result } = renderHook(() => useCanvas());
    await waitFor(() => expect(result.current.status).not.toBeNull());

    let resolveFirst: (v: unknown[]) => void = () => {};
    const firstCall = new Promise<unknown[]>((resolve) => {
      resolveFirst = resolve;
    });
    canvas.getUpcoming
      .mockImplementationOnce(() => firstCall)
      .mockImplementationOnce(async () => [{ id: 99, name: 'Newer assignment' }]);

    let firstLoad!: Promise<void>;
    let secondLoad!: Promise<void>;
    act(() => {
      firstLoad = result.current.refresh();
    });
    await waitFor(() => expect(canvas.getUpcoming).toHaveBeenCalledTimes(1));
    act(() => {
      secondLoad = result.current.refresh();
    });
    await waitFor(() => expect(canvas.getUpcoming).toHaveBeenCalledTimes(2));

    await act(async () => {
      await secondLoad;
    });
    expect(result.current.upcoming).toEqual([{ id: 99, name: 'Newer assignment' }]);

    await act(async () => {
      resolveFirst([{ id: 1, name: 'Essay' }]);
      await firstLoad;
    });

    // The stale first load resolving late must not overwrite the newer data.
    expect(result.current.upcoming).toEqual([{ id: 99, name: 'Newer assignment' }]);
  });
});
