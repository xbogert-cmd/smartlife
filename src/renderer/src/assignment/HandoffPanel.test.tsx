import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { HandoffPanel } from './HandoffPanel';

const openTab = vi.fn().mockResolvedValue('t1');
const activateTab = vi.fn().mockResolvedValue(undefined);
const getState = vi.fn().mockResolvedValue({ tabs: [], activeTabId: null });

beforeEach(() => {
  openTab.mockClear();
  activateTab.mockClear();
  getState.mockReset();
  getState.mockResolvedValue({ tabs: [], activeTabId: null });
  (window as unknown as { smartlife: unknown }).smartlife = {
    browser: {
      openTab,
      activateTab,
      getState,
      onStateChanged: vi.fn().mockReturnValue(() => {}),
      setBounds: vi.fn().mockResolvedValue(undefined),
      setRouteActive: vi.fn().mockResolvedValue(undefined),
    },
  };
});

describe('HandoffPanel', () => {
  it('opens the Canvas assignment URL, not the tool domain', async () => {
    // LTI needs Canvas's signed launch; the tool's own URL would be logged out.
    render(<HandoffPanel htmlUrl="https://uncw.instructure.com/courses/1/assignments/10" reason="external_tool" />);
    await waitFor(() =>
      expect(openTab).toHaveBeenCalledWith('https://uncw.instructure.com/courses/1/assignments/10')
    );
  });

  it('opens the tab exactly once', async () => {
    render(<HandoffPanel htmlUrl="https://uncw.instructure.com/courses/1/assignments/10" reason="external_tool" />);
    await waitFor(() => expect(openTab).toHaveBeenCalled());
    expect(openTab).toHaveBeenCalledTimes(1);
  });

  it('explains why an external tool cannot be submitted from here', async () => {
    render(<HandoffPanel htmlUrl="https://x/1" reason="external_tool" />);
    expect(screen.getByText(/complete it here/i)).toBeTruthy();
  });

  it('explains a quiz differently from an external tool', async () => {
    render(<HandoffPanel htmlUrl="https://x/1" reason="quiz" />);
    expect(screen.getByText(/quiz/i)).toBeTruthy();
  });

  it('explains an unsynced discussion topic', async () => {
    render(<HandoffPanel htmlUrl="https://x/1" reason="unresolved_discussion" />);
    expect(screen.getByText(/discussion/i)).toBeTruthy();
  });

  it('does not open a tab when the assignment has no URL', async () => {
    render(<HandoffPanel htmlUrl={null} reason="external_tool" />);
    await waitFor(() => expect(screen.getByText(/no link/i)).toBeTruthy());
    expect(openTab).not.toHaveBeenCalled();
  });
});

describe('HandoffPanel — reusing a tab across remounts', () => {
  it('activates the existing tab instead of opening a duplicate when the assignment is revisited', async () => {
    const url = 'https://uncw.instructure.com/courses/1/assignments/reuse-1';
    openTab.mockResolvedValueOnce('reuse-tab-1');

    // First visit: opens a fresh tab.
    const first = render(<HandoffPanel htmlUrl={url} reason="external_tool" />);
    await waitFor(() => expect(openTab).toHaveBeenCalledTimes(1));
    first.unmount();

    // Navigate away and back is a fresh HandoffPanel instance -- the tab
    // is still open (reported by getState), so it must be reused, not
    // reopened as a duplicate.
    getState.mockResolvedValue({ tabs: [{ id: 'reuse-tab-1' }], activeTabId: 'reuse-tab-1' });
    render(<HandoffPanel htmlUrl={url} reason="external_tool" />);

    await waitFor(() => expect(activateTab).toHaveBeenCalledWith('reuse-tab-1'));
    expect(openTab).toHaveBeenCalledTimes(1);
  });

  it('opens a fresh tab if the previously-opened one was closed by the user', async () => {
    const url = 'https://uncw.instructure.com/courses/1/assignments/reuse-2';
    openTab.mockResolvedValueOnce('reuse-tab-2');

    const first = render(<HandoffPanel htmlUrl={url} reason="external_tool" />);
    await waitFor(() => expect(openTab).toHaveBeenCalledTimes(1));
    first.unmount();

    // The tab from the first visit is gone from state -- the user closed it.
    getState.mockResolvedValue({ tabs: [], activeTabId: null });
    openTab.mockResolvedValueOnce('reuse-tab-2b');
    render(<HandoffPanel htmlUrl={url} reason="external_tool" />);

    await waitFor(() => expect(openTab).toHaveBeenCalledTimes(2));
    expect(activateTab).not.toHaveBeenCalled();
  });

  it('reuses the tab even after Canvas navigates it away from the original assignment URL', async () => {
    // The reuse check is keyed by tab id, not by the tab's current url --
    // Canvas's own LTI launch navigates the tab to the tool's domain, so
    // matching on url would miss it entirely.
    const url = 'https://uncw.instructure.com/courses/1/assignments/reuse-3';
    openTab.mockResolvedValueOnce('reuse-tab-3');

    const first = render(<HandoffPanel htmlUrl={url} reason="external_tool" />);
    await waitFor(() => expect(openTab).toHaveBeenCalledTimes(1));
    first.unmount();

    getState.mockResolvedValue({
      tabs: [{ id: 'reuse-tab-3', url: 'https://connect.mheducation.com/some/tool/path' }],
      activeTabId: 'reuse-tab-3',
    });
    render(<HandoffPanel htmlUrl={url} reason="external_tool" />);

    await waitFor(() => expect(activateTab).toHaveBeenCalledWith('reuse-tab-3'));
    expect(openTab).toHaveBeenCalledTimes(1);
  });
});
