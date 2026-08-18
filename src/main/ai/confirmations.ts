import { randomUUID } from 'node:crypto';

type PendingResolver = (approved: boolean) => void;

const pending = new Map<string, PendingResolver>();

export function requestConfirmation(
  send: (payload: { id: string; toolName: string; description: string }) => void,
  toolName: string,
  description: string
): Promise<boolean> {
  const id = randomUUID();
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, toolName, description });
  });
}

export function resolveConfirmation(id: string, approved: boolean): void {
  const resolver = pending.get(id);
  if (!resolver) return;
  pending.delete(id);
  resolver(approved);
}
