import { randomUUID } from 'node:crypto';

type PendingResolver = (approved: boolean) => void;

const CONFIRMATION_TIMEOUT_MS = 120_000;

const pending = new Map<string, PendingResolver>();
const timeouts = new Map<string, NodeJS.Timeout>();

export function requestConfirmation(
  send: (payload: { id: string; toolName: string; description: string }) => void,
  toolName: string,
  description: string
): Promise<boolean> {
  const id = randomUUID();
  return new Promise((resolve) => {
    pending.set(id, resolve);
    // An abandoned confirmation (window closed, overlay unmounted, renderer
    // reloaded) would otherwise park this promise in `pending` forever and
    // hang the AI turn awaiting it — treat a no-response as declined.
    timeouts.set(
      id,
      setTimeout(() => {
        timeouts.delete(id);
        if (pending.delete(id)) resolve(false);
      }, CONFIRMATION_TIMEOUT_MS)
    );
    send({ id, toolName, description });
  });
}

export function resolveConfirmation(id: string, approved: boolean): void {
  const resolver = pending.get(id);
  if (!resolver) return;
  pending.delete(id);
  const timeout = timeouts.get(id);
  if (timeout) {
    clearTimeout(timeout);
    timeouts.delete(id);
  }
  resolver(approved);
}
