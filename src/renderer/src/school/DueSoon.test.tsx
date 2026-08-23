import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DueSoon } from './DueSoon';
import type { UpcomingAssignment } from './types';

const items: UpcomingAssignment[] = [
  {
    id: 1,
    courseId: 1,
    courseName: 'Arabic',
    name: 'Vocabulary quiz',
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    pointsPossible: 10,
    hasSubmitted: false,
    htmlUrl: null,
  },
];

describe('DueSoon', () => {
  it('defaults to the School heading and empty text', () => {
    const { rerender } = render(<DueSoon items={items} />);
    expect(screen.getByText('Due soon')).toBeTruthy();
    rerender(<DueSoon items={[]} />);
    expect(screen.getByText(/next two weeks/i)).toBeTruthy();
  });

  it('accepts an overriding title and empty text', () => {
    const { rerender } = render(<DueSoon items={items} title="Next 7 days" emptyText="Clear week." />);
    expect(screen.getByText('Next 7 days')).toBeTruthy();
    rerender(<DueSoon items={[]} title="Next 7 days" emptyText="Clear week." />);
    expect(screen.getByText('Clear week.')).toBeTruthy();
  });

  it('still renders the assignment name and course', () => {
    render(<DueSoon items={items} />);
    expect(screen.getByText('Vocabulary quiz')).toBeTruthy();
    expect(screen.getByText('Arabic')).toBeTruthy();
  });
});
