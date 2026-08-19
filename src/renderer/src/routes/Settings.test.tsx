import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
    },
    app: { getVersion: vi.fn().mockResolvedValue('0.1.0') },
    navigation: { onNavigate: vi.fn(() => () => {}) },
    ai: {
      getApiKeyStatus: vi.fn().mockResolvedValue(false),
      setApiKey: vi.fn().mockResolvedValue(undefined),
      getMode: vi.fn().mockResolvedValue('ask'),
      setMode: vi.fn().mockResolvedValue(undefined),
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
  } as unknown as typeof window.smartlife;
});

describe('Settings — API key', () => {
  it('shows not-connected status, saves a key, and shows connected', async () => {
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    );

    // Scoped to "Claude API key" specifically — the Settings page also has a
    // Canvas connection status that renders its own "— not connected" text.
    expect(await screen.findByText(/claude api key.*not connected/i)).toBeInTheDocument();

    // Scoped to the field's own container — the Settings page now also has a
    // Canvas block with its own "Save" button, so a bare getByRole('button',
    // { name: 'Save' }) is ambiguous.
    const apiKeyInput = screen.getByPlaceholderText('sk-ant-...');
    await userEvent.type(apiKeyInput, 'sk-ant-test-123');
    await userEvent.click(within(apiKeyInput.parentElement as HTMLElement).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(window.smartlife.ai.setApiKey).toHaveBeenCalledWith('sk-ant-test-123'));
    expect(await screen.findByText(/— connected/)).toBeInTheDocument();
  });

  it('shows an error message when saving fails', async () => {
    (window.smartlife.ai.setApiKey as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Secure storage is not available on this system.')
    );
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    );

    await screen.findByText(/claude api key.*not connected/i);
    const apiKeyInput = screen.getByPlaceholderText('sk-ant-...');
    await userEvent.type(apiKeyInput, 'sk-ant-test-123');
    await userEvent.click(within(apiKeyInput.parentElement as HTMLElement).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Secure storage is not available on this system.')).toBeInTheDocument();
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

  // The Claude API key block above also has a "Save" button, so Canvas's own
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
