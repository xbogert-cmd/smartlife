export const BLANK_URL = 'about:blank';
export const BLANK_TITLE = 'New Tab';

export interface TabError {
  code: number;
  description: string;
}

export interface Tab {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: TabError | null;
}

export interface TabState {
  tabs: Tab[];
  activeTabId: string;
}

export type TabAction =
  | { type: 'open'; id: string; url: string; activate?: boolean }
  | { type: 'close'; id: string; blankId: string }
  | { type: 'activate'; id: string }
  | { type: 'navigate-start'; id: string }
  | { type: 'navigate-committed'; id: string; url: string; canGoBack: boolean; canGoForward: boolean }
  | { type: 'title'; id: string; title: string }
  | { type: 'load-end'; id: string }
  | { type: 'load-failed'; id: string; code: number; description: string };

function blankTab(id: string): Tab {
  return {
    id,
    url: BLANK_URL,
    title: BLANK_TITLE,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
  };
}

export function createInitialState(id: string): TabState {
  return { tabs: [blankTab(id)], activeTabId: id };
}

/** Returns the same array identity when nothing matched, so callers can skip work. */
function patch(state: TabState, id: string, change: Partial<Tab>): TabState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return state;
  const tabs = state.tabs.slice();
  tabs[index] = { ...tabs[index], ...change };
  return { ...state, tabs };
}

export function tabReducer(state: TabState, action: TabAction): TabState {
  switch (action.type) {
    case 'open': {
      const tab: Tab = { ...blankTab(action.id), url: action.url, title: action.url };
      const tabs = [...state.tabs, tab];
      const activate = action.activate !== false;
      return { tabs, activeTabId: activate ? action.id : state.activeTabId };
    }

    case 'close': {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      if (index === -1) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);

      // Never leave zero tabs. A "no tabs" state would need its own empty
      // view, its own address-bar behaviour, and its own focus rules; a fresh
      // blank tab removes all of that.
      if (tabs.length === 0) {
        const replacement = blankTab(action.blankId);
        return { tabs: [replacement], activeTabId: replacement.id };
      }

      if (state.activeTabId !== action.id) return { ...state, tabs };

      // Prefer the tab that slid into the closed one's position (its right
      // neighbour); fall back to the left when the rightmost was closed.
      const nextIndex = Math.min(index, tabs.length - 1);
      return { tabs, activeTabId: tabs[nextIndex].id };
    }

    case 'activate':
      return state.tabs.some((tab) => tab.id === action.id)
        ? { ...state, activeTabId: action.id }
        : state;

    case 'navigate-start':
      return patch(state, action.id, { loading: true, error: null });

    case 'navigate-committed':
      return patch(state, action.id, {
        url: action.url,
        canGoBack: action.canGoBack,
        canGoForward: action.canGoForward,
      });

    case 'title':
      return patch(state, action.id, { title: action.title });

    case 'load-end':
      return patch(state, action.id, { loading: false });

    case 'load-failed':
      return patch(state, action.id, {
        loading: false,
        error: { code: action.code, description: action.description },
      });
  }
}
