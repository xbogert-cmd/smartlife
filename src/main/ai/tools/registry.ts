import type { ToolDefinition } from './types';
import { getSettingsTool } from './getSettings';
import { setThemeTool } from './setTheme';
import { clearConversationHistoryTool } from './clearConversationHistory';

export const TOOLS: ToolDefinition[] = [getSettingsTool, setThemeTool, clearConversationHistoryTool];
