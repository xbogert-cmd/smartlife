import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useBrowser } from './useBrowser';
import type { BrowserState } from './types';

const initialState: BrowserState = {
  tabs: [
    {
      id: 'tab-1',
      url: 'about:blank',
      title: 'New Tab',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
    },
  ],
  activeTabId: 'tab-1',
};

let stateListener: ((state: BrowserState) => void) | null = null;
const unsubscribe = vi.fn();
const browserApi = {
  getState: vi.fn(async () => initialState),
  openTab: vi.fn(async () => 'tab-2'),
  closeTab: vi.fn(async () => {}),
  activateTab: vi.fn(async () => {}),
  navigate: vi.fn(async () => {}),
  goBack: vi.fn(async () => {}),
  goForward: vi.fn(async () => {}),
  reload: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  setRouteActive: vi.fn(async () => {}),
  onStateChanged: vi.fn((cb: (state: BrowserState) => void) => {
    stateListener = cb;
    return unsubscribe;
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  stateListener = null;
  (window as unknown as { smartlife: unknown }).smartlife = { browser: browserApi };
});

describe('useBrowser', () => {
  it('loads the initial state', async () => {
    const { result } = renderHook(() => useBrowser());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    expect(result.current.activeTab?.id).toBe('tab-1');
  });

  it('marks the browser route active on mount and inactive on unmount', async () => {
    const { unmount } = renderHook(() => useBrowser());
    await waitFor(() => expect(browserApi.setRouteActive).toHaveBeenCalledWith(true));
    unmount();
    expect(browserApi.setRouteActive).toHaveBeenLastCalledWith(false);
  });

  it('applies pushed state updates', async () => {
    const { result } = renderHook(() => useBrowser());
    await waitFor(() => expect(result.current.state).not.toBeNull());

    act(() => {
      stateListener?.({
        tabs: [{ ...initialState.tabs[0], title: 'Registrar', url: 'https://uncw.edu/' }],
        activeTabId: 'tab-1',
      });
    });

    expect(result.current.activeTab?.title).toBe('Registrar');
  });

  it('unsubscribes on unmount', async () => {
    const { unmount } = renderHook(() => useBrowser());
    await waitFor(() => expect(browserApi.onStateChanged).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('navigates the active tab without the caller knowing its id', async () => {
    const { result } = renderHook(() => useBrowser());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    await act(async () => {
      await result.current.navigate('uncw.edu');
    });
    expect(browserApi.navigate).toHaveBeenCalledWith('tab-1', 'uncw.edu');
  });

  it('exposes null activeTab when the active id is missing', async () => {
    browserApi.getState.mockResolvedValueOnce({ tabs: [], activeTabId: 'gone' });
    const { result } = renderHook(() => useBrowser());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    expect(result.current.activeTab).toBeNull();
  });
});
