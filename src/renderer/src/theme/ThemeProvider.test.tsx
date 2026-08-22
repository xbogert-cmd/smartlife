import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, useTheme } from './ThemeProvider';

function Probe() {
  const { resolved } = useTheme();
  return <div data-testid="resolved">{resolved}</div>;
}

function mockSmartlife(getValue: 'light' | 'dark' | 'system' = 'dark') {
  const listeners: Array<(isDark: boolean) => void> = [];
  (window as unknown as { smartlife: typeof window.smartlife }).smartlife = {
    theme: {
      get: vi.fn().mockResolvedValue(getValue),
      set: vi.fn().mockResolvedValue(undefined),
      onSystemChange: vi.fn((cb: (isDark: boolean) => void) => {
        listeners.push(cb);
        return () => {};
      }),
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
      suspend: vi.fn(),
      resume: vi.fn(),
      findHistory: vi.fn().mockResolvedValue([]),
      clearData: vi.fn(),
      respondToDownload: vi.fn(),
      onStateChanged: vi.fn(() => () => {}),
      onDownloadRequest: vi.fn(() => () => {}),
      onFindResult: vi.fn(() => () => {}),
    },
  };
  return listeners;
}

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
});

describe('ThemeProvider', () => {
  it('applies the persisted preference to <html data-theme>', async () => {
    mockSmartlife('dark');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );

    await waitFor(() => expect(screen.getByTestId('resolved').textContent).toBe('dark'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('resolves "system" using the live system-change callback', async () => {
    const listeners = mockSmartlife('system');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );

    await waitFor(() => expect(screen.getByTestId('resolved').textContent).toBe('light'));

    listeners[0](true);

    await waitFor(() => expect(screen.getByTestId('resolved').textContent).toBe('dark'));
  });
});
