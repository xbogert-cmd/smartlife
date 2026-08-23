import type { ToolDefinition } from './types';
import { gate } from '../permissions';
import { getActiveBrowserHost } from '../../browser/hostRegistry';

const CONFIRMATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export const browserOpenTabTool: ToolDefinition = {
  name: 'browser_open_tab',
  // Matches canvas_open_assignment's tier for the same shape of risk: opens
  // a tab, visibly adds something to the browser, but submits nothing and
  // acts on no third-party site.
  tier: 'SAFE_WRITE',
  label: 'Open a reference tab',
  schema: {
    name: 'browser_open_tab',
    description:
      "Open a URL in a new background tab in SmartLife's built-in browser, without switching the user's current view -- use this to look something up while helping with the page the user is already on. After it opens, use browser_read_page with that tab's index to read it.",
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http or https URL to open.' },
      },
      required: ['url'],
    },
  },
  async run(input, ctx) {
    const url = String(input.url ?? '');
    if (!isHttpUrl(url)) return 'Only http and https URLs can be opened.';

    const approved = await gate(
      'SAFE_WRITE',
      ctx.mode,
      'browser_open_tab',
      `Open ${url} in a new background tab.`,
      ctx.requestConfirmation,
      CONFIRMATION_TIMEOUT_MS
    );
    if (!approved) return 'The user declined, so nothing was opened.';

    const host = getActiveBrowserHost();
    if (host === null) return 'The built-in browser is not available right now.';

    // Deliberately no activateTab call and no navigator switch -- unlike
    // canvas_open_assignment, this opens in the background so it does not
    // interrupt whatever the user is currently doing.
    host.openTab(url, false);

    return `Opened ${url} in a background tab. Use browser_list_tabs to find its index, then browser_read_page to read it.`;
  },
};
