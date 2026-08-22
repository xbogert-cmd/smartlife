import type { CanvasScheduler } from './scheduler';

/**
 * The AI tool needs the scheduler's exclusivity guard, but ToolContext carries
 * only the database. Same shape as Phase 5's browser hostRegistry: one live
 * instance, set at startup, read by tools that need it.
 */
let activeScheduler: CanvasScheduler | null = null;

export function setActiveCanvasScheduler(scheduler: CanvasScheduler | null): void {
  activeScheduler = scheduler;
}

export function getActiveCanvasScheduler(): CanvasScheduler | null {
  return activeScheduler;
}
