import { describe, expect, it } from 'vitest';
import { getSectionTheme } from './sectionThemes';

describe('getSectionTheme', () => {
  it('returns the registered theme for a known section', () => {
    expect(getSectionTheme('calendar').accent).toBe('#FB923C');
  });

  it('falls back to the default (Home) theme for an unregistered slug', () => {
    expect(getSectionTheme('nonexistent')).toEqual(getSectionTheme('home'));
  });
});
