import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testLogDir = join(tmpdir(), `smartlife-log-test-${Date.now()}`);

vi.mock('electron', () => ({
  app: { getPath: () => testLogDir },
}));

afterEach(() => {
  rmSync(testLogDir, { recursive: true, force: true });
});

describe('logError', () => {
  it('appends a timestamped entry to smartlife.log', async () => {
    const { logError, getLogPath } = await import('./log');
    logError('startup', new Error('boom'));

    const logPath = getLogPath();
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, 'utf8');
    expect(content).toContain('startup');
    expect(content).toContain('boom');
  });
});
