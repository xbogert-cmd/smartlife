import type { ToolDefinition } from './types';
import { getSettingsTool } from './getSettings';
import { setThemeTool } from './setTheme';
import { clearConversationHistoryTool } from './clearConversationHistory';
import { canvasUpcomingTool } from './canvasUpcoming';
import { canvasGradesTool } from './canvasGrades';
import { canvasSearchMaterialsTool } from './canvasSearchMaterials';

export const TOOLS: ToolDefinition[] = [
  getSettingsTool,
  setThemeTool,
  clearConversationHistoryTool,
  canvasUpcomingTool,
  canvasGradesTool,
  canvasSearchMaterialsTool,
];
