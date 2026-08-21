import { getActiveBrowserHost } from '../../browser/hostRegistry';
import type { ToolDefinition } from './types';

export const browserListTabsTool: ToolDefinition = {
  name: 'browser_list_tabs',
  tier: 'READ',
  label: 'List browser tabs',
  schema: {
    name: 'browser_list_tabs',
    description:
      "List the tabs currently open in SmartLife's built-in browser. Reads local state only, so it is instant and free. Use it to see what the user is looking at before reading a page. You cannot open, close, or navigate tabs -- only the user can.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  async run() {
    const host = getActiveBrowserHost();
    if (host === null) return 'The built-in browser is not available right now.';

    const state = host.getState();
    if (state.tabs.length === 0) return 'No tabs are open in the built-in browser.';

    // 1-based indexes, because that is what browser_read_page takes.
    const lines = state.tabs.map((tab, index) => {
      const active = tab.id === state.activeTabId ? ' (active)' : '';
      const title = tab.title.length > 0 ? tab.title : '(untitled)';
      return `${index + 1}. ${title}${active} — ${tab.url}`;
    });
    return `Open browser tabs:\n${lines.join('\n')}`;
  },
};
