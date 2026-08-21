import { describe, expect, it } from 'vitest';
import { resolveAddressInput, SEARCH_URL_PREFIX } from './address';

describe('resolveAddressInput', () => {
  it('passes through input that already has a scheme', () => {
    expect(resolveAddressInput('https://uncw.edu/registrar')).toBe('https://uncw.edu/registrar');
    expect(resolveAddressInput('http://example.com')).toBe('http://example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveAddressInput('   uncw.edu   ')).toBe('https://uncw.edu');
  });

  it('prefixes https:// for host-shaped input', () => {
    expect(resolveAddressInput('uncw.edu')).toBe('https://uncw.edu');
    expect(resolveAddressInput('canvas.uncw.edu/courses/123')).toBe('https://canvas.uncw.edu/courses/123');
    expect(resolveAddressInput('example.com/path?q=1#frag')).toBe('https://example.com/path?q=1#frag');
  });

  it('uses http:// for loopback hosts, which do not serve https', () => {
    expect(resolveAddressInput('localhost:5173')).toBe('http://localhost:5173');
    expect(resolveAddressInput('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  it('uses https:// for a non-loopback dotted-quad address', () => {
    expect(resolveAddressInput('192.168.1.10')).toBe('https://192.168.1.10');
  });

  it('searches for anything containing whitespace', () => {
    expect(resolveAddressInput('how do i cite mla')).toBe(`${SEARCH_URL_PREFIX}how%20do%20i%20cite%20mla`);
  });

  it('searches for a single word with no dot', () => {
    expect(resolveAddressInput('registrar')).toBe(`${SEARCH_URL_PREFIX}registrar`);
  });

  it('searches for bare decimal numbers rather than treating them as hosts', () => {
    expect(resolveAddressInput('3.5')).toBe(`${SEARCH_URL_PREFIX}3.5`);
    expect(resolveAddressInput('1.2.3')).toBe(`${SEARCH_URL_PREFIX}1.2.3`);
  });

  it('percent-encodes search characters that would otherwise break the query', () => {
    expect(resolveAddressInput('c++ & templates')).toBe(`${SEARCH_URL_PREFIX}c%2B%2B%20%26%20templates`);
  });

  it('returns about:blank for empty input', () => {
    expect(resolveAddressInput('')).toBe('about:blank');
    expect(resolveAddressInput('    ')).toBe('about:blank');
  });

  it('does not treat a trailing-dot host as a host', () => {
    expect(resolveAddressInput('example.')).toBe(`${SEARCH_URL_PREFIX}example.`);
  });

  it('searches for email-shaped input instead of navigating', () => {
    expect(resolveAddressInput('jane.doe@uncw.edu')).toBe(`${SEARCH_URL_PREFIX}jane.doe%40uncw.edu`);
    expect(resolveAddressInput('user@example.com')).toBe(`${SEARCH_URL_PREFIX}user%40example.com`);
  });
});
