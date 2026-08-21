import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BrowserState, BrowserTab } from './types';

export function useBrowser(): {
  state: BrowserState | null;
  activeTab: BrowserTab | null;
  openTab: (url: string) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  activateTab: (id: string) => Promise<void>;
  navigate: (input: string) => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  reload: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const [state, setState] = useState<BrowserState | null>(null);

  useEffect(() => {
    let superseded = false;

    // Subscribe first to capture any pushed updates that arrive before the fetch
    const unsubscribe = window.smartlife.browser.onStateChanged((newState) => {
      superseded = true;
      setState(newState);
    });

    // Then fetch the initial state, but only apply it if no push has arrived yet
    void window.smartlife.browser.getState().then((initialState) => {
      if (!superseded) {
        setState(initialState);
      }
    }).catch(() => {});

    return unsubscribe;
  }, []);

  // The native view must only be on screen while this route is. Without the
  // cleanup the page would float above every other section.
  useEffect(() => {
    void window.smartlife.browser.setRouteActive(true);
    return () => {
      void window.smartlife.browser.setRouteActive(false);
    };
  }, []);

  const activeTab = useMemo(
    () => state?.tabs.find((tab) => tab.id === state.activeTabId) ?? null,
    [state]
  );

  const activeId = activeTab?.id ?? null;

  const openTab = useCallback(async (url: string) => {
    await window.smartlife.browser.openTab(url);
  }, []);

  const closeTab = useCallback(async (id: string) => {
    await window.smartlife.browser.closeTab(id);
  }, []);

  const activateTab = useCallback(async (id: string) => {
    await window.smartlife.browser.activateTab(id);
  }, []);

  const navigate = useCallback(
    async (input: string) => {
      if (activeId === null) return;
      await window.smartlife.browser.navigate(activeId, input);
    },
    [activeId]
  );

  const goBack = useCallback(async () => {
    if (activeId !== null) await window.smartlife.browser.goBack(activeId);
  }, [activeId]);

  const goForward = useCallback(async () => {
    if (activeId !== null) await window.smartlife.browser.goForward(activeId);
  }, [activeId]);

  const reload = useCallback(async () => {
    if (activeId !== null) await window.smartlife.browser.reload(activeId);
  }, [activeId]);

  const stop = useCallback(async () => {
    if (activeId !== null) await window.smartlife.browser.stop(activeId);
  }, [activeId]);

  return { state, activeTab, openTab, closeTab, activateTab, navigate, goBack, goForward, reload, stop };
}
