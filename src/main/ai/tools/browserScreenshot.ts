import { getActiveBrowserHost } from '../../browser/hostRegistry';
import type { ToolDefinition } from './types';

export const browserScreenshotTool: ToolDefinition = {
  name: 'browser_screenshot',
  tier: 'READ',
  label: 'Take a screenshot of the page',
  schema: {
    name: 'browser_screenshot',
    description:
      "Capture what a tab in SmartLife's built-in browser actually looks like, as an image -- unlike browser_read_page, this sees content DOM text-extraction can't reach (cross-origin iframes, canvas-rendered viewers, scanned documents). Defaults to the active tab. Reach for this after browser_read_page comes back empty or clearly insufficient.",
    input_schema: {
      type: 'object',
      properties: {
        tabIndex: {
          type: 'number',
          description: 'Optional 1-based tab number from browser_list_tabs. Omit to capture the active tab.',
        },
      },
      required: [],
    },
  },
  async run(input, ctx) {
    const host = getActiveBrowserHost();
    if (host === null) return 'The built-in browser is not available right now.';

    const state = host.getState();
    let tabId: string | undefined;
    if (input.tabIndex !== undefined) {
      const index = Number(input.tabIndex);
      const tab = state.tabs[index - 1];
      if (!tab) return `No tab ${index} is open. Use browser_list_tabs to see what is available.`;
      tabId = tab.id;
    }

    const capture = await host.captureScreenshot(tabId);
    if (capture === null) return "Couldn't capture a screenshot of that tab.";

    ctx.attachImage?.({ type: 'image', mimeType: capture.mimeType, data: capture.data });
    return 'Screenshot captured.';
  },
};
