import { describe, expect, it } from 'vitest';
import { BLANK_TITLE, BLANK_URL, createInitialState, tabReducer, type TabState } from './tabs';

function threeTabs(): TabState {
  let state = createInitialState('t1');
  state = tabReducer(state, { type: 'open', id: 't2', url: 'https://b.test/' });
  state = tabReducer(state, { type: 'open', id: 't3', url: 'https://c.test/' });
  return state;
}

describe('createInitialState', () => {
  it('starts with one blank active tab', () => {
    const state = createInitialState('t1');
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toEqual({
      id: 't1',
      url: BLANK_URL,
      title: BLANK_TITLE,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
    });
    expect(state.activeTabId).toBe('t1');
  });
});

describe('open', () => {
  it('appends the tab and activates it', () => {
    const state = tabReducer(createInitialState('t1'), { type: 'open', id: 't2', url: 'https://b.test/' });
    expect(state.tabs.map((tab) => tab.id)).toEqual(['t1', 't2']);
    expect(state.activeTabId).toBe('t2');
    expect(state.tabs[1].url).toBe('https://b.test/');
  });

  it('can open in the background without stealing focus', () => {
    const state = tabReducer(createInitialState('t1'), {
      type: 'open',
      id: 't2',
      url: 'https://b.test/',
      activate: false,
    });
    expect(state.activeTabId).toBe('t1');
    expect(state.tabs).toHaveLength(2);
  });
});

describe('close', () => {
  it('activates the right neighbour when closing an active non-rightmost tab', () => {
    let start = threeTabs();
    start = tabReducer(start, { type: 'activate', id: 't2' });
    expect(start.activeTabId).toBe('t2');
    const state = tabReducer(start, { type: 'close', id: 't2', blankId: 'blank' });
    expect(state.tabs.map((tab) => tab.id)).toEqual(['t1', 't3']);
    expect(state.activeTabId).toBe('t3');
  });

  it('activates the left neighbour when closing the rightmost tab', () => {
    const state = tabReducer(threeTabs(), { type: 'close', id: 't3', blankId: 'blank' });
    expect(state.tabs.map((tab) => tab.id)).toEqual(['t1', 't2']);
    expect(state.activeTabId).toBe('t2');
  });

  it('leaves the active tab alone when closing a different one', () => {
    const start = threeTabs();
    expect(start.activeTabId).toBe('t3');
    const state = tabReducer(start, { type: 'close', id: 't1', blankId: 'blank' });
    expect(state.activeTabId).toBe('t3');
  });

  it('replaces the last tab with a fresh blank one rather than leaving zero', () => {
    const state = tabReducer(createInitialState('t1'), { type: 'close', id: 't1', blankId: 'blank' });
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].id).toBe('blank');
    expect(state.tabs[0].url).toBe(BLANK_URL);
    expect(state.activeTabId).toBe('blank');
  });
});

describe('navigation lifecycle', () => {
  it('navigate-start sets loading and clears a previous error', () => {
    let state = tabReducer(createInitialState('t1'), {
      type: 'load-failed',
      id: 't1',
      code: -105,
      description: 'NAME_NOT_RESOLVED',
    });
    expect(state.tabs[0].error).not.toBeNull();

    state = tabReducer(state, { type: 'navigate-start', id: 't1' });
    expect(state.tabs[0].loading).toBe(true);
    expect(state.tabs[0].error).toBeNull();
  });

  it('navigate-committed updates the url and the back/forward flags', () => {
    const state = tabReducer(createInitialState('t1'), {
      type: 'navigate-committed',
      id: 't1',
      url: 'https://uncw.edu/',
      canGoBack: true,
      canGoForward: false,
    });
    expect(state.tabs[0].url).toBe('https://uncw.edu/');
    expect(state.tabs[0].canGoBack).toBe(true);
    expect(state.tabs[0].canGoForward).toBe(false);
  });

  it('title updates only the title', () => {
    const state = tabReducer(createInitialState('t1'), { type: 'title', id: 't1', title: 'Registrar' });
    expect(state.tabs[0].title).toBe('Registrar');
    expect(state.tabs[0].url).toBe(BLANK_URL);
  });

  it('load-end clears loading', () => {
    let state = tabReducer(createInitialState('t1'), { type: 'navigate-start', id: 't1' });
    state = tabReducer(state, { type: 'load-end', id: 't1' });
    expect(state.tabs[0].loading).toBe(false);
  });

  it('load-failed records the error and clears loading', () => {
    let state = tabReducer(createInitialState('t1'), { type: 'navigate-start', id: 't1' });
    state = tabReducer(state, { type: 'load-failed', id: 't1', code: -105, description: 'NAME_NOT_RESOLVED' });
    expect(state.tabs[0].loading).toBe(false);
    expect(state.tabs[0].error).toEqual({ code: -105, description: 'NAME_NOT_RESOLVED' });
  });
});

describe('activate', () => {
  it('switches the active tab', () => {
    const state = tabReducer(threeTabs(), { type: 'activate', id: 't1' });
    expect(state.activeTabId).toBe('t1');
  });

  it('ignores an unknown id', () => {
    const start = threeTabs();
    expect(tabReducer(start, { type: 'activate', id: 'nope' })).toBe(start);
  });
});

describe('unknown ids', () => {
  it('leave state untouched rather than throwing', () => {
    const start = threeTabs();
    expect(tabReducer(start, { type: 'navigate-start', id: 'nope' })).toBe(start);
    expect(tabReducer(start, { type: 'title', id: 'nope', title: 'x' })).toBe(start);
    expect(tabReducer(start, { type: 'close', id: 'nope', blankId: 'blank' })).toBe(start);
  });
});
