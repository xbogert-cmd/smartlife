import { describe, expect, it } from 'vitest';
import { safeFileName } from './files';

describe('safeFileName', () => {
  it('keeps an ordinary name intact', () => {
    expect(safeFileName('Lecture 1.pdf')).toBe('Lecture 1.pdf');
  });

  it('strips directory traversal segments', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('..\\..\\windows\\system32')).toBe('system32');
  });

  it('strips leading dots so nothing writes a hidden file', () => {
    expect(safeFileName('...hidden')).toBe('hidden');
  });

  it('falls back to a placeholder when nothing usable remains', () => {
    expect(safeFileName('../')).toBe('download');
    expect(safeFileName('   ')).toBe('download');
  });

  // Not in the brief's test list: a bare ".." or "." with no trailing slash is
  // the literal parent/current-directory reference, and a Canvas display_name
  // could plausibly be exactly this. basename('..') and basename('.') both
  // return the string unchanged (no separator to split on), so this exercises
  // a path through the function the slash-focused cases above don't reach.
  it('falls back to a placeholder for a bare "." or ".." with no trailing slash', () => {
    expect(safeFileName('..')).toBe('download');
    expect(safeFileName('.')).toBe('download');
  });

  // Not in the brief's test list: an empty display_name is plausible (Canvas
  // has been known to return blank names for some upload paths) and must not
  // produce an empty filename component.
  it('falls back to a placeholder for an empty string', () => {
    expect(safeFileName('')).toBe('download');
  });

  it('truncates absurdly long names', () => {
    expect(safeFileName(`${'a'.repeat(300)}.pdf`).length).toBeLessThanOrEqual(120);
  });
});
