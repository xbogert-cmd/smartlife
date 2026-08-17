import { describe, expect, it } from 'vitest';
import { greeting } from './Home';

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
