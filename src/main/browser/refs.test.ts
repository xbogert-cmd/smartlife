import { describe, expect, it } from 'vitest';
import { invalidateTab, recordElements, resolveElement } from './refs';

describe('refs registry', () => {
  it('assigns a ref to each recorded element and makes it resolvable', () => {
    const [button] = recordElements('tab-1', [
      { role: 'button', label: 'Submit', state: null, options: null },
    ]);
    expect(button.ref).toMatch(/^ref_\d+$/);
    expect(resolveElement(button.ref)).toEqual({ ...button, tabId: 'tab-1' });
  });

  it('returns null for a ref that was never issued', () => {
    expect(resolveElement('ref_999999')).toBeNull();
  });

  it('never reuses a ref string across two different recordElements calls, even for the same tab', () => {
    const [first] = recordElements('tab-2', [{ role: 'button', label: 'A', state: null, options: null }]);
    const [second] = recordElements('tab-2', [{ role: 'button', label: 'B', state: null, options: null }]);
    expect(first.ref).not.toBe(second.ref);
  });

  it('invalidates every ref belonging to a tab, and only that tab', () => {
    const [a] = recordElements('tab-3', [{ role: 'button', label: 'A', state: null, options: null }]);
    const [b] = recordElements('tab-4', [{ role: 'button', label: 'B', state: null, options: null }]);

    invalidateTab('tab-3');

    expect(resolveElement(a.ref)).toBeNull();
    expect(resolveElement(b.ref)).toEqual({ ...b, tabId: 'tab-4' });
  });

  it('a fresh read of a tab invalidates that tab\'s previous refs, so a stale ref from the old read can never resolve', () => {
    const [oldButton] = recordElements('tab-5', [{ role: 'button', label: 'Old', state: null, options: null }]);
    recordElements('tab-5', [{ role: 'button', label: 'New', state: null, options: null }]);

    expect(resolveElement(oldButton.ref)).toBeNull();
  });

  it('preserves state and options exactly as given', () => {
    const [select] = recordElements('tab-6', [
      { role: 'select', label: 'Question 3', state: 'B) Mitochondria', options: ['A) Nucleus', 'B) Mitochondria', 'C) Ribosome'] },
    ]);
    const resolved = resolveElement(select.ref);
    expect(resolved?.state).toBe('B) Mitochondria');
    expect(resolved?.options).toEqual(['A) Nucleus', 'B) Mitochondria', 'C) Ribosome']);
  });

  it('invalidating a tab with no recorded elements does not throw', () => {
    expect(() => invalidateTab('never-recorded')).not.toThrow();
  });
});
