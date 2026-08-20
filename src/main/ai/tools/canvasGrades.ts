import type { ToolDefinition } from './types';
import { getCourseGrades } from '../../canvas/queries';

export const canvasGradesTool: ToolDefinition = {
  name: 'canvas_course_grades',
  tier: 'READ',
  label: 'Read Canvas course grades',
  schema: {
    name: 'canvas_course_grades',
    description:
      "Report the student's current grade in each active Canvas course. Reads locally synced data.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  async run(_input, ctx) {
    const rows = getCourseGrades(ctx.db);
    if (rows.length === 0) return 'No courses have been synced from Canvas yet.';
    const lines = rows.map((row) => {
      const code = row.courseCode ? ` (${row.courseCode})` : '';
      if (row.currentScore === null) return `- ${row.name}${code}: no grade posted`;
      const letter = row.currentGrade ? ` (${row.currentGrade})` : '';
      return `- ${row.name}${code}: ${row.currentScore}%${letter}`;
    });
    return `Current grades:\n${lines.join('\n')}`;
  },
};
