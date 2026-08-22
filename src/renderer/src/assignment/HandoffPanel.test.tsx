import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { HandoffPanel } from './HandoffPanel';

const openTab = vi.fn().mockResolvedValue('t1');

beforeEach(() => {
  openTab.mockClear();
  (window as unknown as { smartlife: unknown }).smartlife = {
    browser: {
      openTab,
      getState: vi.fn().mockResolvedValue({ tabs: [], activeTabId: null }),
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
