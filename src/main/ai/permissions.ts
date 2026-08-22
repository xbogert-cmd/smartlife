/**
 * ALWAYS_CONFIRM is for actions that are irreversible AND outward-facing —
 * the consequence leaves this machine and reaches another person or
 * institution. It is the one tier `auto` does not skip, and nothing may
 * escalate past it.
 */
export type ToolTier = 'READ' | 'SAFE_WRITE' | 'CONSEQUENTIAL' | 'ALWAYS_CONFIRM';
export type AiMode = 'ask' | 'assist' | 'auto';

const PAUSE_TIERS: Record<AiMode, ToolTier[]> = {
  ask: ['SAFE_WRITE', 'CONSEQUENTIAL', 'ALWAYS_CONFIRM'],
  assist: ['SAFE_WRITE', 'CONSEQUENTIAL', 'ALWAYS_CONFIRM'],
  auto: ['ALWAYS_CONFIRM'],
};

export function resolveExecutionMode(tier: ToolTier, mode: AiMode): 'auto' | 'pause' {
  return PAUSE_TIERS[mode].includes(tier) ? 'pause' : 'auto';
}

export async function gate(
  tier: ToolTier,
  mode: AiMode,
  toolName: string,
  description: string,
  requestConfirmation: (toolName: string, description: string) => Promise<boolean>
): Promise<boolean> {
  if (resolveExecutionMode(tier, mode) === 'auto') return true;
  return requestConfirmation(toolName, description);
}
