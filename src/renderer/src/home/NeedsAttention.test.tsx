import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NeedsAttention } from './NeedsAttention';
import type { UpcomingAssignment } from '../school/types';

function overdue(id: number, name: string): UpcomingAssignment {
  return {
    id,
    courseId: 1,
    courseName: 'Financial Accounting',
    name,
    dueAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    pointsPossible: 20,
    hasSubmitted: false,
    htmlUrl: null,
  };
}

function renderSection(items: UpcomingAssignment[]) {
  return render(
    <MemoryRouter>
      <NeedsAttention items={items} />
    </MemoryRouter>
  );
}

describe('NeedsAttention', () => {
  it('renders each past-due assignment with its course', () => {
    renderSection([overdue(10, 'Missed lab')]);
    expect(screen.getByText('Missed lab')).toBeTruthy();
    expect(screen.getByText(/Financial Accounting/)).toBeTruthy();
  });

  it('links each item to its assignment workspace', () => {
    renderSection([overdue(10, 'Missed lab')]);
    expect(screen.getByRole('link', { name: /Missed lab/ }).getAttribute('href')).toBe('/assignment/10');
  });

  it('says how late each item is', () => {
    renderSection([overdue(10, 'Missed lab')]);
    expect(screen.getByText(/overdue/i)).toBeTruthy();
  });

  it('marks a critically-overdue item with data-severity="critical" and a longer-overdue item as "moderate"', () => {
    const critical: UpcomingAssignment = { ...overdue(10, 'Missed lab'), dueAt: new Date(Date.now() - 3 * 3_600_000).toISOString() };
    const moderate: UpcomingAssignment = { ...overdue(11, 'Old assignment'), dueAt: new Date(Date.now() - 5 * 86_400_000).toISOString() };
    renderSection([critical, moderate]);
    expect(screen.getByRole('link', { name: /Missed lab/ }).getAttribute('data-severity')).toBe('critical');
    expect(screen.getByRole('link', { name: /Old assignment/ }).getAttribute('data-severity')).toBe('moderate');
  });

  it('renders nothing at all when there is nothing past due', () => {
    // An empty state here would be a daily false alarm about nothing.
    const { container } = renderSection([]);
    expect(container.textContent).toBe('');
  });
});
