import type { ToolDefinition } from './types';
import { getUpcomingAssignments } from '../../canvas/queries';

const DEFAULT_DAYS = 7;
const MAX_DAYS = 180;

export const canvasUpcomingTool: ToolDefinition = {
  name: 'canvas_upcoming_assignments',
  tier: 'READ',
  label: 'Read upcoming Canvas assignments',
  schema: {
    name: 'canvas_upcoming_assignments',
    description:
      "List Canvas assignments due within the next N days, across all of the student's active courses. Reads locally synced data, so it is instant and works offline.",
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: `How many days ahead to look. Defaults to ${DEFAULT_DAYS}.`,
        },
      },
      required: [],
    },
  },
  async run(input, ctx) {
    const requested =
      typeof input.days === 'number' && Number.isFinite(input.days) ? input.days : DEFAULT_DAYS;
    const days = Math.min(MAX_DAYS, Math.max(0, Math.floor(requested)));
    return format(getUpcomingAssignments(ctx.db, days), days);
  },
};

function format(rows: ReturnType<typeof getUpcomingAssignments>, days: number): string {
  if (rows.length === 0) return `Nothing is due in the next ${days} days.`;
  const lines = rows.map((row) => {
    const status = row.hasSubmitted ? ' — submitted' : '';
    const points = row.pointsPossible === null ? '' : ` (${row.pointsPossible} pts)`;
    // The id is what canvas_submit_assignment and canvas_open_assignment take,
    // and this tool's own schema promises it -- without it the model has to go
    // scrape it off a web page.
    return `- [assignment id ${row.id}] ${row.name}${points} — ${row.courseName} — due ${row.dueAt}${status}`;
  });
  return `Due in the next ${days} days:\n${lines.join('\n')}`;
}
