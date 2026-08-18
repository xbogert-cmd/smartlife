import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  } as unknown as typeof window.smartlife;
});

describe('Settings — API key', () => {
  it('shows not-connected status, saves a key, and shows connected', async () => {
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>
    );

    expect(await screen.findByText(/not connected/)).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('sk-ant-...'), 'sk-ant-test-123');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

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

    await screen.findByText(/not connected/);
    await userEvent.type(screen.getByPlaceholderText('sk-ant-...'), 'sk-ant-test-123');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Secure storage is not available on this system.')).toBeInTheDocument();
  });
});
