import type { ToolDefinition } from './types';
import { gate } from '../permissions';
import { getActiveBrowserHost, originForTab } from '../../browser/hostRegistry';
import { resolveElement } from '../../browser/refs';

const CONFIRMATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const browserTypeTool: ToolDefinition = {
  name: 'browser_type',
  tier: 'ALWAYS_CONFIRM',
  label: 'Type into a field',
  schema: {
    name: 'browser_type',
    description:
      'Set a text field or textarea to the given text, addressed by a ref from browser_list_actionable_elements. The user sees the exact text before confirming, never a summary. Always confirmed first, no matter the mode.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The element ref from browser_list_actionable_elements.' },
        text: { type: 'string', description: 'The exact text to set the field to.' },
      },
      required: ['ref', 'text'],
    },
  },
  async run(input, ctx) {
    const ref = String(input.ref ?? '');
    const text = String(input.text ?? '');
    if (text.length === 0) return 'There is nothing to type — the text is empty.';

    const target = resolveElement(ref);
    if (target === null) {
      return 'That element reference is no longer valid — call browser_list_actionable_elements again and use a fresh ref.';
    }

    // Never summarised or truncated -- the user is approving specific bytes,
    // same rule canvas_submit_assignment follows for submission text.
    const origin = originForTab(target.tabId);
    const prefix = origin.length > 0 ? `On ${origin}: ` : '';
    const description = `${prefix}Type into the field labeled "${target.label}".\n\n--- exactly what will be typed ---\n${text}`;
    const approved = await gate(
      'ALWAYS_CONFIRM',
      ctx.mode,
      'browser_type',
      description,
      ctx.requestConfirmation,
      CONFIRMATION_TIMEOUT_MS
    );
    if (!approved) return 'The user declined, so nothing was typed.';

    const host = getActiveBrowserHost();
    if (host === null) return 'The built-in browser is not available right now.';

    const result = await host.typeIntoElement(ref, text);
    if (result.ok) return `Typed into the field labeled "${result.label}".`;
    if (result.reason === 'not-found') {
      return 'That element reference is no longer valid — call browser_list_actionable_elements again and use a fresh ref.';
    }
    return 'The page changed since this was proposed, so nothing was typed — call browser_list_actionable_elements again to see its current state.';
  },
};
