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
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it('allows Canvas-hosted images in production', () => {
    expect(buildCsp(false)).toContain("img-src 'self' data: https://*.instructure.com");
  });

  it('allows Canvas-hosted images in development', () => {
    expect(buildCsp(true)).toContain("img-src 'self' data: https://*.instructure.com");
  });

  it('never relaxes script-src in production', () => {
    expect(buildCsp(false)).toContain("script-src 'self'");
    expect(buildCsp(false)).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});
