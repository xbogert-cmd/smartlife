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

  it('does not allow a stale getState fetch to clobber a pushed update', async () => {
    // Create a controlled promise for getState
    let resolveGetState: ((value: BrowserState) => void) = () => {};
    const getStatePromise = new Promise<BrowserState>((resolve) => {
      resolveGetState = resolve;
    });
    browserApi.getState.mockReturnValueOnce(getStatePromise);

    const { result } = renderHook(() => useBrowser());

    // Wait for subscription to be set up and render to happen
    await waitFor(() => expect(browserApi.onStateChanged).toHaveBeenCalled());

    // Push a newer update with a different title - this should arrive before getState resolves
    const newState: BrowserState = {
      tabs: [
        {
          id: 'tab-1',
          url: 'https://example.com/',
          title: 'Updated Title',
          loading: false,
          canGoBack: true,
          canGoForward: false,
          error: null,
        },
      ],
      activeTabId: 'tab-1',
    };

    act(() => {
      stateListener?.(newState);
    });

    // Verify the pushed update was applied
    await waitFor(() => expect(result.current.state?.tabs[0].title).toBe('Updated Title'));

    // Now resolve the stale getState promise with old data
    const oldState: BrowserState = {
      tabs: [
        {
          id: 'tab-1',
          url: 'about:blank',
          title: 'Old Title',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          error: null,
        },
      ],
      activeTabId: 'tab-1',
    };

    // Resolve promise outside of act to allow separate update cycle
    resolveGetState(oldState);

    // Give React time to process the promise resolution
    await new Promise(resolve => setTimeout(resolve, 0));

    // The state should still be the newer pushed update, not the stale fetch
    expect(result.current.state?.tabs[0].title).toBe('Updated Title');
    expect(result.current.state?.tabs[0].url).toBe('https://example.com/');
  });
});
