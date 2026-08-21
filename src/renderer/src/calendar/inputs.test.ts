import { describe, expect, it } from 'vitest';
import { fromDateTimeInputValue, toDateInputValue, toDateTimeInputValue } from './inputs';

describe('toDateTimeInputValue', () => {
  it('renders local wall-clock time, not UTC', () => {
    const iso = new Date(2026, 7, 21, 14, 30).toISOString();
    // Slicing the ISO string would show the UTC hour and silently shift every
    // event the user opens for editing.
    expect(toDateTimeInputValue(iso)).toBe('2026-08-21T14:30');
  });

  it('zero-pads every component', () => {
    expect(toDateTimeInputValue(new Date(2026, 0, 5, 9, 5).toISOString())).toBe('2026-01-05T09:05');
  });
});

describe('fromDateTimeInputValue', () => {
  it('round-trips back to the same instant', () => {
    const iso = new Date(2026, 7, 21, 14, 30).toISOString();
    expect(fromDateTimeInputValue(toDateTimeInputValue(iso))).toBe(iso);
  });
});

describe('toDateInputValue', () => {
  it('passes a bare all-day date through untouched', () => {
    expect(toDateInputValue('2026-08-21')).toBe('2026-08-21');
  });

  it('reduces a timestamp to its local date', () => {
    expect(toDateInputValue(new Date(2026, 7, 21, 20, 0).toISOString())).toBe('2026-08-21');
  });
});
