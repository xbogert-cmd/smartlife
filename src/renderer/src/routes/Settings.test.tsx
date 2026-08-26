import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '../theme/ThemeProvider';
import { Settings } from './Settings';

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
      getMode: vi.fn().mockResolvedValue('ask'),
      setMode: vi.fn().mockResolvedValue(undefined),
      getPendingConfirmation: vi.fn().mockResolvedValue(null),
      onConfirmResolved: vi.fn(() => () => {}),
      getGeminiKeyStatus: vi.fn().mockResolvedValue(false),
      setGeminiKey: vi.fn().mockResolvedValue(undefined),
      clearGeminiKey: vi.fn().mockResolvedValue(undefined),
      getOllamaEndpoint: vi.fn().mockResolvedValue('http://localhost:11434'),
      setOllamaEndpoint: vi.fn().mockResolvedValue(undefined),
      listOllamaModels: vi.fn().mockResolvedValue([]),
      getCatalog: vi.fn().mockResolvedValue([]),
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
      setBaseUrl: vi.fn().mockResolvedValue(undefined),
      setToken: vi.fn().mockResolvedValue(undefined),
      clearToken: vi.fn().mockResolvedValue(undefined),
      testConnection: vi.fn().mockResolvedValue({ ok: false, error: 'Add both the Canvas URL and an access token first.' }),
    },
    calendar: {
      getStatus: vi.fn().mockResolvedValue({ clientConfigured: false, connected: false, accountEmail: null }),
      listCalendars: vi.fn().mockResolvedValue([]),
      setClientConfig: vi.fn().mockResolvedValue({ ok: true }),
      connect: vi.fn().mockResolvedValue({ ok: true }),
      disconnect: vi.fn().mockResolvedValue({ ok: true }),
      setCalendarEnabled: vi.fn().mockResolvedValue([]),
    },
    browser: { clearData: vi.fn().mockResolvedValue({ ok: true }) },
  } as unknown as typeof window.smartlife;
});

describe('Settings — AI Providers', () => {
  it('renders the AI Providers settings region', async () => {
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    );
    expect(await screen.findByRole('region', { name: 'AI Providers settings' })).toBeInTheDocument();
  });
});

describe('Settings — Canvas', () => {
  beforeEach(async () => {
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    );
    // ThemeProvider renders null until its async theme.get() resolves, so wait
    // for the real tree to mount before tests issue synchronous queries.
    await screen.findByRole('heading', { name: 'Settings' });
  });

  // The AI Providers section above also has "Save" buttons, so Canvas's own
  // Save/Test-connection controls are queried scoped to this labeled region
  // rather than via bare screen.getByRole, which would be ambiguous.
  function canvasRegion(): HTMLElement {
    return screen.getByRole('region', { name: 'Canvas settings' });
  }

  it('shows not connected when no token is stored', async () => {
    expect(await screen.findByText(/canvas — not connected/i)).toBeInTheDocument();
  });

  it('saves the URL and token together', async () => {
    const region = canvasRegion();
    await userEvent.type(within(region).getByLabelText('Canvas URL'), 'uncw.instructure.com');
    await userEvent.type(within(region).getByLabelText('Canvas access token'), 'canvas-secret');
    await userEvent.click(within(region).getByRole('button', { name: 'Save' }));

    expect(window.smartlife.canvas.setBaseUrl).toHaveBeenCalledWith('uncw.instructure.com');
    expect(window.smartlife.canvas.setToken).toHaveBeenCalledWith('canvas-secret');
  });

  it('reports the account name on a successful connection test', async () => {
    vi.mocked(window.smartlife.canvas.testConnection).mockResolvedValue({ ok: true, name: 'Alexander B' });
    await userEvent.click(within(canvasRegion()).getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/connected as alexander b/i)).toBeInTheDocument();
  });

  it('reports the failure reason when the connection test fails', async () => {
    vi.mocked(window.smartlife.canvas.testConnection).mockResolvedValue({
      ok: false,
      error: 'Canvas rejected the access token.',
    });
    await userEvent.click(within(canvasRegion()).getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/canvas rejected the access token/i)).toBeInTheDocument();
  });
});

describe('Settings — Google Calendar', () => {
  function region(): HTMLElement {
    return screen.getByRole('region', { name: 'Google Calendar settings' });
  }

  it('saves the client credentials', async () => {
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    );
    await screen.findByRole('heading', { name: 'Settings' });

    fireEvent.change(screen.getByLabelText('Google Client ID'), { target: { value: 'id-1' } });
    fireEvent.change(screen.getByLabelText('Google Client Secret'), { target: { value: 'secret-1' } });
    fireEvent.click(within(region()).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(window.smartlife.calendar.setClientConfig).toHaveBeenCalledWith('id-1', 'secret-1')
    );
  });

  it('clears the secret field after saving', async () => {
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    );
    await screen.findByRole('heading', { name: 'Settings' });

    fireEvent.change(screen.getByLabelText('Google Client ID'), { target: { value: 'id-1' } });
    fireEvent.change(screen.getByLabelText('Google Client Secret'), { target: { value: 'secret-1' } });
    fireEvent.click(within(region()).getByRole('button', { name: 'Save' }));

    // Leaving a secret sitting in a visible form field is careless even when
    // it is not strictly confidential.
    await waitFor(() => expect(screen.getByLabelText('Google Client Secret')).toHaveValue(''));
  });

  it('surfaces a connect failure instead of claiming success', async () => {
    vi.mocked(window.smartlife.calendar.connect).mockResolvedValue({
      ok: false,
      error: 'Google did not return a refresh token.',
    } as never);
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    );
    await screen.findByRole('heading', { name: 'Settings' });

    fireEvent.click(within(region()).getByRole('button', { name: 'Connect' }));

    expect(await within(region()).findByRole('alert')).toHaveTextContent(/refresh token/i);
  });
});

describe('Browser settings', () => {
  it('renders its own region', async () => {
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    );
    expect(await screen.findByRole('region', { name: 'Browser settings' })).toBeInTheDocument();
  });

  it('asks for confirmation before clearing', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    );
    await user.click(await screen.findByRole('button', { name: 'Clear browsing data' }));
    expect(window.smartlife.browser.clearData).not.toHaveBeenCalled();
    expect(screen.getByText(/cookies, and cached files/i)).toBeInTheDocument();
  });

  it('clears once confirmed', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    );
    await user.click(await screen.findByRole('button', { name: 'Clear browsing data' }));
    await user.click(screen.getByRole('button', { name: 'Yes, clear it' }));
    expect(window.smartlife.browser.clearData).toHaveBeenCalledOnce();
  });

  it('can be backed out of', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    );
    await user.click(await screen.findByRole('button', { name: 'Clear browsing data' }));
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(window.smartlife.browser.clearData).not.toHaveBeenCalled();
  });
});
