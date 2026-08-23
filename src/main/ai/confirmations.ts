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

export function requestConfirmation(
  send: (payload: { id: string; toolName: string; description: string }) => void,
  toolName: string,
  description: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<boolean> {
  const id = randomUUID();
  return new Promise((resolve) => {
    pending.set(id, { toolName, description, resolve });
    // An abandoned confirmation (window closed, overlay unmounted, renderer
    // reloaded) would otherwise park this promise in `pending` forever and
    // hang the AI turn awaiting it — treat a no-response as declined.
    timeouts.set(
      id,
      setTimeout(() => {
        timeouts.delete(id);
        if (pending.has(id)) resolveConfirmation(id, false);
      }, timeoutMs)
    );
    send({ id, toolName, description });
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
}

/** The single confirmation currently outstanding, if any -- lets a freshly
 *  mounted component (the AI dock reopened, or the badge hook that never
 *  unmounts) learn about one it did not see get requested. At most one is
 *  ever outstanding: the app has a single in-flight turn (chatController.ts's
 *  turnInFlight), and a turn can only be awaiting one tool call at a time. */
export function getPendingConfirmation(): PendingConfirmationInfo | null {
  const [id, entry] = [...pending.entries()][0] ?? [];
  if (id === undefined || entry === undefined) return null;
  return { id, toolName: entry.toolName, description: entry.description };
}
