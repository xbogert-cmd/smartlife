import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
