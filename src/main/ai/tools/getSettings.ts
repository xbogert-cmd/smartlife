import { app } from 'electron';
import { getThemePreference } from '../../ipc';
import type { ToolDefinition } from './types';

export const getSettingsTool: ToolDefinition = {
  name: 'get_settings',
  tier: 'READ',
  label: 'Reading settings',
  schema: {
    name: 'get_settings',
    description: 'Read the current app settings: theme preference and app version.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async run(_input, ctx) {
    const theme = getThemePreference(ctx.db);
    return JSON.stringify({ theme, version: app.getVersion() });
  },
};
