import type { ToolContext, ToolDefinition } from './types';
import { gate } from '../permissions';

/** Single entry point every provider adapter calls instead of `tool.run()`
 *  directly. READ-tier tools never call gate() themselves -- there are 10
 *  of them and none need per-call tier escalation, unlike writes -- so
 *  gating them here, once, is the whole fix for Ask mode pausing on reads.
 *  Write-tier tools keep self-gating inside run() because several escalate
 *  their tier at call time (e.g. calendar_create_event -> CONSEQUENTIAL
 *  when attendees are present) and only the tool itself knows that at call
 *  time -- runTool falls through to tool.run() unconditionally for them. */
export async function runTool(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  if (tool.tier === 'READ') {
    const approved = await gate('READ', ctx.mode, tool.name, tool.label, ctx.requestConfirmation);
    if (!approved) return 'The user declined, so this was not checked.';
  }
  return tool.run(input, ctx);
}
