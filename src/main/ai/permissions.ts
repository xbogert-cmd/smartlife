/**
 * ALWAYS_CONFIRM is for actions that are irreversible AND outward-facing --
 * the consequence leaves this machine and reaches another person or
 * institution. It is the one tier `auto` does not skip, and nothing may
 * escalate past it.
 *
 * `ask` is the most conservative mode: it pauses on every tier, including
 * READ, so even a lookup needs a nod first. `assist` drops READ from its
 * pause list -- it can look things up freely, but still confirms anything
 * that writes or changes state. `auto` only pauses on ALWAYS_CONFIRM.
 */
export type ToolTier = 'READ' | 'SAFE_WRITE' | 'CONSEQUENTIAL' | 'ALWAYS_CONFIRM';
export type AiMode = 'ask' | 'assist' | 'auto';

const PAUSE_TIERS: Record<AiMode, ToolTier[]> = {
  ask: ['READ', 'SAFE_WRITE', 'CONSEQUENTIAL', 'ALWAYS_CONFIRM'],
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
  requestConfirmation: (toolName: string, description: string, timeoutMs?: number) => Promise<boolean>,
  timeoutMs?: number
): Promise<boolean> {
  if (resolveExecutionMode(tier, mode) === 'auto') return true;
  return requestConfirmation(toolName, description, timeoutMs);
}
