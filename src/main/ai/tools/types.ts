import type Database from 'better-sqlite3';
import type { AiMode, ToolTier } from '../permissions';

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** A single image, always turn-scoped -- see providers/types.ts's
 *  CanonicalContentBlock and this phase's plan for why images never cross
 *  the persisted-history boundary the way CanonicalTextBlock does. */
export interface CanonicalImageBlock {
  type: 'image';
  mimeType: string;
  data: string; // base64
}

export interface ToolContext {
  db: Database.Database;
  conversationId: string;
  mode: AiMode;
  requestConfirmation: (toolName: string, description: string, timeoutMs?: number) => Promise<boolean>;
  /** Tools that need to hand the model an image mid-turn (browser_screenshot)
   *  push it here instead of returning it directly -- ToolDefinition.run stays
   *  string-only so no other tool's signature changes. Each provider adapter
   *  drains pendingImages after running a tool/round and feeds the image back
   *  to the model using whatever mechanism that provider natively supports.
   *  Both fields are optional so the many existing test files that construct
   *  a bare ToolContext literal don't need updating -- real usage (chatController.ts)
   *  always provides both. */
  attachImage?: (block: CanonicalImageBlock) => void;
  pendingImages?: CanonicalImageBlock[];
}

export interface ToolDefinition {
  name: string;
  tier: ToolTier;
  label: string;
  schema: ToolSchema;
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}
