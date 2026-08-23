import type { ToolDefinition } from './types';
import { gate } from '../permissions';
import { getActiveBrowserHost, originForTab } from '../../browser/hostRegistry';
import { resolveElement } from '../../browser/refs';

const CONFIRMATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const browserSelectTool: ToolDefinition = {
  name: 'browser_select',
  tier: 'ALWAYS_CONFIRM',
  label: 'Choose a dropdown option',
  schema: {
    name: 'browser_select',
    description:
      'Choose an option from a dropdown (<select>) on the current page, addressed by a ref from browser_list_actionable_elements. option is the option\'s exact visible text, from the ref list\'s reported options -- not a raw HTML value. Always confirmed first, no matter the mode.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The element ref from browser_list_actionable_elements.' },
        option: { type: 'string', description: "The option's exact visible text." },
      },
      required: ['ref', 'option'],
    },
  },
  async run(input, ctx) {
    const ref = String(input.ref ?? '');
    const option = String(input.option ?? '');

    const target = resolveElement(ref);
    if (target === null) {
      return 'That element reference is no longer valid — call browser_list_actionable_elements again and use a fresh ref.';
    }

    const origin = originForTab(target.tabId);
    const prefix = origin.length > 0 ? `On ${origin}: ` : '';
    const approved = await gate(
      'ALWAYS_CONFIRM',
      ctx.mode,
      'browser_select',
      `${prefix}Choose "${option}" from the dropdown labeled "${target.label}".`,
      ctx.requestConfirmation,
      CONFIRMATION_TIMEOUT_MS
    );
    if (!approved) return 'The user declined, so nothing was chosen.';

    const host = getActiveBrowserHost();
    if (host === null) return 'The built-in browser is not available right now.';

    const result = await host.selectOption(ref, option);
    if (result.ok) return `Chose "${option}" from the dropdown labeled "${result.label}".`;
    if (result.reason === 'not-found') {
      return 'That element reference is no longer valid — call browser_list_actionable_elements again and use a fresh ref.';
    }
    if (result.reason === 'no-such-option') {
      return `"${option}" is not one of this dropdown's options. Available: ${result.available.join(', ')}.`;
    }
    return 'The page changed since this was proposed, so nothing was chosen — call browser_list_actionable_elements again to see its current state.';
  },
};
