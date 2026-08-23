import type { ToolDefinition } from './types';
import { gate } from '../permissions';
import { getActiveBrowserHost, originForTab } from '../../browser/hostRegistry';
import { resolveElement } from '../../browser/refs';

const CONFIRMATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const browserClickTool: ToolDefinition = {
  name: 'browser_click',
  // The one tier auto mode does not skip. A page's own content must never
  // be able to turn into a click nobody looked at first.
  tier: 'ALWAYS_CONFIRM',
  label: 'Click an element',
  schema: {
    name: 'browser_click',
    description:
      'Click a button, link, checkbox, or radio button on the current page, addressed by a ref from browser_list_actionable_elements. Always confirmed by the user first, no matter the mode.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The element ref from browser_list_actionable_elements.' },
      },
      required: ['ref'],
    },
  },
  async run(input, ctx) {
    const ref = String(input.ref ?? '');
    const target = resolveElement(ref);
    if (target === null) {
      return 'That element reference is no longer valid — call browser_list_actionable_elements again and use a fresh ref.';
    }

    const origin = originForTab(target.tabId);
    const prefix = origin.length > 0 ? `On ${origin}: ` : '';
    const approved = await gate(
      'ALWAYS_CONFIRM',
      ctx.mode,
      'browser_click',
      `${prefix}Click the ${target.role} labeled "${target.label}".`,
      ctx.requestConfirmation,
      CONFIRMATION_TIMEOUT_MS
    );
    if (!approved) return 'The user declined, so nothing was clicked.';

    const host = getActiveBrowserHost();
    if (host === null) return 'The built-in browser is not available right now.';

    const result = await host.clickElement(ref);
    if (result.ok) return `Clicked the ${result.role} labeled "${result.label}".`;
    if (result.reason === 'not-found') {
      return 'That element reference is no longer valid — call browser_list_actionable_elements again and use a fresh ref.';
    }
    return 'The page changed since this was proposed, so nothing was clicked — call browser_list_actionable_elements again to see its current state.';
  },
};
