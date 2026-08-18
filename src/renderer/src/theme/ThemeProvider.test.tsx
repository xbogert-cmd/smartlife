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
