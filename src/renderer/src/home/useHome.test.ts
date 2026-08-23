import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useHome } from './useHome';

const canvas = {
  getStatus: vi.fn(),
  getUpcoming: vi.fn(),
  getOverdue: vi.fn(),
  getGrades: vi.fn(),
  getAnnouncements: vi.fn(),
  syncNow: vi.fn(),
  onSyncChanged: vi.fn(() => () => {}),
};
const calendar = {
  getStatus: vi.fn(),
  getEvents: vi.fn(),
  syncNow: vi.fn(),
  onSyncChanged: vi.fn(() => () => {}),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'smartlife', {
    value: { canvas, calendar },
    writable: true,
    configurable: true,
  });
  canvas.getStatus.mockResolvedValue({ tokenConfigured: true, baseUrlConfigured: true });
  canvas.getUpcoming.mockResolvedValue([{ id: 1, name: 'Essay' }]);
  canvas.getOverdue.mockResolvedValue([{ id: 2, name: 'Missed lab' }]);
  canvas.getGrades.mockResolvedValue([{ id: 3, name: 'Accounting' }]);
  canvas.getAnnouncements.mockResolvedValue([{ id: 4, title: 'Class cancelled' }]);
  canvas.syncNow.mockResolvedValue({});
  calendar.getStatus.mockResolvedValue({ connected: true });
  calendar.getEvents.mockResolvedValue([{ id: 'e1', summary: 'Lecture' }]);
  calendar.syncNow.mockResolvedValue({});
  canvas.onSyncChanged.mockReturnValue(() => {});
  calendar.onSyncChanged.mockReturnValue(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useHome', () => {
  it('loads every source and reports loaded', async () => {
    const { result } = renderHook(() => useHome());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.upcoming).toHaveLength(1);
    expect(result.current.overdue).toHaveLength(1);
    expect(result.current.grades).toHaveLength(1);
    expect(result.current.announcements).toHaveLength(1);
    expect(result.current.events).toHaveLength(1);
  });

  it("asks the calendar for today's date on both ends of the range", async () => {
    const { result } = renderHook(() => useHome());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const [from, to] = calendar.getEvents.mock.calls[0];
    expect(from).toBe(to);
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('still loads Canvas data when the calendar read rejects', async () => {
    // One disconnected account must never blank the whole dashboard.
    calendar.getEvents.mockRejectedValue(new Error('not connected'));
    const { result } = renderHook(() => useHome());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.upcoming).toHaveLength(1);
    expect(result.current.events).toEqual([]);
  });

  it('still loads calendar data when a Canvas read rejects', async () => {
    canvas.getOverdue.mockRejectedValue(new Error('no token'));
    const { result } = renderHook(() => useHome());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.overdue).toEqual([]);
    expect(result.current.events).toHaveLength(1);
  });

  it('refreshes both sources and reloads', async () => {
    const { result } = renderHook(() => useHome());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      await result.current.refresh();
    });
    expect(canvas.syncNow).toHaveBeenCalled();
    expect(calendar.syncNow).toHaveBeenCalled();
    expect(canvas.getUpcoming.mock.calls.length).toBeGreaterThan(1);
  });

  it('completes a refresh even when one sync fails', async () => {
    // A Google outage must not block a Canvas refresh.
    calendar.syncNow.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useHome());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      await result.current.refresh();
    });
    expect(canvas.syncNow).toHaveBeenCalled();
    expect(result.current.refreshing).toBe(false);
  });

  it('subscribes to both sync-changed channels', async () => {
    const { result } = renderHook(() => useHome());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(canvas.onSyncChanged).toHaveBeenCalled();
    expect(calendar.onSyncChanged).toHaveBeenCalled();
  });

  it('keeps the newer load result when an older, slower load resolves after it', async () => {
    // canvas:sync-now / calendar:sync-now broadcast *:sync-changed before
    // syncNow() resolves, so refresh() can have multiple load() calls racing.
    // A slow first load must not clobber a faster, newer second load.
    const { result } = renderHook(() => useHome());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let resolveFirst: (v: unknown[]) => void = () => {};
    const firstCall = new Promise<unknown[]>((resolve) => {
      resolveFirst = resolve;
    });
    canvas.getUpcoming
      .mockImplementationOnce(() => firstCall)
      .mockImplementationOnce(async () => [{ id: 99, name: 'Newer assignment' }]);

    // Kick off the first (slow) load, then start a second (fast) load
    // before the first has resolved.
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

    // Let the second (newer) load finish first, then resolve the stale first
    // load afterward — the out-of-order resolution the finding describes.
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
