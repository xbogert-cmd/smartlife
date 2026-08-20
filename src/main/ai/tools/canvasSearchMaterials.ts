import type { ToolDefinition } from './types';
import { searchMaterials } from '../../canvas/queries';

export const canvasSearchMaterialsTool: ToolDefinition = {
  name: 'canvas_search_materials',
  tier: 'READ',
  label: 'Search Canvas course materials',
  schema: {
    name: 'canvas_search_materials',
    description:
      'Search the names of synced Canvas files and pages across all courses — for example to locate a syllabus or a lecture PDF. Reads locally synced data.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to match against file and page titles.' },
      },
      required: ['query'],
    },
  },
  async run(input, ctx) {
    const query = typeof input.query === 'string' ? input.query : '';
    if (query.trim().length === 0) return 'Provide a search term to look for.';
    const hits = searchMaterials(ctx.db, query);
    if (hits.length === 0) return `No materials matched "${query}".`;
    const lines = hits.map((hit) => `- [${hit.kind}] ${hit.title} — ${hit.courseName}`);
    return `Matches for "${query}":\n${lines.join('\n')}`;
  },
};
