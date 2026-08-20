import { describe, expect, it } from 'vitest';
import { isAppLoadTarget, isSafeExternalUrl, resolveAppLoadUrl } from './url';

describe('isSafeExternalUrl', () => {
  it('allows an https URL', () => {
    expect(isSafeExternalUrl('https://example.edu/stats')).toBe(true);
  });

  it('allows an http URL', () => {
    expect(isSafeExternalUrl('http://example.edu/stats')).toBe(true);
  });

  it('rejects a file: URL', () => {
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects a javascript: URL', () => {
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects a custom app-registered scheme', () => {
    expect(isSafeExternalUrl('smartlife-evil://payload')).toBe(false);
  });

  it('rejects a malformed URL without throwing', () => {
    expect(isSafeExternalUrl('not a url')).toBe(false);
  });
});

describe('resolveAppLoadUrl', () => {
  it('uses the dev server URL when set', () => {
    expect(resolveAppLoadUrl('http://localhost:5173', '/app/out/renderer/index.html')).toBe(
      'http://localhost:5173'
    );
  });

  it('falls back to a file:// URL for the packaged renderer', () => {
    const result = resolveAppLoadUrl(undefined, '/app/out/renderer/index.html');
    expect(result).toBe('file:///app/out/renderer/index.html');
  });
});

describe('isAppLoadTarget', () => {
  it('matches the exact app load URL', () => {
    expect(isAppLoadTarget('http://localhost:5173/', 'http://localhost:5173/')).toBe(true);
  });

  it('rejects any other destination, e.g. a link inside Canvas content', () => {
    expect(isAppLoadTarget('https://canvas.example.edu/courses/1', 'http://localhost:5173/')).toBe(false);
  });

  it('rejects a file:// destination that differs from the packaged app path', () => {
    expect(isAppLoadTarget('file:///etc/passwd', 'file:///app/out/renderer/index.html')).toBe(false);
  });
});
