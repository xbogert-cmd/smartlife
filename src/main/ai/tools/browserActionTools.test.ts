import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserClickTool } from './browserClick';
import { browserTypeTool } from './browserType';
import { browserSelectTool } from './browserSelect';
import { setActiveBrowserHost } from '../../browser/hostRegistry';
import { resolveExecutionMode } from '../permissions';
import { recordElements } from '../../browser/refs';
import type { ToolContext } from './types';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { db: {} as never, conversationId: 'c1', mode: 'auto', requestConfirmation: vi.fn().mockResolvedValue(true), ...overrides };
}

afterEach(() => {
  setActiveBrowserHost(null);
});

describe('browser_click', () => {
  it('is ALWAYS_CONFIRM and pauses in every mode, including auto', () => {
    expect(browserClickTool.tier).toBe('ALWAYS_CONFIRM');
    expect(resolveExecutionMode('ALWAYS_CONFIRM', 'ask')).toBe('pause');
    expect(resolveExecutionMode('ALWAYS_CONFIRM', 'assist')).toBe('pause');
    expect(resolveExecutionMode('ALWAYS_CONFIRM', 'auto')).toBe('pause');
  });

  it('describes the element plainly in the confirmation before clicking', async () => {
    const [el] = recordElements('tab-1', [{ role: 'button', label: 'Submit Quiz', state: null, options: null }]);
    const clickElement = vi.fn().mockResolvedValue({ ok: true, role: 'button', label: 'Submit Quiz' });
    setActiveBrowserHost({ clickElement } as never);
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    await browserClickTool.run({ ref: el.ref }, ctx({ mode: 'ask', requestConfirmation }));

    expect(requestConfirmation.mock.calls[0][1]).toMatch(/button.*Submit Quiz/i);
  });

  it('passes a 24-hour timeout to the confirmation', async () => {
    const [el] = recordElements('tab-2', [{ role: 'button', label: 'Next', state: null, options: null }]);
    setActiveBrowserHost({ clickElement: vi.fn().mockResolvedValue({ ok: true, role: 'button', label: 'Next' }) } as never);
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    await browserClickTool.run({ ref: el.ref }, ctx({ mode: 'ask', requestConfirmation }));

    expect(requestConfirmation).toHaveBeenCalledWith(expect.any(String), expect.any(String), 24 * 60 * 60 * 1000);
  });

  it('refuses without asking for confirmation when the ref is unknown', async () => {
    const requestConfirmation = vi.fn();
    setActiveBrowserHost({ clickElement: vi.fn() } as never);

    const out = await browserClickTool.run({ ref: 'ref_never_issued' }, ctx({ mode: 'ask', requestConfirmation }));

    expect(out).toMatch(/no longer valid|read the page again/i);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('does not click when the user declines', async () => {
    const [el] = recordElements('tab-3', [{ role: 'button', label: 'Submit', state: null, options: null }]);
    const clickElement = vi.fn();
    setActiveBrowserHost({ clickElement } as never);

    const out = await browserClickTool.run({ ref: el.ref }, ctx({ mode: 'ask', requestConfirmation: vi.fn().mockResolvedValue(false) }));

    expect(out).toMatch(/declined/i);
    expect(clickElement).not.toHaveBeenCalled();
  });

  it('reports that the page changed when the host refuses at execution time, without pretending success', async () => {
    const [el] = recordElements('tab-4', [{ role: 'button', label: 'Submit', state: null, options: null }]);
    setActiveBrowserHost({ clickElement: vi.fn().mockResolvedValue({ ok: false, reason: 'changed' }) } as never);

    const out = await browserClickTool.run({ ref: el.ref }, ctx());

    expect(out).toMatch(/changed|read the page again/i);
  });

  it('still pauses for confirmation in auto mode, since ALWAYS_CONFIRM is the tier auto does not skip', async () => {
    const [el] = recordElements('tab-5', [{ role: 'button', label: 'Submit', state: null, options: null }]);
    const requestConfirmation = vi.fn().mockResolvedValue(true);
    setActiveBrowserHost({ clickElement: vi.fn().mockResolvedValue({ ok: true, role: 'button', label: 'Submit' }) } as never);

    await browserClickTool.run({ ref: el.ref }, ctx({ mode: 'auto', requestConfirmation }));

    expect(requestConfirmation).toHaveBeenCalled();
  });
});

describe('browser_type', () => {
  it('shows the exact literal text in the confirmation, never summarized', async () => {
    const [el] = recordElements('tab-6', [{ role: 'text', label: 'Answer', state: '', options: null }]);
    setActiveBrowserHost({ typeIntoElement: vi.fn().mockResolvedValue({ ok: true, role: 'text', label: 'Answer' }) } as never);
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    await browserTypeTool.run({ ref: el.ref, text: 'Photosynthesis converts light into chemical energy.' }, ctx({ mode: 'ask', requestConfirmation }));

    expect(requestConfirmation.mock.calls[0][1]).toContain('Photosynthesis converts light into chemical energy.');
  });

  it('refuses empty text without a confirmation', async () => {
    const [el] = recordElements('tab-7', [{ role: 'text', label: 'Answer', state: '', options: null }]);
    const requestConfirmation = vi.fn();
    setActiveBrowserHost({ typeIntoElement: vi.fn() } as never);

    const out = await browserTypeTool.run({ ref: el.ref, text: '' }, ctx({ requestConfirmation }));

    expect(out).toMatch(/nothing to type|empty/i);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('pauses for confirmation in both assist mode and auto mode', async () => {
    const [assistEl] = recordElements('tab-7b', [{ role: 'text', label: 'Answer', state: '', options: null }]);
    const assistConfirm = vi.fn().mockResolvedValue(true);
    setActiveBrowserHost({ typeIntoElement: vi.fn().mockResolvedValue({ ok: true, role: 'text', label: 'Answer' }) } as never);
    await browserTypeTool.run({ ref: assistEl.ref, text: 'X' }, ctx({ mode: 'assist', requestConfirmation: assistConfirm }));
    expect(assistConfirm).toHaveBeenCalled();

    const [autoEl] = recordElements('tab-7c', [{ role: 'text', label: 'Answer', state: '', options: null }]);
    const autoConfirm = vi.fn().mockResolvedValue(true);
    await browserTypeTool.run({ ref: autoEl.ref, text: 'X' }, ctx({ mode: 'auto', requestConfirmation: autoConfirm }));
    expect(autoConfirm).toHaveBeenCalled();
  });
});

describe('browser_select', () => {
  it('names the chosen option and the field in the confirmation', async () => {
    const [el] = recordElements('tab-8', [{ role: 'select', label: 'Question 3', state: 'A) Nucleus', options: ['A) Nucleus', 'B) Mitochondria'] }]);
    setActiveBrowserHost({ selectOption: vi.fn().mockResolvedValue({ ok: true, role: 'select', label: 'Question 3' }) } as never);
    const requestConfirmation = vi.fn().mockResolvedValue(true);

    await browserSelectTool.run({ ref: el.ref, option: 'B) Mitochondria' }, ctx({ mode: 'ask', requestConfirmation }));

    expect(requestConfirmation.mock.calls[0][1]).toMatch(/B\) Mitochondria.*Question 3|Question 3.*B\) Mitochondria/);
  });

  it('reports the available options when the chosen text does not match any', async () => {
    const [el] = recordElements('tab-9', [{ role: 'select', label: 'Question 3', state: 'A) Nucleus', options: ['A) Nucleus', 'B) Mitochondria'] }]);
    setActiveBrowserHost({
      selectOption: vi.fn().mockResolvedValue({ ok: false, reason: 'no-such-option', available: ['A) Nucleus', 'B) Mitochondria'] }),
    } as never);

    const out = await browserSelectTool.run({ ref: el.ref, option: 'Z) Not real' }, ctx());

    expect(out).toContain('A) Nucleus');
    expect(out).toContain('B) Mitochondria');
  });

  it('pauses for confirmation in both assist mode and auto mode', async () => {
    const [assistEl] = recordElements('tab-9b', [{ role: 'select', label: 'Question 3', state: 'A) Nucleus', options: ['A) Nucleus', 'B) Mitochondria'] }]);
    const assistConfirm = vi.fn().mockResolvedValue(true);
    setActiveBrowserHost({ selectOption: vi.fn().mockResolvedValue({ ok: true, role: 'select', label: 'Question 3' }) } as never);
    await browserSelectTool.run({ ref: assistEl.ref, option: 'B) Mitochondria' }, ctx({ mode: 'assist', requestConfirmation: assistConfirm }));
    expect(assistConfirm).toHaveBeenCalled();

    const [autoEl] = recordElements('tab-9c', [{ role: 'select', label: 'Question 3', state: 'A) Nucleus', options: ['A) Nucleus', 'B) Mitochondria'] }]);
    const autoConfirm = vi.fn().mockResolvedValue(true);
    await browserSelectTool.run({ ref: autoEl.ref, option: 'B) Mitochondria' }, ctx({ mode: 'auto', requestConfirmation: autoConfirm }));
    expect(autoConfirm).toHaveBeenCalled();
  });
});
