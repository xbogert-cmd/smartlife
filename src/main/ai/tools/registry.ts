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
import { browserListTabsTool } from './browserListTabs';
import { browserReadPageTool } from './browserReadPage';
import { browserListActionableElementsTool } from './browserListActionableElements';
import { browserClickTool } from './browserClick';
import { browserTypeTool } from './browserType';
import { browserSelectTool } from './browserSelect';
import { canvasSubmitAssignmentTool } from './canvasSubmitAssignment';
import { canvasFindAssignmentTool } from './canvasFindAssignment';
import { canvasOpenAssignmentTool } from './canvasOpenAssignment';

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
  browserListTabsTool,
  browserReadPageTool,
  browserListActionableElementsTool,
  browserClickTool,
  browserTypeTool,
  browserSelectTool,
  canvasSubmitAssignmentTool,
  canvasFindAssignmentTool,
  canvasOpenAssignmentTool,
];
