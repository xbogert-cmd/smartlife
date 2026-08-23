import type { ToolDefinition } from './types';
import { findAssignments, type AssignmentSearchHit } from '../../canvas/queries';

const LIMIT = 15;

/** What the model can actually do with it, stated plainly so it stops guessing. */
function capability(hit: AssignmentSearchHit): string {
  switch (hit.path.kind) {
    case 'text':
      return 'takes a text entry — you can submit it with canvas_submit_assignment';
    case 'text-or-file':
      return 'takes text or a file — you can submit the text with canvas_submit_assignment';
    case 'discussion':
      return 'is a graded discussion — canvas_submit_assignment posts to it, visible to the whole class';
    case 'file':
      return 'takes a file upload — only the user can attach files';
    case 'handoff':
      return 'can only be done in the browser — open it with canvas_open_assignment';
    case 'none':
      return 'does not take a submission';
  }
}

export const canvasFindAssignmentTool: ToolDefinition = {
  name: 'canvas_find_assignment',
  tier: 'READ',
  label: 'Find a Canvas assignment',
  schema: {
    name: 'canvas_find_assignment',
    description:
      "Find Canvas assignments by name, across every course and regardless of due date -- including work that is past due, undated, or already submitted. Use this whenever the user names an assignment (\"Homework 2\", \"the Chapter 4 quiz\"), because canvas_upcoming_assignments only covers work that is still due. Returns each match's assignment id, which other tools need. Reads locally synced data. If nothing matches, say so plainly and suggest a Canvas sync -- never guess at an assignment or its contents.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Part of the assignment name, e.g. "Homework 2".',
        },
      },
      required: ['query'],
    },
  },
  async run(input, ctx) {
    const query = typeof input.query === 'string' ? input.query : '';
    if (query.trim().length === 0) return 'Provide part of an assignment name to search for.';

    const hits = findAssignments(ctx.db, query, LIMIT);
    if (hits.length === 0) {
      return `No assignment matching "${query}" is in the local database. It may not have synced yet — do not guess at what it asks for.`;
    }

    const lines = hits.map((hit) => {
      const due = hit.dueAt === null ? 'no due date' : `due ${hit.dueAt}`;
      const points = hit.pointsPossible === null ? '' : `, ${hit.pointsPossible} pts`;
      const submitted = hit.hasSubmitted ? ', already submitted' : '';
      return `- [assignment id ${hit.id}] ${hit.name} — ${hit.courseName} — ${due}${points}${submitted}. It ${capability(hit)}.`;
    });
    return `Assignments matching "${query}":\n${lines.join('\n')}`;
  },
};
