import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserListActionableElementsTool } from './browserListActionableElements';
import { setActiveBrowserHost } from '../../browser/hostRegistry';
import { resolveExecutionMode } from '../permissions';
import type { ToolContext } from './types';

function ctx(): ToolContext {
  return { db: {} as never, conversationId: 'c1', mode: 'auto', requestConfirmation: vi.fn() };
}

afterEach(() => {
  setActiveBrowserHost(null);
});

describe('browser_list_actionable_elements', () => {
  it('is a READ tool that never pauses', () => {
    expect(browserListActionableElementsTool.tier).toBe('READ');
    expect(resolveExecutionMode(browserListActionableElementsTool.tier, 'ask')).toBe('auto');
  });

  it('reports each element with its ref, role, and label', async () => {
    setActiveBrowserHost({
      listActionableElements: vi.fn().mockResolvedValue([
        { ref: 'ref_1', role: 'button', label: 'Submit Quiz', state: null, options: null },
      ]),
    } as never);

    const out = await browserListActionableElementsTool.run({}, ctx());

    expect(out).toContain('ref: ref_1');
    expect(out).not.toContain('[ref_1]');
    expect(out).toContain('button');
    expect(out).toContain('Submit Quiz');
  });

  it("reports a select's available options", async () => {
    setActiveBrowserHost({
      listActionableElements: vi.fn().mockResolvedValue([
        { ref: 'ref_1', role: 'select', label: 'Question 3', state: 'A) Nucleus', options: ['A) Nucleus', 'B) Mitochondria'] },
      ]),
    } as never);

    const out = await browserListActionableElementsTool.run({}, ctx());

    expect(out).toContain('A) Nucleus');
    expect(out).toContain('B) Mitochondria');
  });

  it('says plainly when nothing actionable is on the page', async () => {
    setActiveBrowserHost({ listActionableElements: vi.fn().mockResolvedValue([]) } as never);

    const out = await browserListActionableElementsTool.run({}, ctx());

    expect(out).toMatch(/nothing.*actionable|no.*interactive/i);
  });

  it('degrades gracefully when the built-in browser is unavailable', async () => {
    setActiveBrowserHost(null);

    const out = await browserListActionableElementsTool.run({}, ctx());

    expect(out).toMatch(/not available/i);
  });

  it('passes an optional tabIndex through to the host, mirroring browser_read_page', async () => {
    const listActionableElements = vi.fn().mockResolvedValue([]);
    setActiveBrowserHost({ getState: vi.fn().mockReturnValue({ tabs: [{ id: 't1' }, { id: 't2' }], activeTabId: 't1' }), listActionableElements } as never);

    await browserListActionableElementsTool.run({ tabIndex: 2 }, ctx());

    expect(listActionableElements).toHaveBeenCalledWith('t2');
  });
});
