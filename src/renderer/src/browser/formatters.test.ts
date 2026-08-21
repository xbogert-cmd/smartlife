import { describe, expect, it } from 'vitest';
import { formatBytes } from './formatters';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1048576, '1.0 MB'],
    [52428800, '50.0 MB'],
    [1073741824, '1.0 GB'],
  ])('%i -> %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it('says so when the size is unknown', () => {
    // Electron reports 0 total bytes for a chunked response with no
    // Content-Length. Rendering that as "0 B" would be a lie.
    expect(formatBytes(-1)).toBe('unknown size');
  });
});
