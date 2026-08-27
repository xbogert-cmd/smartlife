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
      onPreferenceChange: vi.fn(() => () => {}),
    },
    app: { getVersion: vi.fn().mockResolvedValue('0.1.0') },
    navigation: { onNavigate: vi.fn(() => () => {}) },
    ai: {
      getApiKeyStatus: vi.fn().mockResolvedValue(false),
      setApiKey: vi.fn().mockResolvedValue(undefined),
      hasUsableProvider: vi.fn().mockResolvedValue(false),
      pickAttachment: vi.fn().mockResolvedValue(null),
      createConversation: vi.fn().mockResolvedValue('conv-1'),
      listConversations: vi.fn().mockResolvedValue([]),
      renameConversation: vi.fn().mockResolvedValue(undefined),
      deleteConversation: vi.fn().mockResolvedValue(undefined),
      getMode: vi.fn().mockResolvedValue('ask'),
      setMode: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onStreamEvent: vi.fn(() => () => {}),
      onConfirmRequest: vi.fn(() => () => {}),
      respondToConfirm: vi.fn().mockResolvedValue(undefined),
      getHistory: vi.fn().mockResolvedValue([]),
      getPendingConfirmation: vi.fn().mockResolvedValue(null),
      onConfirmResolved: vi.fn(() => () => {}),
      getCatalog: vi.fn().mockResolvedValue([]),
      getGeminiKeyStatus: vi.fn().mockResolvedValue(false),
      setGeminiKey: vi.fn().mockResolvedValue(undefined),
      clearGeminiKey: vi.fn().mockResolvedValue(undefined),
      getOllamaEndpoint: vi.fn().mockResolvedValue('http://localhost:11434'),
      setOllamaEndpoint: vi.fn().mockResolvedValue(undefined),
      listOllamaModels: vi.fn().mockResolvedValue([]),
      getRanking: vi.fn().mockResolvedValue([]),
      setRanking: vi.fn().mockResolvedValue(undefined),
      getPinnedEntry: vi.fn().mockResolvedValue(null),
      setPinnedEntry: vi.fn().mockResolvedValue(undefined),
      clearPinnedEntry: vi.fn().mockResolvedValue(undefined),
      retryProviderEntry: vi.fn().mockResolvedValue(undefined),
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
      getOverdue: vi.fn().mockResolvedValue([]),
      getGrades: vi.fn().mockResolvedValue([]),
      getAnnouncements: vi.fn().mockResolvedValue([]),
      getCourse: vi.fn().mockResolvedValue(null),
      syncCourse: vi.fn(),
      getPage: vi.fn().mockResolvedValue(null),
      openFile: vi.fn(),
      openExternal: vi.fn(),
      searchMaterials: vi.fn().mockResolvedValue([]),
      onSyncChanged: vi.fn().mockReturnValue(() => {}),
      getAssignment: vi.fn().mockResolvedValue(null),
      saveDraft: vi.fn(),
      clearDraft: vi.fn(),
      pickFile: vi.fn().mockResolvedValue(null),
      submit: vi.fn(),
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

  it('opens the AI dock with Cmd+J as a complementary panel, not a modal', async () => {
    render(<App />);
    await screen.findByText(/good (morning|afternoon|evening)/i);

    await userEvent.keyboard('{Meta>}j{/Meta}');
    expect(await screen.findByRole('complementary', { name: /assistant/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Escape is not a dismissal gesture for a dock -- it's not modal.
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('complementary', { name: /assistant/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /close assistant/i }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: /assistant/i })).not.toBeInTheDocument());
  });

  it('does not suspend the browser view when the assistant opens', async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /ask ai/i }));
    expect(window.smartlife.browser.suspend).not.toHaveBeenCalled();
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
