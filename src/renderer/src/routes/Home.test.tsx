import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { greeting, formatToday, Home } from './Home';

const canvas = {
  getStatus: vi.fn(),
  getUpcoming: vi.fn(),
  getOverdue: vi.fn(),
  getGrades: vi.fn(),
  getAnnouncements: vi.fn(),
  syncNow: vi.fn(),
  onSyncChanged: vi.fn(() => () => {}),
};
const calendar = {
  getStatus: vi.fn(),
  getEvents: vi.fn(),
  syncNow: vi.fn(),
  onSyncChanged: vi.fn(() => () => {}),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'smartlife', {
    value: { canvas, calendar },
    writable: true,
    configurable: true,
  });
  canvas.getStatus.mockResolvedValue({
    tokenConfigured: true,
    baseUrlConfigured: true,
    lastSyncedAt: new Date().toISOString(),
    tokenInvalid: false,
    tokenAgeDays: 1,
    tokenExpiringSoon: false,
  });
  canvas.getUpcoming.mockResolvedValue([]);
  canvas.getOverdue.mockResolvedValue([]);
  canvas.getGrades.mockResolvedValue([
    { id: 1, name: 'Financial Accounting', courseCode: 'ACCT 101', currentScore: 95, currentGrade: 'A' },
  ]);
  canvas.getAnnouncements.mockResolvedValue([
    { id: 1, courseId: 1, courseName: 'Financial Accounting', title: 'Class cancelled', message: null, postedAt: new Date().toISOString() },
  ]);
  canvas.syncNow.mockResolvedValue({});
  canvas.onSyncChanged.mockReturnValue(() => {});
  calendar.getStatus.mockResolvedValue({
    connected: true,
    clientConfigured: true,
    accountEmail: 'me@example.com',
    lastSyncedAt: new Date().toISOString(),
    tokenInvalid: false,
  });
  calendar.getEvents.mockResolvedValue([]);
  calendar.syncNow.mockResolvedValue({});
  calendar.onSyncChanged.mockReturnValue(() => {});
});

describe('greeting', () => {
  it('says good morning before noon', () => {
    expect(greeting(9)).toBe('Good morning');
  });

  it('says good afternoon from noon to before 6pm', () => {
    expect(greeting(12)).toBe('Good afternoon');
    expect(greeting(17)).toBe('Good afternoon');
  });

  it('says good evening from 6pm', () => {
    expect(greeting(18)).toBe('Good evening');
    expect(greeting(23)).toBe('Good evening');
  });
});

describe('formatToday', () => {
  it('formats a date as weekday, month, and day', () => {
    expect(formatToday(new Date(2026, 7, 22))).toBe('Saturday, August 22');
  });

  it('formats a different date correctly', () => {
    expect(formatToday(new Date(2026, 0, 1))).toBe('Thursday, January 1');
  });
});

describe('Home route', () => {
  function renderHome() {
    return render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );
  }

  it('prompts for Settings when neither source is connected', async () => {
    canvas.getStatus.mockResolvedValue({ tokenConfigured: false, baseUrlConfigured: false });
    calendar.getStatus.mockResolvedValue({ connected: false });
    renderHome();
    expect(await screen.findByRole('button', { name: /settings/i })).toBeTruthy();
  });

  it('does not render dashboard sections when nothing is connected', async () => {
    canvas.getStatus.mockResolvedValue({ tokenConfigured: false, baseUrlConfigured: false });
    calendar.getStatus.mockResolvedValue({ connected: false });
    renderHome();
    await screen.findByRole('button', { name: /settings/i });
    expect(screen.queryByText('Today')).toBeNull();
  });

  it('renders the Today agenda when a source is connected', async () => {
    renderHome();
    expect(await screen.findByText('Today')).toBeTruthy();
  });

  it('shows past-due work when there is any', async () => {
    canvas.getOverdue.mockResolvedValue([
      {
        id: 10,
        courseId: 1,
        courseName: 'Accounting',
        name: 'Missed lab',
        dueAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        pointsPossible: 20,
        hasSubmitted: false,
        htmlUrl: null,
      },
    ]);
    renderHome();
    expect(await screen.findByText('Missed lab')).toBeTruthy();
  });

  it('omits the needs-attention heading when nothing is past due', async () => {
    canvas.getOverdue.mockResolvedValue([]);
    renderHome();
    await screen.findByText('Today');
    expect(screen.queryByText(/needs attention/i)).toBeNull();
  });

  it('renders courses and announcements', async () => {
    renderHome();
    expect(await screen.findByText('Courses')).toBeTruthy();
    expect(screen.getByText('Announcements')).toBeTruthy();
  });

  it('offers to connect the calendar when only Canvas is connected', async () => {
    calendar.getStatus.mockResolvedValue({ connected: false });
    renderHome();
    await screen.findByText('Today');
    expect(screen.getByText(/connect google calendar/i)).toBeTruthy();
  });

  it('shows an assignment due earlier today in the Today agenda', async () => {
    const dueEarlierToday = new Date();
    dueEarlierToday.setHours(dueEarlierToday.getHours() - 3, 0, 0, 0);
    canvas.getOverdue.mockResolvedValue([
      {
        id: 20,
        courseId: 1,
        courseName: 'Accounting',
        name: 'Morning problem set',
        dueAt: dueEarlierToday.toISOString(),
        pointsPossible: 10,
        hasSubmitted: false,
        htmlUrl: null,
      },
    ]);
    renderHome();
    const todayHeading = await screen.findByText('Today');
    const todaySection = todayHeading.closest('section');
    if (!todaySection) throw new Error('Today section not found');
    // The item is unsubmitted and past due, so it legitimately also shows
    // up in Needs Attention -- scope the assertion to the Today section
    // itself rather than asserting the text appears anywhere on the page.
    expect(within(todaySection).getByText('Morning problem set')).toBeTruthy();
  });

  it('omits empty Canvas sections instead of stacking empty states', async () => {
    canvas.getUpcoming.mockResolvedValue([]);
    canvas.getOverdue.mockResolvedValue([]);
    canvas.getGrades.mockResolvedValue([]);
    canvas.getAnnouncements.mockResolvedValue([]);
    renderHome();
    await screen.findByText('Nothing scheduled today.');
    expect(screen.queryByText('No courses synced yet.')).toBeNull();
    expect(screen.queryByText('No recent announcements.')).toBeNull();
    expect(screen.queryByText('Nothing due in the next week.')).toBeNull();
  });

  it('refreshes both sources from the header control', async () => {
    renderHome();
    const button = await screen.findByRole('button', { name: /refresh/i });
    await userEvent.click(button);
    await waitFor(() => expect(canvas.syncNow).toHaveBeenCalled());
    expect(calendar.syncNow).toHaveBeenCalled();
  });
});
