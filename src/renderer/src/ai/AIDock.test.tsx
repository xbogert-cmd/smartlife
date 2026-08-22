import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AIDock } from './AIDock';

const suspend = vi.fn().mockResolvedValue(undefined);
const resume = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  suspend.mockClear();
  resume.mockClear();
  vi.stubGlobal('window', window);
  (window as unknown as { smartlife: unknown }).smartlife = {
    ai: {
      getApiKeyStatus: vi.fn().mockResolvedValue(true),
      getHistory: vi.fn().mockResolvedValue([]),
      onStreamEvent: vi.fn().mockReturnValue(() => {}),
      onConfirmRequest: vi.fn().mockReturnValue(() => {}),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      respondToConfirm: vi.fn().mockResolvedValue(undefined),
    },
    browser: { suspend, resume },
  };
});

describe('AIDock', () => {
  it('renders as a complementary region, not a modal dialog', () => {
    render(
      <MemoryRouter>
        <AIDock onClose={() => {}} />
      </MemoryRouter>
    );
    expect(screen.getByRole('complementary', { name: /assistant/i })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not suspend the browser view', async () => {
    // A dock shrinks the viewport rather than covering it. Suspending would
    // blank the very page the user is asking about.
    render(
      <MemoryRouter>
        <AIDock onClose={() => {}} />
      </MemoryRouter>
    );
    await Promise.resolve();
    expect(suspend).not.toHaveBeenCalled();
  });

  it('has no full-screen backdrop that would swallow clicks on the page', () => {
    const { container } = render(
      <MemoryRouter>
        <AIDock onClose={() => {}} />
      </MemoryRouter>
    );
    const fixedFullScreen = Array.from(container.querySelectorAll('*')).filter((element) => {
      const style = (element as HTMLElement).style;
      return style.position === 'fixed' && style.inset === '0px';
    });
    expect(fixedFullScreen).toHaveLength(0);
  });
});
