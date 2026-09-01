import { describe, expect, it } from 'vitest';
import { formatDue, formatRelative, overdueSeverity } from './formatters';

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

  it('flags something overdue by minutes', () => {
    expect(formatDue('2026-08-18T11:55:00Z', NOW)).toBe('5 min overdue');
  });

  it('flags something overdue by hours', () => {
    expect(formatDue('2026-08-18T09:00:00Z', NOW)).toBe('3 hr overdue');
  });

  it('uses a singular day when overdue by exactly one day', () => {
    expect(formatDue('2026-08-17T12:00:00Z', NOW)).toBe('1 day overdue');
  });

  it('counts multiple days overdue', () => {
    expect(formatDue('2026-08-15T12:00:00Z', NOW)).toBe('3 days overdue');
  });
});

describe('overdueSeverity', () => {
  it('is critical for something overdue by less than 2 days', () => {
    expect(overdueSeverity('2026-08-18T11:55:00Z', NOW)).toBe('critical');
    expect(overdueSeverity('2026-08-17T12:00:00Z', NOW)).toBe('critical'); // exactly 1 day
  });

  it('is moderate at exactly 2 days overdue', () => {
    expect(overdueSeverity('2026-08-16T12:00:00Z', NOW)).toBe('moderate');
  });

  it('is moderate for something overdue by many days', () => {
    expect(overdueSeverity('2026-08-01T12:00:00Z', NOW)).toBe('moderate');
  });

  it('is critical for something overdue by a single minute', () => {
    expect(overdueSeverity('2026-08-18T11:59:00Z', NOW)).toBe('critical');
  });
});
