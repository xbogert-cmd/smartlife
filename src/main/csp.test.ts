import { describe, expect, it } from 'vitest';
import { buildCsp } from './csp';

describe('buildCsp', () => {
  it('allows eval and localhost websockets in dev, for Vite HMR', () => {
    const csp = buildCsp(true);
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(csp).toContain('connect-src \'self\' ws://localhost:*');
  });

  it('is strict in production — no eval, no inline scripts', () => {
    const csp = buildCsp(false);
    expect(csp).toBe("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'");
  });
});
