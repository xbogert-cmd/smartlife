import { randomUUID } from 'node:crypto';

interface PendingEntry {
  toolName: string;
  description: string;
  resolve: (approved: boolean) => void;
}

export interface PendingConfirmationInfo {
  id: string;
  toolName: string;
  description: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

const pending = new Map<string, PendingEntry>();
const timeouts = new Map<string, NodeJS.Timeout>();

// Registered once at IPC-registration time (mirrors the pattern used
// elsewhere in this codebase for main-to-renderer broadcasts the pure module
// itself has no window to reach on its own, e.g. ipc.ts's theme preference
// broadcaster). Covers both the explicit-response path and the timeout path
// uniformly, since both funnel through resolveConfirmation below.
let broadcastResolved: (id: string) => void = () => {};

export function setConfirmationBroadcaster(fn: (id: string) => void): void {
  broadcastResolved = fn;
}

interface QueuedRequest {
  send: (payload: { id: string; toolName: string; description: string }) => void;
  toolName: string;
  description: string;
  timeoutMs: number;
  resolve: (approved: boolean) => void;
}

// Queued, not dispatched immediately -- a tool round can call
// requestConfirmation more than once concurrently (two of the three AI
// providers run a round's tool calls in parallel), but the renderer only
// ever shows one confirmation at a time. Without this queue the second
// concurrent request silently overwrote the first in the renderer's single
// pending slot, orphaning it until its timeout auto-declined it. dispatchNext
// only ever sends the head of the queue, and resolveConfirmation advances the
// queue -- so at most one confirmation is ever actually shown to the user,
// and every later one's timeout clock only starts once it is actually shown.
const queue: QueuedRequest[] = [];
let dispatching = false;

function dispatchNext(): void {
  if (dispatching) return;
  const next = queue.shift();
  if (!next) return;
  dispatching = true;
  const id = randomUUID();
  pending.set(id, { toolName: next.toolName, description: next.description, resolve: next.resolve });
  timeouts.set(
    id,
    setTimeout(() => {
      timeouts.delete(id);
      if (pending.has(id)) resolveConfirmation(id, false);
    }, next.timeoutMs)
  );
  next.send({ id, toolName: next.toolName, description: next.description });
}

export function requestConfirmation(
  send: (payload: { id: string; toolName: string; description: string }) => void,
  toolName: string,
  description: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ send, toolName, description, timeoutMs, resolve });
    dispatchNext();
  });
}

export function resolveConfirmation(id: string, approved: boolean): void {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  const timeout = timeouts.get(id);
  if (timeout) {
    clearTimeout(timeout);
    timeouts.delete(id);
  }
  entry.resolve(approved);
  broadcastResolved(id);
  dispatching = false;
  dispatchNext();
}

/** The single confirmation currently outstanding, if any -- lets a freshly
 *  mounted component (the AI dock reopened, or the badge hook that never
 *  unmounts) learn about one it did not see get requested. At most one is
 *  ever outstanding to the renderer: dispatchNext above only ever sends the
 *  head of the internal queue, so a second concurrent requestConfirmation
 *  call waits in `queue` rather than reaching the renderer until the first
 *  resolves. */
export function getPendingConfirmation(): PendingConfirmationInfo | null {
  const [id, entry] = [...pending.entries()][0] ?? [];
  if (id === undefined || entry === undefined) return null;
  return { id, toolName: entry.toolName, description: entry.description };
}
