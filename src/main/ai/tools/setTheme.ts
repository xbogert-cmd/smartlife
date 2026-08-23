import { setThemePreference, broadcastThemePreferenceChange } from '../../ipc';
import { gate } from '../permissions';
import type { ToolDefinition } from './types';

const VALID_THEMES = ['light', 'dark', 'system'] as const;
type Theme = (typeof VALID_THEMES)[number];

export const setThemeTool: ToolDefinition = {
  name: 'set_theme',
  tier: 'SAFE_WRITE',
  label: 'Changing theme',
  schema: {
    name: 'set_theme',
    description: 'Change the app theme preference.',
    input_schema: {
      type: 'object',
      properties: {
        theme: { type: 'string', enum: ['light', 'dark', 'system'], description: 'The theme to switch to.' },
      },
      required: ['theme'],
      additionalProperties: false,
    },
  },
  async run(input, ctx) {
    const theme = input.theme as string;
    if (!VALID_THEMES.includes(theme as Theme)) {
      return `Invalid theme "${theme}". Must be one of: light, dark, system.`;
    }
    const approved = await gate('SAFE_WRITE', ctx.mode, 'set_theme', `Change theme to "${theme}"`, ctx.requestConfirmation);
    if (!approved) return 'User declined this action.';
    setThemePreference(ctx.db, theme as Theme);
    broadcastThemePreferenceChange(theme as Theme);
    return `Theme set to "${theme}".`;
  },
};
