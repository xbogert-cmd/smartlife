import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function getLogPath(): string {
  return join(app.getPath('logs'), 'smartlife.log');
}

export function logError(context: string, error: unknown): void {
  const logPath = getLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  const message = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  appendFileSync(logPath, `[${new Date().toISOString()}] ${context}: ${message}\n`);
}
