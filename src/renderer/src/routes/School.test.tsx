import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { School } from './School';

const canvas = {
  getStatus: vi.fn(),
  getUpcoming: vi.fn(),
  getGrades: vi.fn(),
  getAnnouncements: vi.fn(),
  syncNow: vi.fn(),
  onSyncChanged: vi.fn().mockReturnValue(() => {}),
};

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tokenConfigured: true,
    baseUrlConfigured: true,
    lastSyncedAt: new Date().toISOString(),
    tokenInvalid: false,
    tokenAgeDays: 2,
    tokenExpiringSoon: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal('window', window);
  Object.defineProperty(window, 'smartlife', { value: { canvas }, writable: true, configurable: true });
  canvas.getStatus.mockResolvedValue(status());
  canvas.getUpcoming.mockResolvedValue([]);
  canvas.getGrades.mockResolvedValue([]);
  canvas.getAnnouncements.mockResolvedValue([]);
});

function renderSchool(): void {
  render(
    <MemoryRouter>
      <School />
    </MemoryRouter>
  );
}

describe('School', () => {
  it('shows the connect prompt while status is still loading', () => {
    renderSchool();
    expect(screen.getByText(/connect canvas/i)).toBeInTheDocument();
  });

  it('shows the connect prompt when no token is configured', async () => {
    canvas.getStatus.mockResolvedValue(status({ tokenConfigured: false }));
    renderSchool();
    expect(await screen.findByText(/connect canvas/i)).toBeInTheDocument();
  });

  it('shows the connect prompt when the base URL is missing', async () => {
    canvas.getStatus.mockResolvedValue(status({ baseUrlConfigured: false }));
    renderSchool();
    expect(await screen.findByText(/connect canvas/i)).toBeInTheDocument();
  });

  it('renders due-soon items once connected', async () => {
    canvas.getUpcoming.mockResolvedValue([
      {
        id: 1,
        courseId: 101,
        courseName: 'Statistics',
        name: 'Problem Set 3',
        dueAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        pointsPossible: 20,
        hasSubmitted: false,
        htmlUrl: null,
      },
    ]);
    renderSchool();

    expect(await screen.findByText('Problem Set 3')).toBeInTheDocument();
    expect(screen.getByText('Statistics')).toBeInTheDocument();
  });

  it('renders course grades', async () => {
    canvas.getGrades.mockResolvedValue([
      { id: 101, name: 'Statistics', courseCode: 'STT 215', currentScore: 91.5, currentGrade: 'A-' },
    ]);
    renderSchool();

    expect(await screen.findByText('STT 215')).toBeInTheDocument();
    expect(screen.getByText('91.5% (A-)')).toBeInTheDocument();
  });

  it('shows the expired-token banner while still listing cached work', async () => {
    canvas.getStatus.mockResolvedValue(status({ tokenInvalid: true }));
    canvas.getGrades.mockResolvedValue([
      { id: 101, name: 'Statistics', courseCode: 'STT 215', currentScore: 91.5, currentGrade: 'A-' },
    ]);
    renderSchool();

    expect(await screen.findByText(/token has expired/i)).toBeInTheDocument();
    expect(screen.getByText('STT 215')).toBeInTheDocument();
  });

  it('warns when the token is close to its 90-day cap', async () => {
    canvas.getStatus.mockResolvedValue(status({ tokenExpiringSoon: true, tokenAgeDays: 85 }));
    renderSchool();
    expect(await screen.findByText(/85 days old/i)).toBeInTheDocument();
  });

  it('says so plainly when nothing is due', async () => {
    renderSchool();
    expect(await screen.findByText(/nothing due in the next two weeks/i)).toBeInTheDocument();
  });
});
