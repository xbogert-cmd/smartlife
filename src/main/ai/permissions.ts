export type ToolTier = 'READ' | 'SAFE_WRITE' | 'CONSEQUENTIAL';
export type AiMode = 'ask' | 'assist' | 'auto';

const PAUSE_TIERS: Record<AiMode, ToolTier[]> = {
  ask: ['SAFE_WRITE', 'CONSEQUENTIAL'],
  assist: ['CONSEQUENTIAL'],
  auto: [],
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
