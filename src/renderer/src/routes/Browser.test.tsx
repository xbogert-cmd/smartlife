import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Browser } from './Browser';
import type { BrowserState } from '../browser/types';

const state: BrowserState = {
  tabs: [
    {
      id: 'tab-1',
      url: 'https://uncw.edu/registrar',
      title: 'Registrar',
      loading: false,
      canGoBack: true,
      canGoForward: false,
      error: null,
    },
    {
      id: 'tab-2',
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

const browserApi = {
  getState: vi.fn(async () => state),
  openTab: vi.fn(async () => 'tab-3'),
  closeTab: vi.fn(async () => {}),
  activateTab: vi.fn(async () => {}),
  navigate: vi.fn(async () => {}),
  goBack: vi.fn(async () => {}),
  goForward: vi.fn(async () => {}),
  reload: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  find: vi.fn(async () => {}),
  stopFind: vi.fn(async () => {}),
  setBounds: vi.fn(async () => {}),
  setRouteActive: vi.fn(async () => {}),
  findHistory: vi.fn(async () => []),
  onStateChanged: vi.fn(() => () => {}),
  onFindResult: vi.fn(() => () => {}),
};

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  (window as unknown as { smartlife: unknown }).smartlife = { browser: browserApi };
});

function renderBrowser() {
  return render(
    <MemoryRouter>
      <Browser />
    </MemoryRouter>
  );
}

describe('Browser route', () => {
  it('lists the open tabs', async () => {
    renderBrowser();
    const tabs = await screen.findByRole('tablist', { name: 'Open tabs' });
    expect(within(tabs).getByRole('tab', { name: /Registrar/ })).toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: /New Tab/ })).toBeInTheDocument();
  });

  it('marks the active tab as selected', async () => {
    renderBrowser();
    const active = await screen.findByRole('tab', { name: /Registrar/ });
    expect(active).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the active tab url in the address bar', async () => {
    renderBrowser();
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue('https://uncw.edu/registrar')
    );
  });

  it('navigates the active tab on submit', async () => {
    const user = userEvent.setup();
    renderBrowser();
    const input = await screen.findByRole('textbox', { name: 'Address' });
    await user.clear(input);
    await user.type(input, 'canvas.uncw.edu{Enter}');
    expect(browserApi.navigate).toHaveBeenCalledWith('tab-1', 'canvas.uncw.edu');
  });

  it('opens a new tab', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await user.click(await screen.findByRole('button', { name: 'New tab' }));
    expect(browserApi.openTab).toHaveBeenCalledWith('about:blank');
  });

  it('closes a tab without activating it', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await user.click(await screen.findByRole('button', { name: 'Close New Tab' }));
    expect(browserApi.closeTab).toHaveBeenCalledWith('tab-2');
    expect(browserApi.activateTab).not.toHaveBeenCalled();
  });

  it('switches tabs on click', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await user.click(await screen.findByRole('tab', { name: /New Tab/ }));
    expect(browserApi.activateTab).toHaveBeenCalledWith('tab-2');
  });

  it('disables forward when there is no forward history', async () => {
    renderBrowser();
    expect(await screen.findByRole('button', { name: 'Forward' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
  });

  it('surfaces a load error instead of leaving the viewport blank', async () => {
    browserApi.getState.mockResolvedValueOnce({
      ...state,
      tabs: [{ ...state.tabs[0], error: { code: -105, description: 'ERR_NAME_NOT_RESOLVED' } }, state.tabs[1]],
    });
    renderBrowser();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('ERR_NAME_NOT_RESOLVED');
    expect(alert).toHaveTextContent('-105');
  });

  it('retries a failed load', async () => {
    browserApi.getState.mockResolvedValueOnce({
      ...state,
      tabs: [{ ...state.tabs[0], error: { code: -105, description: 'ERR_NAME_NOT_RESOLVED' } }, state.tabs[1]],
    });
    const user = userEvent.setup();
    renderBrowser();
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(browserApi.reload).toHaveBeenCalledWith('tab-1');
  });

  it('opens and closes find-in-page', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await user.click(await screen.findByRole('button', { name: 'Find in page' }));
    const find = screen.getByRole('textbox', { name: 'Find in page' });
    await user.type(find, 'tuition');
    expect(browserApi.find).toHaveBeenCalledWith('tab-1', 'tuition');

    await user.click(screen.getByRole('button', { name: 'Close find' }));
    expect(browserApi.stopFind).toHaveBeenCalledWith('tab-1');
  });
});
