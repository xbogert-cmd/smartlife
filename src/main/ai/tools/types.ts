import type Database from 'better-sqlite3';
import type { AiMode, ToolTier } from '../permissions';

export interface ToolContext {
  db: Database.Database;
  conversationId: string;
  mode: AiMode;
  requestConfirmation: (toolName: string, description: string, timeoutMs?: number) => Promise<boolean>;
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  tier: ToolTier;
  label: string;
  schema: ToolSchema;
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}
