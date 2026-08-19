import { describe, expect, it } from 'vitest';
import { formatDue, formatRelative } from './formatters';

const NOW = new Date('2026-08-18T12:00:00Z');

describe('formatRelative', () => {
  it('reports never for a null timestamp', () => {
    expect(formatRelative(null, NOW)).toBe('never');
  });

  it('reports just now for the last minute', () => {
    expect(formatRelative('2026-08-18T11:59:30Z', NOW)).toBe('just now');
  });

  it('reports whole minutes and hours', () => {
    expect(formatRelative('2026-08-18T11:57:00Z', NOW)).toBe('3 min ago');
    expect(formatRelative('2026-08-18T09:00:00Z', NOW)).toBe('3 hr ago');
  });

  it('reports days beyond 24 hours', () => {
    expect(formatRelative('2026-08-16T12:00:00Z', NOW)).toBe('2 days ago');
  });

  it('uses a singular day', () => {
    expect(formatRelative('2026-08-17T12:00:00Z', NOW)).toBe('1 day ago');
  });
});

describe('formatDue', () => {
  it('flags something due within the hour', () => {
    expect(formatDue('2026-08-18T12:30:00Z', NOW)).toBe('due in 30 min');
  });

  it('flags something due today in hours', () => {
    expect(formatDue('2026-08-18T18:00:00Z', NOW)).toBe('due in 6 hr');
  });

  it('counts whole days further out', () => {
    expect(formatDue('2026-08-21T12:00:00Z', NOW)).toBe('due in 3 days');
  });

  it('marks a past due date as overdue', () => {
    expect(formatDue('2026-08-17T12:00:00Z', NOW)).toBe('overdue');
  });
});
