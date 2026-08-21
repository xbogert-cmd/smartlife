import type { ToolDefinition } from './types';
import { getSettingsTool } from './getSettings';
import { setThemeTool } from './setTheme';
import { clearConversationHistoryTool } from './clearConversationHistory';
import { canvasUpcomingTool } from './canvasUpcoming';
import { canvasGradesTool } from './canvasGrades';
import { canvasSearchMaterialsTool } from './canvasSearchMaterials';
import { calendarListEventsTool } from './calendarListEvents';
import { calendarCreateEventTool } from './calendarCreateEvent';
import { calendarUpdateEventTool } from './calendarUpdateEvent';
import { calendarDeleteEventTool } from './calendarDeleteEvent';

export const TOOLS: ToolDefinition[] = [
  getSettingsTool,
  setThemeTool,
  clearConversationHistoryTool,
  canvasUpcomingTool,
  canvasGradesTool,
  canvasSearchMaterialsTool,
  calendarListEventsTool,
  calendarCreateEventTool,
  calendarUpdateEventTool,
  calendarDeleteEventTool,
];
