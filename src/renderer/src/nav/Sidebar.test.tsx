import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';

function renderSidebar(props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  render(
    <MemoryRouter>
      <Sidebar aiOpen={false} onToggleAi={() => {}} hasPendingConfirmation={false} {...props} />
    </MemoryRouter>
  );
}

describe('Sidebar pending-confirmation badge', () => {
  it('shows no badge when nothing is pending', () => {
    renderSidebar({ hasPendingConfirmation: false });
    expect(screen.queryByTestId('pending-confirmation-badge')).toBeNull();
  });

  it('shows a badge when something is pending and the dock is closed', () => {
    renderSidebar({ hasPendingConfirmation: true, aiOpen: false });
    expect(screen.getByTestId('pending-confirmation-badge')).toBeTruthy();
  });

  it('hides the badge once the dock is open, even if something is still pending', () => {
    renderSidebar({ hasPendingConfirmation: true, aiOpen: true });
    expect(screen.queryByTestId('pending-confirmation-badge')).toBeNull();
  });
});

describe('Sidebar traffic-light clearance', () => {
  it('reserves top padding so the nav list clears the macOS traffic-light buttons', () => {
    renderSidebar();
    const nav = screen.getByRole('navigation');
    expect(nav.style.paddingTop).toBe('44px');
  });
});
