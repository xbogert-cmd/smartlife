import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  (window as unknown as { smartlife: typeof window.smartlife }).smartlife = {
    theme: {
      get: vi.fn().mockResolvedValue('light'),
      set: vi.fn().mockResolvedValue(undefined),
      onSystemChange: vi.fn(() => () => {}),
    },
    app: { getVersion: vi.fn().mockResolvedValue('0.1.0') },
    navigation: { onNavigate: vi.fn(() => () => {}) },
    ai: {
      getApiKeyStatus: vi.fn().mockResolvedValue(false),
      setApiKey: vi.fn().mockResolvedValue(undefined),
      getMode: vi.fn().mockResolvedValue('ask'),
      setMode: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onStreamEvent: vi.fn(() => () => {}),
      onConfirmRequest: vi.fn(() => () => {}),
      respondToConfirm: vi.fn().mockResolvedValue(undefined),
      getHistory: vi.fn().mockResolvedValue([]),
    },
    canvas: {
      getStatus: vi.fn().mockResolvedValue({
        tokenConfigured: false,
        baseUrlConfigured: false,
        lastSyncedAt: null,
        tokenInvalid: false,
        tokenAgeDays: null,
        tokenExpiringSoon: false,
      }),
      setBaseUrl: vi.fn(),
      setToken: vi.fn(),
      clearToken: vi.fn(),
      testConnection: vi.fn(),
      syncNow: vi.fn(),
      getUpcoming: vi.fn().mockResolvedValue([]),
      getGrades: vi.fn().mockResolvedValue([]),
      getAnnouncements: vi.fn().mockResolvedValue([]),
      getCourse: vi.fn().mockResolvedValue(null),
      syncCourse: vi.fn(),
      getPage: vi.fn().mockResolvedValue(null),
      openFile: vi.fn(),
      openExternal: vi.fn(),
      searchMaterials: vi.fn().mockResolvedValue([]),
      onSyncChanged: vi.fn().mockReturnValue(() => {}),
    },
    calendar: {
      getStatus: vi.fn().mockResolvedValue({
        clientConfigured: false,
        connected: false,
        accountEmail: null,
        lastSyncedAt: null,
        tokenInvalid: false,
      }),
      setClientConfig: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      syncNow: vi.fn(),
      listCalendars: vi.fn().mockResolvedValue([]),
      setCalendarEnabled: vi.fn().mockResolvedValue([]),
      getEvents: vi.fn().mockResolvedValue([]),
      getAssignments: vi.fn().mockResolvedValue([]),
      createEvent: vi.fn(),
      updateEvent: vi.fn(),
      deleteEvent: vi.fn(),
      onSyncChanged: vi.fn().mockReturnValue(() => {}),
    },
    browser: {
      getState: vi.fn(),
      openTab: vi.fn(),
      closeTab: vi.fn(),
      activateTab: vi.fn(),
      navigate: vi.fn(),
      goBack: vi.fn(),
      goForward: vi.fn(),
      reload: vi.fn(),
      stop: vi.fn(),
      find: vi.fn(),
      stopFind: vi.fn(),
      setBounds: vi.fn(),
      setRouteActive: vi.fn(),
      suspend: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
      findHistory: vi.fn().mockResolvedValue([]),
      clearData: vi.fn(),
      respondToDownload: vi.fn(),
      onStateChanged: vi.fn(() => () => {}),
      onDownloadRequest: vi.fn(() => () => {}),
      onFindResult: vi.fn(() => () => {}),
    },
  };
});

describe('App', () => {
  it('shows Home by default and navigates to a placeholder section', async () => {
    render(<App />);

    expect(await screen.findByText(/good (morning|afternoon|evening)/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: 'Tasks' }));

    expect(await screen.findByText('Coming in a later phase.')).toBeInTheDocument();
  });

  it('navigates to Settings and can change the theme preference', async () => {
    render(<App />);

    await userEvent.click(await screen.findByRole('link', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'dark' }));

    expect(window.smartlife.theme.set).toHaveBeenCalledWith('dark');
  });

  it('opens the AI overlay with Cmd+J and closes it with Escape', async () => {
    render(<App />);
    await screen.findByText(/good (morning|afternoon|evening)/i);

    await userEvent.keyboard('{Meta>}j{/Meta}');
    expect(await screen.findByRole('dialog', { name: 'Ask AI' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask AI' })).not.toBeInTheDocument());
  });

  it('opens the command palette with Cmd+K and jumps to a section', async () => {
    render(<App />);
    await screen.findByText(/good (morning|afternoon|evening)/i);

    await userEvent.keyboard('{Meta>}k{/Meta}');
    const input = await screen.findByPlaceholderText('Type a command…');
    await userEvent.type(input, 'Tasks');
    await userEvent.click(screen.getByRole('button', { name: 'Go to Tasks' }));

    expect(await screen.findByText('Coming in a later phase.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
  });
});
